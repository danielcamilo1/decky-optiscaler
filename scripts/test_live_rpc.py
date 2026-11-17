#!/usr/bin/env python3
"""Exercise the real Decky entry points with a file-based native protocol peer.

This validates RPC forwarding, persistence and acknowledgements, not GPU effects.
Native tests cover ABI and request handling; real game checks are recorded separately.
"""
import asyncio
import importlib.util
import logging
import json
import shutil
import subprocess
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

from test_live import LiveFixture, filesystem_state
from optiscaler import installer, live
from optiscaler.inifile import IniFile
from optiscaler.service import OptiScalerService

ROOT = Path(__file__).resolve().parent.parent


def entry_class():
    spec = importlib.util.spec_from_file_location("decky_live_rpc_under_test", ROOT / "main.py")
    module = importlib.util.module_from_spec(spec)
    # Decky's transport owns this module in production. Only its import is
    # substituted; Plugin's real method bodies and the real service run below.
    with patch.dict(sys.modules, {"decky": types.ModuleType("decky")}):
        spec.loader.exec_module(module)
    return module.Plugin


class LiveRpcTests(LiveFixture):
    def setUp(self):
        super().setUp()
        # Internal stop-game checks locate live metadata from the installed
        # package. Relocate that filesystem root with this fixture; keep the
        # real status parser and guard rather than mocking their decisions.
        root_patch = patch.object(live, "_plugin_root", return_value=self.plugin_root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        self.service = OptiScalerService(
            self.plugin_root, self.root / "settings", self.root / "runtime",
            self.root / "home", logging.getLogger("live-rpc-test"),
        )
        self.plugin = entry_class()()
        self.plugin.service = self.service

    def tearDown(self):
        # Stop the protocol writer before the fixture deletes its directory.
        self.doCleanups()
        super().tearDown()

    def test_running_game_saves_ini_and_confirms_through_real_rpc(self):
        peer = self.emulator()
        before_mode = self.ini.stat().st_mode & 0o7777
        change = {"section": "Sharpness", "key": "Sharpness", "value": "0.35"}
        result = asyncio.run(self.plugin.write_config(
            str(self.target), [change], True, peer.context(),
        ))
        self.assertTrue(result["ok"], result)
        self.assertEqual(IniFile(self.ini).get("Sharpness", "Sharpness"), "0.35")
        self.assertEqual(self.ini.stat().st_mode & 0o7777, before_mode)
        self.assertTrue(result["live"]["sent"], result)
        self.assertTrue(result["live"]["confirmed"], result)
        self.assertIsInstance(result["live"]["seq"], str)
        self.assertEqual(result["live"]["sent_keys"], ["Sharpness.Sharpness"])
        self.assertEqual(result["live"]["context"], {**peer.context(), "target": str(self.target.resolve())})

    def test_rpc_push_false_saves_without_sending_a_native_command(self):
        peer = self.emulator()
        result = asyncio.run(self.plugin.write_config(str(self.target), [
            {"section": "Menu", "key": "ShowFps", "value": "true"},
        ], False, peer.context()))
        self.assertTrue(result["ok"], result)
        self.assertEqual(IniFile(self.ini).get("Menu", "ShowFps"), "true")
        self.assertFalse(result["live"].get("sent"), result)
        self.assertEqual(result["live"].get("sent_keys", []), [])
        self.assertFalse((self.target / live.CMD_FILE).exists())

    def test_two_argument_config_rpc_keeps_its_default_live_behavior(self):
        self.emulator()
        result = asyncio.run(self.plugin.write_config(str(self.target), [
            {"section": "Menu", "key": "ShowFps", "value": "true"},
        ]))
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["live"]["confirmed"], result)

    def test_backend_rpc_forwards_the_selection_context(self):
        peer = self.emulator()
        result = asyncio.run(self.plugin.switch_upscaler(
            str(self.target), "xess", peer.context(),
        ))
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["live"]["confirmed"], result)
        self.assertEqual(result["live"]["sent_keys"], ["Upscalers.Dx12Upscaler"])
        self.assertEqual(result["live"]["context"], {**peer.context(), "target": str(self.target.resolve())})
        command = (self.target / live.CMD_FILE).read_text()
        self.assertIn("api dx12\n", command)
        self.assertIn("backend xess\n", command)

    def test_binary_install_and_remove_still_refuse_a_running_game(self):
        self.emulator()
        manifest = installer.read_manifest(self.target)
        names = set(manifest["files"]) - set(live.CONTROL_FILES)
        before = {name: (self.target / name).read_bytes() for name in names
                  if (self.target / name).is_file()}
        installed = asyncio.run(self.plugin.install_live(str(self.target)))
        self.assertFalse(installed["ok"], installed)
        removed = asyncio.run(self.plugin.uninstall(str(self.target)))
        self.assertFalse(removed["ok"], removed)
        self.assertEqual(before, {name: (self.target / name).read_bytes() for name in before})


    def test_config_rpc_commit_marker_failure_restores_before_sending(self):
        self.emulator()
        before_ini = self.ini.read_bytes()
        manifest = self.target / installer.MANIFEST_NAME
        before_manifest = manifest.read_bytes()
        persist = installer._persist_transaction
        failed = False

        def fail_first_commit(state, target, status="active"):
            nonlocal failed
            if status == "committed" and not failed:
                failed = True
                raise OSError("injected commit marker failure")
            return persist(state, target, status)

        with patch.object(installer, "_persist_transaction", side_effect=fail_first_commit):
            result = asyncio.run(self.plugin.write_config(str(self.target), [
                {"section": "Menu", "key": "ShowFps", "value": "true"},
            ]))
        self.assertTrue(failed)
        self.assertFalse(result["ok"], result)
        self.assertEqual(self.ini.read_bytes(), before_ini)
        self.assertEqual(manifest.read_bytes(), before_manifest)
        self.assertFalse((self.target / live.CMD_FILE).exists())
        self.assertFalse(list(self.target.glob(installer.TRANSACTION_PREFIX + "*")))

    def test_config_rpc_committed_cleanup_failure_keeps_saved_value_and_live_ack(self):
        self.emulator()
        with patch.object(installer, "_retire_transaction", side_effect=OSError("cleanup busy")):
            result = asyncio.run(self.plugin.write_config(str(self.target), [
                {"section": "Menu", "key": "ShowFps", "value": "true"},
            ]))
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["live"]["confirmed"], result)
        self.assertEqual(IniFile(self.ini).get("Menu", "ShowFps"), "true")
        committed = list(self.target.glob(installer.TRANSACTION_PREFIX + "*"))
        self.assertEqual(len(committed), 1)
        record = json.loads((committed[0] / installer.TRANSACTION_RECORD).read_text())
        self.assertEqual(record["status"], "committed")
        before = self.ini.read_bytes()
        installer.recover_target_transactions(self.target)
        self.assertEqual(self.ini.read_bytes(), before)
        self.assertFalse(list(self.target.glob(installer.TRANSACTION_PREFIX + "*")))

    def test_config_rpc_rejects_forged_managed_ini_binary_or_directory_before_any_write(self):
        for extra in ("dxgi.dll", live.PLUGIN_SUBDIR):
            with self.subTest(extra=extra):
                journal = self.target / (installer.TRANSACTION_PREFIX + "forged")
                entries = journal / "entries"
                entries.mkdir(parents=True)
                records = []
                for index, name in enumerate((installer.INI_NAME, installer.MANIFEST_NAME, extra)):
                    source = self.target / name
                    stored = f"{index:06d}"
                    directory = source.is_dir()
                    if not directory:
                        shutil.copy2(source, entries / stored)
                    records.append({
                        "name": name, "exists": True,
                        "stored": None if directory else stored,
                        "kind": "shared_dir" if directory else "file",
                        **({"mode": source.stat().st_mode & 0o7777} if directory else {}),
                    })
                (journal / installer.TRANSACTION_RECORD).write_text(json.dumps({
                    "version": installer.TRANSACTION_VERSION,
                    "target": str(self.target.resolve()), "status": "active",
                    "require_stopped": False, "intent": installer.TRANSACTION_INTENT_MANAGED_INI,
                    "records": records,
                }))
                self.ini.write_text("[General]\nKeep=after-crash\n")
                before = filesystem_state(self.target)
                result = asyncio.run(self.plugin.write_config(str(self.target), [
                    {"section": "Menu", "key": "ShowFps", "value": "true"},
                ]))
                self.assertFalse(result["ok"], result)
                self.assertIn("managed INI", result.get("error", ""))
                self.assertEqual(filesystem_state(self.target), before)
                self.assertFalse((self.target / live.CMD_FILE).exists())
                shutil.rmtree(journal)

    def test_launch_record_rpc_hard_exit_before_and_after_publish_restores_without_orphans(self):
        code = r"""import asyncio,sys,logging,os
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from test_live_rpc import entry_class
from optiscaler import installer, constants, live
from optiscaler.service import OptiScalerService
plugin_root=Path(sys.argv[2]); target=Path(sys.argv[3]); phase=sys.argv[5]
constants.RUNTIME_DLL_SHA256=sys.argv[4]
live._plugin_root=lambda:plugin_root
service=OptiScalerService(plugin_root,plugin_root.parent/'launch-settings',
 plugin_root.parent/'launch-runtime',plugin_root.parent/'launch-home',logging.getLogger('launch-rpc-crash'))
plugin=entry_class()();plugin.service=service
original=os.link
def interrupt(source,destination):
 destination=Path(destination)
 if destination.parent.resolve()==target.resolve() and destination.name==constants.LAUNCH_RECORD_NAME:
  if phase=='before':os._exit(74)
  original(source,destination)
  os._exit(74)
 return original(source,destination)
os.link=interrupt
asyncio.run(plugin.record_launch_options(str(target),'LSFG=1 %command% -synthetic-test'))
"""
        for phase in ("before", "after"):
            with self.subTest(phase=phase):
                before = filesystem_state(self.target)
                result = subprocess.run([
                    sys.executable, "-c", code, str(ROOT / "scripts"), str(self.plugin_root),
                    str(self.target), self.runtime_hash, phase,
                ], capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 74, result.stderr)
                installer.recover_target_transactions(self.target)
                self.assertEqual(filesystem_state(self.target), before)
                self.assertFalse(list(self.target.glob(".decky-launch-options-*")))
                self.assertFalse(list(self.target.glob(installer.TRANSACTION_PREFIX + "*")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
