#!/usr/bin/env python3
"""Validate the final zip through real extraction and an offline synthetic lifecycle."""
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import zipfile

PROBE = r'''
import asyncio, hashlib, json, logging, sys
from pathlib import Path
from unittest.mock import AsyncMock
plugin=Path(sys.argv[1]); sys.path.insert(0,str(plugin/'py_modules'))
from optiscaler import constants, fsr4build, gameprofiles, installer, live, restorepoint, wiki
from optiscaler.service import OptiScalerService
from optiscaler.inifile import IniFile
root=plugin.parent
def reject_network(*args, **kwargs):
 raise AssertionError('Offline lifecycle attempted a download')
wiki.download=reject_network
for build in constants.FSR4_BUILDS:
 assert (plugin/'bin'/build['sources'][0]['asset']).is_file(), 'Missing offline community archive'
service=OptiScalerService(plugin,root/'settings',root/'runtime',root/'home',logging.getLogger('zip-verification'))
service.get_recommendation=AsyncMock(return_value=gameprofiles.recommendation({'matched':False},'Phantom Blade Zero'))
service.refresh_wiki_if_stale=lambda:None
service.refresh_page_if_stale=lambda page:None

def files(target):
 return {str(p.relative_to(target)):p.read_bytes() for p in target.rglob('*') if p.is_file() and restorepoint.RESTORE_DIR not in p.parts}

async def verify():
 payload_root=Path(await service.ensure_payload())
 provenance=json.loads((plugin/'defaults/runtime-manifest.json').read_text())
 assert constants.OPTISCALER_VERSION == '0.9.5' and provenance['experimental'] is False
 for name,expected in provenance['files'].items():
  data=(payload_root/name).read_bytes()
  assert len(data)==expected['bytes'] and hashlib.sha256(data).hexdigest()==expected['sha256'],name
 assert fsr4build.identify(payload_root/constants.FFX_UPSCALER_DLL)['id']=='bundled'
 assert installer.pe_file_version(payload_root/constants.FFX_UPSCALER_DLL)[:3]==(4,1,2)
 assert (payload_root/'amd_fidelityfx_upscaler_vk.dll').is_file()
 game=root/'PBZ';target=game/'platform/steam';target.mkdir(parents=True)
 (target/'PBZ.exe').write_bytes(b'MZ synthetic game executable')
 (target/'dxgi.dll').write_bytes(b'original game proxy')
 (target/'OptiScaler.ini').write_bytes(b'; original comments\r\n[FSR]\r\nFsr4ForceEnableInt8=true\r\n[FrameGen]\r\nEnabled=true\r\n')
 (target/'user.txt').write_bytes(b'unrelated user file')
 original=files(target)
 options='LSFG=1 gamescope -- %command% -my-argument'
 installed=await service.auto_install(str(target),str(game),'Phantom Blade Zero',None,options)
 assert installed['ok'],installed
 assert installer.runtime_current(target)
 assert IniFile(target/'OptiScaler.ini').get('FSR','Fsr4ForceEnableInt8')=='1'
 prior=files(target)
 point=await service.create_restore_point(str(target),str(game),options)
 assert point['ok'] and point['available'],point
 experiment=await service.setup_deck_experiment(str(target),str(game))
 assert experiment['ok'],experiment
 ini=IniFile(target/'OptiScaler.ini')
 assert ini.get('FrameGen','Enabled')=='false'
 assert ini.get('FrameGen','FGInput')==ini.get('FrameGen','FGOutput')=='nofg'
 assert ini.get('FSR','Fsr4ForceEnableInt8')=='1'
 assert fsr4build.identify(target/constants.FFX_UPSCALER_DLL)['id']=='4.1.2-lite-exact-20261105'
 assert ini.get('FSR','Fsr4Update')=='true'
 assert installer.pe_file_version(target/constants.FFX_UPSCALER_DLL)[:3]==(4,1,1)
 # A stock restore point must not prevent direct fallback to the older build.
 framegen={key:ini.get('FrameGen',key) for key in ['Enabled','FGInput','FGOutput']}
 legacy=await service.set_fsr4_build(str(target),'4.1.1b');assert legacy['ok'],legacy
 assert fsr4build.identify(target/constants.FFX_UPSCALER_DLL)['id']=='4.1.1b'
 assert {key:IniFile(target/'OptiScaler.ini').get('FrameGen',key) for key in framegen}==framegen
 modern=await service.set_fsr4_build(str(target),'4.1.2-lite-exact-20261105');assert modern['ok'],modern
 reapplied=await service.apply_auto_settings(str(target),str(game),'Phantom Blade Zero')
 assert reapplied['ok'],reapplied
 assert IniFile(target/'OptiScaler.ini').get('FrameGen','FGInput')=='nofg'
 assert not (await service.get_live_status(str(target)))['attached']
 bridge=target/'plugins/decky_optiscaler_live.asi'
 assert bridge.is_file() and installer.read_manifest(target).get('live_asi') is True
 build=json.loads((plugin/'defaults/live-build.json').read_text())
 assert hashlib.sha256(bridge.read_bytes()).hexdigest()==build['sha256']
 assert not (await service.get_live_status(str(target)))['ready']
 deferred=await service.write_config(str(target),[{'section':'Menu','key':'ShowFps','value':'true'}])
 assert deferred['ok'] and not deferred['live'].get('confirmed') and not deferred['live'].get('sent'),deferred
 assert not (target/live.CMD_FILE).exists(),'no command may be sent without a native session'
 stock=await service.restore_fsr4_build(str(target));assert stock['ok'],stock
 assert fsr4build.identify(target/constants.FFX_UPSCALER_DLL)['id']=='bundled'
 rolled=await service.rollback_install(str(target),str(game));assert rolled['ok'],rolled
 assert rolled['launch_options']==options
 assert files(target)==prior,'rollback bytes differ'
 removed=await service.uninstall(str(target));assert removed['ok'],removed
 assert files(target)==original,'Remove did not restore original bytes'
 assert not (target/restorepoint.RESTORE_DIR).exists()
 assert service.settings.snapshot_game(str(game))=={'target':None,'auto':None,'experiment':None}
 print(json.dumps({'ok':True,'runtime':constants.OPTISCALER_VERSION,'inventory_files':len(provenance['files']),
  'community':'4.1.2 Lite Exact + legacy 4.1.1b archive and DLL hashes verified','lifecycle':'install/experiment/reapply/stock restore/rollback/Remove',
  'network':'not used','real_game_gpu':'not tested'}))
asyncio.run(verify())
'''


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: verify_package.py <Decky zip>')
    archive = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='decky-final-zip-') as tmp:
        root = Path(tmp)
        with zipfile.ZipFile(archive) as zf:
            names = zf.namelist()
            for name in names:
                parts = PurePosixPath(name).parts
                if not parts or parts[0] != 'Decky OptiScaler' or '..' in parts or PurePosixPath(name).is_absolute():
                    raise ValueError(f'Unsafe zip entry: {name}')
            required = {'Decky OptiScaler/bin/decky_optiscaler_live.asi',
                        'Decky OptiScaler/defaults/live-profile.json',
                        'Decky OptiScaler/defaults/live-build.json'}
            if not required.issubset(names):
                raise AssertionError('Native bridge or its identity metadata is missing')
            build = json.loads(zf.read('Decky OptiScaler/defaults/live-build.json'))
            profile = json.loads(zf.read('Decky OptiScaler/defaults/live-profile.json'))
            import hashlib
            if hashlib.sha256(zf.read('Decky OptiScaler/bin/decky_optiscaler_live.asi')).hexdigest() != build['sha256']:
                raise AssertionError('Packaged bridge hash does not match its identity metadata')
            if (build['schema'], build['build_id'], build['profile_id'], build['core_sha256']) != (
                    profile['schema'], profile['build_id'], profile['profile_id'], profile['core_sha256']):
                raise AssertionError('Packaged bridge profile does not match its identity metadata')
            zf.extractall(root)
        subprocess.run([sys.executable, '-c', PROBE, str(root/'Decky OptiScaler')], check=True)
    print('Final zip offline lifecycle: PASS')


if __name__ == '__main__':
    main()
