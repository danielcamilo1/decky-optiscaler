#!/usr/bin/env python3
"""Offline integration tests for the Deck preset's DLL/settings lifecycle."""
import asyncio
import concurrent.futures
import hashlib
import logging
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'py_modules'))
from optiscaler import constants, installer, fsr4build
from optiscaler.constants import FFX_UPSCALER_DLL, INI_NAME, MANIFEST_NAME
from optiscaler.inifile import IniFile
from optiscaler.service import OptiScalerService

ROOT = Path(__file__).resolve().parents[1]


class BuildFetchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        fsr4build._digests.clear()
        self.dll_bytes = b'verified community DLL'
        self.build = dict(fsr4build.find('4.1.1b'),
                          file_bytes=len(self.dll_bytes),
                          file_sha256=hashlib.sha256(self.dll_bytes).hexdigest())
        self.build['sources'] = [dict(source, archive_sha256=hashlib.sha256(
            source['repo'].encode()).hexdigest()) for source in self.build['sources']]

    def download(self, url, archive, **kwargs):
        source = next(s for s in self.build['sources'] if fsr4build.url_for(s) == url)
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_bytes(source['repo'].encode())

    def extract(self, archive, target, logger=None):
        target.mkdir(parents=True, exist_ok=True)
        (target / self.build['file']).write_bytes(self.dll_bytes)

    def test_two_files_remain_cached_and_changes_are_rehashed(self):
        paths = [self.root / name for name in ('game.dll', 'cached.dll')]
        for path in paths:
            path.write_bytes(self.dll_bytes)
        with patch.object(fsr4build.payload, 'sha256', wraps=fsr4build.payload.sha256) as sha:
            for _ in range(3):
                for path in paths:
                    fsr4build.digest(path)
            self.assertEqual(sha.call_count, 2)
            paths[0].write_bytes(b'changed DLL')
            self.assertNotEqual(fsr4build.digest(paths[0]), self.build['file_sha256'])
            self.assertEqual(sha.call_count, 3)
            for i in range(10):
                path = self.root / str(i)
                path.write_bytes(b'other DLL')
                fsr4build.digest(path)
            self.assertLessEqual(len(fsr4build._digests), 8)

    def test_identification_skips_unknown_sizes_but_checks_known_sizes(self):
        path = self.root / 'game.dll'
        path.write_bytes(b'unknown size')
        with patch.object(fsr4build, 'FSR4_BUILDS', [self.build]), \
                patch.object(fsr4build.payload, 'sha256', wraps=fsr4build.payload.sha256) as sha:
            self.assertFalse(fsr4build.identify(path)['known'])
            sha.assert_not_called()
            path.write_bytes(self.dll_bytes)
            self.assertEqual(fsr4build.identify(path)['id'], self.build['id'])
            path.write_bytes(b'x' * len(self.dll_bytes))
            self.assertFalse(fsr4build.identify(path)['known'])

    def test_primary_failure_uses_mirror_and_reuses_verified_cache(self):
        def download(url, archive, **kwargs):
            if url == fsr4build.url_for(self.build['sources'][0]):
                raise OSError('release deleted')
            self.download(url, archive, **kwargs)
        with patch.object(fsr4build.wiki, 'download', side_effect=download) as get, \
                patch.object(fsr4build.payload, 'extract_archive', side_effect=self.extract):
            path = fsr4build.fetch(self.build, self.root)
            self.assertEqual(path.read_bytes(), self.dll_bytes)
            self.assertEqual(get.call_count, 2)
            self.assertEqual(fsr4build.fetch(self.build, self.root), path)
            self.assertEqual(get.call_count, 2)

    def test_corrupt_primary_archive_falls_back(self):
        def download(url, archive, **kwargs):
            self.download(url, archive, **kwargs)
            if url == fsr4build.url_for(self.build['sources'][0]):
                archive.write_bytes(b'corrupt archive')
        with patch.object(fsr4build.wiki, 'download', side_effect=download), \
                patch.object(fsr4build.payload, 'extract_archive', side_effect=self.extract) as extract:
            self.assertEqual(fsr4build.fetch(self.build, self.root).read_bytes(), self.dll_bytes)
            self.assertEqual(extract.call_count, 1)

    def test_wrong_dll_from_either_source_is_rejected(self):
        def extract(archive, target, logger=None):
            self.extract(archive, target, logger)
            (target / self.build['file']).write_bytes(b'x' * len(self.dll_bytes))
        with patch.object(fsr4build.wiki, 'download', side_effect=self.download) as get, \
                patch.object(fsr4build.payload, 'extract_archive', side_effect=extract):
            with self.assertRaisesRegex(RuntimeError, 'DLL checksum mismatch'):
                fsr4build.fetch(self.build, self.root)
            self.assertEqual(get.call_count, 2)
            self.assertFalse(fsr4build.cached_path(self.root, self.build).exists())

    def test_failed_extraction_cannot_leave_a_dll_for_the_mirror(self):
        attempts = 0
        def extract(archive, target, logger=None):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                self.extract(archive, target, logger)
                raise RuntimeError('incomplete extraction')
            target.mkdir(parents=True, exist_ok=True)
        with patch.object(fsr4build.wiki, 'download', side_effect=self.download), \
                patch.object(fsr4build.payload, 'extract_archive', side_effect=extract):
            with self.assertRaisesRegex(RuntimeError, 'did not contain'):
                fsr4build.fetch(self.build, self.root)

    def test_exact_variant_is_selected_when_archive_has_multiple_same_name_dlls(self):
        self.build['archive_path'] = '4.1.2l-exact/' + self.build['file']
        def extract(archive, target, logger=None):
            for directory, data in [('lossy', b'wrong lossy DLL'), ('exact', b'wrong full model'),
                                    ('4.1.2l-exact', self.dll_bytes)]:
                folder = target / directory
                folder.mkdir(parents=True, exist_ok=True)
                (folder / self.build['file']).write_bytes(data)
        with patch.object(fsr4build.wiki, 'download', side_effect=self.download), \
                patch.object(fsr4build.payload, 'extract_archive', side_effect=extract):
            selected = fsr4build.fetch(self.build, self.root)
        self.assertEqual(selected.read_bytes(), self.dll_bytes)

    def test_missing_exact_variant_never_falls_back_to_another_same_name_dll(self):
        self.build['archive_path'] = '4.1.2l-exact/' + self.build['file']
        def extract(archive, target, logger=None):
            folder = target / 'lossy'
            folder.mkdir(parents=True, exist_ok=True)
            # Even matching bytes under another path do not satisfy this pin.
            (folder / self.build['file']).write_bytes(self.dll_bytes)
        with patch.object(fsr4build.wiki, 'download', side_effect=self.download), \
                patch.object(fsr4build.payload, 'extract_archive', side_effect=extract):
            with self.assertRaisesRegex(RuntimeError, 'pinned'):
                fsr4build.fetch(self.build, self.root)
        self.assertFalse(fsr4build.cached_path(self.root, self.build).exists())

    def test_concurrent_fetch_for_same_build_is_serialized_and_atomic(self):
        active = 0
        max_active = 0
        guard = threading.Lock()
        barrier = threading.Barrier(4)

        def slow_extract(archive, target, logger=None):
            nonlocal active, max_active
            with guard:
                active += 1
                max_active = max(max_active, active)
            try:
                time.sleep(0.05)
                self.extract(archive, target, logger)
            finally:
                with guard:
                    active -= 1

        def worker():
            barrier.wait(timeout=5)
            return fsr4build.fetch(self.build, self.root)

        with patch.object(fsr4build.wiki, 'download', side_effect=self.download) as get, \
                patch.object(fsr4build.payload, 'extract_archive', side_effect=slow_extract) as extract:
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                paths = list(pool.map(lambda _: worker(), range(4)))

        self.assertEqual(max_active, 1)
        self.assertEqual(get.call_count, 1)
        self.assertEqual(extract.call_count, 1)
        expected = fsr4build.cached_path(self.root, self.build)
        self.assertEqual(paths, [expected] * 4)
        self.assertEqual(expected.read_bytes(), self.dll_bytes)


class DeckFsr4Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._shared_temp = tempfile.TemporaryDirectory(prefix='decky-fsr4-payload-')
        cls._shared_runtime = Path(cls._shared_temp.name) / 'runtime'
        bootstrap = OptiScalerService(ROOT, Path(cls._shared_temp.name) / 'settings',
                                      cls._shared_runtime, Path(cls._shared_temp.name) / 'home',
                                      logging.getLogger('test'))
        cls._shared_payload = asyncio.run(bootstrap.ensure_payload())

    @classmethod
    def tearDownClass(cls):
        cls._shared_temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.service = OptiScalerService(ROOT, self.root/'settings', self._shared_runtime,
                                        self.root/'home', logging.getLogger('test'))
        self.payload = self._shared_payload
        self.target = self.root/'game'
        self.target.mkdir()
        (self.target/FFX_UPSCALER_DLL).write_bytes(b'original game DLL')
        installer.install(self.target, self.payload)
        ini = IniFile(self.target/INI_NAME)
        ini.set('FrameGen', 'FGOutput', 'fsr3')
        ini.save()
        point = asyncio.run(self.service.create_restore_point(str(self.target), str(self.target), ''))
        self.assertTrue(point['ok'], point)
        self.dll = self.root/'community.dll'
        self.dll.write_bytes(b'test community DLL')
        self.build = dict(fsr4build.find('4.1.1b'),
                          file_sha256=hashlib.sha256(self.dll.read_bytes()).hexdigest(),
                          file_bytes=self.dll.stat().st_size)
        mock = patch.object(fsr4build, 'FSR4_BUILDS', [self.build])
        mock.start()
        self.addCleanup(mock.stop)

    def enable(self):
        with patch.object(fsr4build, 'fetch', return_value=self.dll):
            return asyncio.run(self.service.set_fsr4_build(str(self.target), '4.1.1b'))

    def snapshot(self):
        return {name: (self.target/name).read_bytes()
                for name in [FFX_UPSCALER_DLL, INI_NAME, MANIFEST_NAME]}

    def test_unowned_payload_dir_file_does_not_mark_healthy_runtime_corrupt(self):
        user = self.target / 'D3D12_Optiscaler/user-added.txt'
        user.write_bytes(b'user file')
        result = installer.verify_install(self.target, self.payload)
        self.assertTrue(result['complete'], result)
        self.assertEqual(user.read_bytes(), b'user file')
        self.assertFalse((self.target / 'Licenses').exists())

    def test_game_with_lowercase_licenses_dir_installs_and_verifies_complete(self):
        game = self.root / 'trails-game'
        game.mkdir()
        (game / 'licenses').mkdir()
        (game / 'licenses' / 'zlib_license.txt').write_bytes(b'game zlib license')
        installer.install(game, self.payload)
        result = installer.verify_install(game, self.payload)
        self.assertTrue(result['complete'], result)
        self.assertEqual((game / 'licenses' / 'zlib_license.txt').read_bytes(), b'game zlib license')
        installer.uninstall(game)
        self.assertEqual((game / 'licenses' / 'zlib_license.txt').read_bytes(), b'game zlib license')

    def test_enable_verify_reinstall_restore_uninstall(self):
        self.assertTrue(self.enable()['ok'])
        config = asyncio.run(self.service.read_config(str(self.target)))
        self.assertEqual(config['fsr4_build'], '4.1.1b')
        self.assertEqual(config['values']['FSR']['Fsr4ForceEnableInt8'], '1')
        self.assertEqual(config['values']['FSR']['Fsr4Update'], 'auto')
        self.assertEqual(config['values']['FSR']['UpscalerIndex'], '0')
        self.assertEqual(config['values']['FrameGen']['FGOutput'], 'fsr3')
        self.assertTrue(installer.verify_install(self.target, self.payload)['complete'])
        installer.install(self.target, self.payload)
        self.assertEqual((self.target/FFX_UPSCALER_DLL).read_bytes(), self.dll.read_bytes())
        self.assertEqual(installer.read_manifest(self.target)['fsr4_build']['id'], '4.1.1b')
        installer.restore_fsr4_build(self.target, self.payload)
        self.assertEqual(fsr4build.identify(self.target/FFX_UPSCALER_DLL)['id'], 'bundled')
        self.assertTrue(installer.verify_install(self.target, self.payload)['complete'])
        self.assertTrue(self.enable()['ok'])
        installer.uninstall(self.target)
        self.assertEqual((self.target/FFX_UPSCALER_DLL).read_bytes(), b'original game DLL')

    def test_other_registered_build_is_accepted_and_unknown_is_rejected(self):
        self.build['id'] = 'future-build'
        with patch.object(fsr4build, 'fetch', return_value=self.dll) as fetch:
            result = asyncio.run(self.service.set_fsr4_build(str(self.target), 'future-build'))
            self.assertTrue(result['ok'])
            fetch.reset_mock()
            result = asyncio.run(self.service.set_fsr4_build(str(self.target), 'unknown'))
            self.assertFalse(result['ok'])
            fetch.assert_not_called()

    def test_invalid_preset_rolls_back_settings_and_dll(self):
        before = self.snapshot()
        with patch.object(installer.schema, 'valid', return_value=False):
            self.assertFalse(self.enable()['ok'])
        self.assertEqual(before, self.snapshot())

    def test_download_failure_preserves_settings_and_dll(self):
        before = self.snapshot()
        with patch.object(fsr4build, 'fetch', side_effect=ValueError('checksum mismatch')):
            result = asyncio.run(self.service.set_fsr4_build(str(self.target), '4.1.1b'))
        self.assertFalse(result['ok'])
        self.assertEqual(before, self.snapshot())

    def test_same_size_corruption_fails_verification_and_reinstall(self):
        self.assertTrue(self.enable()['ok'])
        (self.target/FFX_UPSCALER_DLL).write_bytes(b'x'*self.build['file_bytes'])
        self.assertIn(FFX_UPSCALER_DLL, installer.verify_install(self.target, self.payload)['problems'])
        before = self.snapshot()
        with self.assertRaises(ValueError):
            installer.install(self.target, self.payload)
        self.assertEqual(before, self.snapshot())
        self.assertTrue(self.enable()['ok'])
        self.assertTrue(installer.verify_install(self.target, self.payload)['complete'])

    def test_running_game_rejected_before_download_and_after_download(self):
        before = self.snapshot()
        with patch.object(installer.live, 'status', return_value={'attached': True}), \
                patch.object(fsr4build, 'fetch') as fetch:
            result = asyncio.run(self.service.set_fsr4_build(str(self.target), '4.1.1b'))
            self.assertFalse(result['ok'])
            fetch.assert_not_called()
        with patch.object(installer.live, 'status', side_effect=[{}, {'attached': True}]):
            self.assertFalse(self.enable()['ok'])
        self.assertEqual(before, self.snapshot())

    def test_unmanaged_install_rejected(self):
        (self.target/MANIFEST_NAME).unlink()
        before = (self.target/FFX_UPSCALER_DLL).read_bytes()
        self.assertFalse(self.enable()['ok'])
        self.assertEqual(before, (self.target/FFX_UPSCALER_DLL).read_bytes())

    def test_manifest_write_failure_rolls_back_dll_and_ini(self):
        before = self.snapshot()
        real_copy = installer.atomic_copy
        def fail_once(source, destination):
            if Path(source).name == 'new.json':
                raise OSError('simulated disk failure')
            real_copy(source, destination)
        with patch.object(installer, 'atomic_copy', side_effect=fail_once):
            self.assertFalse(self.enable()['ok'])
        self.assertEqual(before, self.snapshot())

    def test_prior_lite_20261105_recognized_verifies_upgrades_restores_and_uninstalls(self):
        prior_real = fsr4build.find('4.1.2-lite-exact-20261105')
        self.assertIsNotNone(prior_real)
        self.assertEqual(
            prior_real['file_sha256'],
            'f991d06a8b800ed3e01b95696333c842c3de590aec7d2e6b2340c4e583d84ef4',
        )
        self.assertEqual(prior_real['file_bytes'], 39608832)

        # Superseded prior build cannot be freshly installed via set_fsr4_build or fetch.
        rejected = asyncio.run(self.service.set_fsr4_build(str(self.target), '4.1.2-lite-exact-20261105'))
        self.assertFalse(rejected['ok'])
        with self.assertRaisesRegex(ValueError, 'compatibility only'):
            fsr4build.fetch(prior_real, self.root)

        # Simulate an existing game already running the prior 2026-11-05 Lite DLL.
        prior_dll = self.root / 'prior-20261105.dll'
        prior_dll.write_bytes(b'prior 2026-11-05 community Lite DLL')
        prior_build = dict(
            prior_real,
            file_sha256=hashlib.sha256(prior_dll.read_bytes()).hexdigest(),
            file_bytes=prior_dll.stat().st_size,
        )
        current_dll = self.root / 'current-20261122.dll'
        current_dll.write_bytes(b'current 2026-11-22 community Lite DLL')
        current_build = dict(
            constants.FSR4_BUILDS[0],
            file_sha256=hashlib.sha256(current_dll.read_bytes()).hexdigest(),
            file_bytes=current_dll.stat().st_size,
        )

        with patch.object(fsr4build, 'FSR4_PRIOR_BUILDS', (prior_build,)), \
                patch.object(fsr4build, 'FSR4_BUILDS', [current_build]):
            installer.install_fsr4_build(str(self.target), prior_dll, prior_build, None, True)
            identified = fsr4build.identify(self.target / FFX_UPSCALER_DLL)
            self.assertTrue(identified['known'])
            self.assertEqual(identified['id'], '4.1.2-lite-exact-20261105')
            self.assertTrue(installer.verify_install(self.target, self.payload)['complete'])

            # Reinstall / runtime refresh preserves the recognized prior Lite build.
            installer.install(self.target, self.payload)
            self.assertEqual(
                (self.target / FFX_UPSCALER_DLL).read_bytes(),
                prior_dll.read_bytes(),
            )
            self.assertEqual(
                installer.read_manifest(self.target)['fsr4_build']['id'],
                '4.1.2-lite-exact-20261105',
            )

            # Seamless upgrade to 2026-11-22 preserves FrameGen settings.
            with patch.object(fsr4build, 'fetch', return_value=current_dll):
                upgraded = asyncio.run(
                    self.service.set_fsr4_build(
                        str(self.target),
                        constants.FSR4_STEAM_DECK_BUILD_ID,
                    )
                )
            self.assertTrue(upgraded['ok'], upgraded)
            self.assertEqual(
                fsr4build.identify(self.target / FFX_UPSCALER_DLL)['id'],
                '4.1.2-lite-exact-20261122',
            )
            self.assertEqual(IniFile(self.target / INI_NAME).get('FrameGen', 'FGOutput'), 'fsr3')

            # Restore back to stock official DLL from prior 2026-11-05 directly.
            installer.install_fsr4_build(str(self.target), prior_dll, prior_build, None, True)
            restored = asyncio.run(
                self.service.restore_fsr4_build(str(self.target), apply_official_preset=True)
            )
            self.assertTrue(restored['ok'], restored)
            self.assertEqual(fsr4build.identify(self.target / FFX_UPSCALER_DLL)['id'], 'bundled')
            self.assertEqual(
                IniFile(self.target / INI_NAME).get('FSR', 'Fsr4ForceEnableInt8'),
                'auto',
            )

            # Uninstall cleanly from prior 2026-11-05 restores original game DLL.
            installer.install_fsr4_build(str(self.target), prior_dll, prior_build, None, True)
            installer.uninstall(self.target)
            self.assertEqual((self.target / FFX_UPSCALER_DLL).read_bytes(), b'original game DLL')

    def test_concurrent_set_fsr4_build_for_two_games_same_build_id(self):
        runtime_dir = self.root / 'isolated-runtime'
        service = OptiScalerService(
            ROOT, self.root / 'settings-concurrent', runtime_dir,
            self.root / 'home', logging.getLogger('test'),
        )
        targets = []
        for idx in (1, 2):
            game = self.root / f'concurrent-game-{idx}'
            game.mkdir()
            (game / FFX_UPSCALER_DLL).write_bytes(f'original game {idx} DLL'.encode())
            installer.install(game, self.payload)
            point = asyncio.run(service.create_restore_point(str(game), str(game), ''))
            self.assertTrue(point['ok'], point)
            targets.append(game)

        archive_bytes = b'fake-fsr4-archive-payload'
        dll_bytes = self.dll.read_bytes()
        build = dict(
            self.build,
            sources=[dict(
                self.build['sources'][0],
                archive_sha256=hashlib.sha256(archive_bytes).hexdigest(),
            )],
        )

        active = 0
        max_active = 0
        guard = threading.Lock()

        def fake_download(url, archive, **kwargs):
            time.sleep(0.04)
            archive.parent.mkdir(parents=True, exist_ok=True)
            archive.write_bytes(archive_bytes)

        def fake_extract(archive, target, logger=None):
            nonlocal active, max_active
            with guard:
                active += 1
                max_active = max(max_active, active)
            try:
                time.sleep(0.05)
                target.mkdir(parents=True, exist_ok=True)
                (target / build['file']).write_bytes(dll_bytes)
            finally:
                with guard:
                    active -= 1

        async def run_both():
            return await asyncio.gather(
                service.set_fsr4_build(str(targets[0]), build['id']),
                service.set_fsr4_build(str(targets[1]), build['id']),
            )

        with patch.object(fsr4build, 'FSR4_BUILDS', [build]), \
                patch.object(fsr4build.wiki, 'download', side_effect=fake_download) as get, \
                patch.object(fsr4build.payload, 'extract_archive', side_effect=fake_extract) as extract:
            res1, res2 = asyncio.run(run_both())

        self.assertTrue(res1['ok'], res1)
        self.assertTrue(res2['ok'], res2)
        self.assertEqual(max_active, 1)
        self.assertEqual(get.call_count, 1)
        self.assertEqual(extract.call_count, 1)
        for game in targets:
            self.assertEqual((game / FFX_UPSCALER_DLL).read_bytes(), dll_bytes)
            with patch.object(fsr4build, 'FSR4_BUILDS', [build]):
                self.assertEqual(fsr4build.identify(game / FFX_UPSCALER_DLL)['id'], build['id'])
                self.assertTrue(installer.verify_install(game, self.payload)['complete'])


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    unittest.main()
