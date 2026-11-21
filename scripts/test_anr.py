#!/usr/bin/env python3
"""Offline unit and integration tests for Apex Neural Rendering (ANR FG) support."""
import asyncio
import hashlib
import logging
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))
from optiscaler import anr, constants, installer, live, restorepoint, schema
from optiscaler.inifile import IniFile
from optiscaler.service import OptiScalerService

ROOT = Path(__file__).resolve().parents[1]


def _make_zip(path, members):
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, content in members.items():
            zf.writestr(name, content)
    return path


class AnrFetchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        anr._digests.clear()
        self.proxy_bytes = b"OptiScaler synthetic apex proxy " + b"P" * 4096
        self.provider_bytes = b"synthetic anr provider dll " + b"A" * 2048
        self.ini_bytes = b"[ANR]\nLog=true\n"
        self.pack_bytes = b"NRXPACK"
        self.archive_src = _make_zip(
            self.root / "upstream.zip",
            {
                "README.txt": b"ignored readme",
                "game/dxgi.dll": self.proxy_bytes,
                "game/OptiScaler.ini": b"[FrameGen]\nEnabled=auto\n",
                f"game/{constants.ANR_PROVIDER_DLL_REL}": self.provider_bytes,
                f"game/{anr.NR_FG_INI_REL}": self.ini_bytes,
                f"game/{constants.ANR_PROVIDER_REL_DIR}/dlssg/kernels/pack.nrx": self.pack_bytes,
            },
        )
        self.archive_bytes = self.archive_src.read_bytes()
        self.patches = [
            patch.object(anr, "ANR_ARCHIVE_BYTES", len(self.archive_bytes)),
            patch.object(anr, "ANR_ARCHIVE_SHA256", hashlib.sha256(self.archive_bytes).hexdigest()),
            patch.object(anr, "ANR_OPTISCALER_BYTES", len(self.proxy_bytes)),
            patch.object(anr, "ANR_OPTISCALER_SHA256", hashlib.sha256(self.proxy_bytes).hexdigest()),
            patch.object(anr, "ANR_PROVIDER_DLL_BYTES", len(self.provider_bytes)),
            patch.object(anr, "ANR_PROVIDER_DLL_SHA256", hashlib.sha256(self.provider_bytes).hexdigest()),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def _download(self, url, dest, **kwargs):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(self.archive_bytes)

    def test_fetch_verifies_and_caches_package(self):
        cache = self.root / "cache"
        with patch.object(anr.wiki, "download", side_effect=self._download) as get:
            pkg = anr.fetch(cache)
            self.assertEqual(get.call_count, 1)
            self.assertEqual(pkg["proxy_dll"].read_bytes(), self.proxy_bytes)
            self.assertIn(constants.ANR_PROVIDER_DLL_REL, pkg["files"])
            self.assertIn(anr.NR_FG_INI_REL, pkg["files"])
            self.assertNotIn("README.txt", pkg["files"])
            # Second call uses verified cache without downloading again.
            pkg2 = anr.fetch(cache)
            self.assertEqual(get.call_count, 1)
            self.assertEqual(pkg2["proxy_dll"], pkg["proxy_dll"])

    def test_fetch_rejects_archive_checksum_mismatch(self):
        def bad_download(url, dest, **kwargs):
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"corrupted archive")

        with patch.object(anr.wiki, "download", side_effect=bad_download):
            with self.assertRaisesRegex(ValueError, "archive checksum mismatch"):
                anr.fetch(self.root / "cache")
        self.assertFalse((self.root / "cache" / constants.ANR_VERSION / constants.ANR_ASSET).exists())

    def test_extract_rejects_path_traversal_and_symlinks(self):
        bad_zip = _make_zip(
            self.root / "traversal.zip",
            {
                "game/dxgi.dll": self.proxy_bytes,
                f"game/{constants.ANR_PROVIDER_REL_DIR}/../escape.dll": b"evil",
            },
        )
        with self.assertRaisesRegex(ValueError, "Unsafe ANR archive member path"):
            anr._extract_verified(bad_zip, self.root / "out1")

        symlink_zip = self.root / "symlink.zip"
        with zipfile.ZipFile(symlink_zip, "w") as zf:
            info = zipfile.ZipInfo(f"game/{constants.ANR_PROVIDER_DLL_REL}")
            info.external_attr = (0o120777 << 16)
            zf.writestr(info, "/etc/passwd")
        with self.assertRaisesRegex(ValueError, "symlink"):
            anr._extract_verified(symlink_zip, self.root / "out2")

    def test_extract_rejects_wrong_provider_dll_hash(self):
        bad_zip = _make_zip(
            self.root / "bad-dll.zip",
            {
                "game/dxgi.dll": self.proxy_bytes,
                f"game/{constants.ANR_PROVIDER_DLL_REL}": b"X" * len(self.provider_bytes),
            },
        )
        with self.assertRaisesRegex(ValueError, "provider DLL checksum mismatch"):
            anr._extract_verified(bad_zip, self.root / "out3")


class AnrLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        anr._digests.clear()
        self.service = OptiScalerService(
            ROOT,
            self.root / "settings",
            self.root / "runtime",
            self.root / "home",
            logging.getLogger("test-anr"),
        )
        self.payload = asyncio.run(self.service.ensure_payload())
        self.target = self.root / "game"
        self.target.mkdir()
        (self.target / "game.exe").write_bytes(b"MZ fake game")
        (self.target / "dxgi.dll").write_bytes(b"original game dxgi")
        self.original_files = {
            p.relative_to(self.target).as_posix(): p.read_bytes()
            for p in self.target.rglob("*")
            if p.is_file()
        }

        installed = asyncio.run(
            self.service.install(str(self.target), "dxgi.dll", game_path=str(self.target))
        )
        self.assertTrue(installed["ok"], installed)
        ini = IniFile(self.target / constants.INI_NAME)
        ini.set("FrameGen", "Enabled", "true")
        ini.set("FrameGen", "FGInput", "fsrfg")
        ini.set("FrameGen", "FGOutput", "fsrfg")
        ini.save()

        # Synthetic verified ANR package for offline lifecycle tests.
        self.proxy_bytes = b"OptiScaler Apex build d6b02459 " + b"X" * (installer.MIN_OPTISCALER_SIZE // 2)
        self.provider_bytes = b"ANR FG nvngx_dlssg.dll " + b"Y" * 2048
        self.pkg_root = self.root / "anr-pkg"
        self.pkg_root.mkdir()
        (self.pkg_root / "dxgi.dll").write_bytes(self.proxy_bytes)
        rel_files = [
            constants.ANR_PROVIDER_DLL_REL,
            anr.NR_FG_INI_REL,
            f"{constants.ANR_PROVIDER_REL_DIR}/dlssg/kernels/pack.nrx",
        ]
        for rel, data in (
            (constants.ANR_PROVIDER_DLL_REL, self.provider_bytes),
            (anr.NR_FG_INI_REL, b"[ANR]\nQuality=1\n"),
            (f"{constants.ANR_PROVIDER_REL_DIR}/dlssg/kernels/pack.nrx", b"NRX1"),
        ):
            dest = self.pkg_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)

        proxy_sha = hashlib.sha256(self.proxy_bytes).hexdigest()
        provider_sha = hashlib.sha256(self.provider_bytes).hexdigest()
        self.package = {
            "version": constants.ANR_VERSION,
            "optiscaler_commit": constants.ANR_OPTISCALER_COMMIT,
            "proxy_dll": self.pkg_root / "dxgi.dll",
            "proxy_sha256": proxy_sha,
            "provider_dll_sha256": provider_sha,
            "root": self.pkg_root,
            "files": rel_files,
        }
        for mod in (constants, anr, installer):
            for name, val in (
                ("ANR_OPTISCALER_BYTES", len(self.proxy_bytes)),
                ("ANR_OPTISCALER_SHA256", proxy_sha),
                ("ANR_PROVIDER_DLL_BYTES", len(self.provider_bytes)),
                ("ANR_PROVIDER_DLL_SHA256", provider_sha),
            ):
                if hasattr(mod, name):
                    p = patch.object(mod, name, val)
                    p.start()
                    self.addCleanup(p.stop)

    def _enable(self):
        with patch.object(anr, "fetch", return_value=self.package):
            return asyncio.run(self.service.install_anr_fg(str(self.target)))

    def test_schema_accepts_anr_framegen_settings(self):
        for change in anr.ini_changes():
            meta = schema.option(change["section"], change["key"])
            self.assertIsNotNone(meta, change)
            self.assertTrue(schema.valid(meta, change["value"]), change)

    def test_enable_verify_disable_and_full_uninstall_roundtrip(self):
        # Enable ANR FG
        res = self._enable()
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["anr"]["active"], res["anr"])
        self.assertTrue(installer.runtime_current(self.target))
        self.assertEqual((self.target / "dxgi.dll").read_bytes(), self.proxy_bytes)
        self.assertEqual((self.target / constants.ANR_PROVIDER_DLL_REL).read_bytes(), self.provider_bytes)

        # Incompatible 0.9.5 live-control ASI must be removed and live status must say unsupported.
        self.assertFalse((self.target / live.PLUGIN_SUBDIR / live.ASI_NAME).exists())
        live_report = asyncio.run(self.service.get_live_status(str(self.target)))
        self.assertFalse(live_report["supported"])
        self.assertFalse(live_report["can_install"])
        self.assertIn("ANR FG", live_report["reason"])
        live_install = asyncio.run(self.service.install_live(str(self.target)))
        self.assertFalse(live_install["ok"])

        # INI configured for ANR FG
        ini = IniFile(self.target / constants.INI_NAME)
        self.assertEqual(ini.get("FrameGen", "Enabled"), "auto")
        self.assertEqual(ini.get("FrameGen", "FGInput"), "nvngxfg")
        self.assertEqual(ini.get("FrameGen", "FGNvngxReplacement"), constants.ANR_PROVIDER_NAME)
        self.assertEqual(ini.get("FrameGen", "DisableHudless"), "false")

        # Verify install reports complete
        verified = asyncio.run(self.service.verify_install(str(self.target)))
        self.assertTrue(verified["ok"] and verified["complete"], verified)

        # Simulate runtime log written by ANR FG
        runtime_log = self.target / constants.ANR_PROVIDER_REL_DIR / "dlssg" / "nr_fg-20261121.log"
        runtime_log.write_text("anr runtime log")

        # Disable ANR FG -> restores OptiScaler 0.9.5, live ASI, and previous FrameGen settings
        disabled = asyncio.run(self.service.remove_anr_fg(str(self.target)))
        self.assertTrue(disabled["ok"], disabled)
        self.assertFalse(disabled["anr"]["active"])
        self.assertFalse((self.target / "OptiScaler").exists())
        self.assertTrue((self.target / live.PLUGIN_SUBDIR / live.ASI_NAME).is_file())
        self.assertTrue(installer.runtime_current(self.target))
        self.assertEqual(
            installer._sha256_file(self.target / "dxgi.dll"),
            constants.RUNTIME_DLL_SHA256,
        )
        ini_after = IniFile(self.target / constants.INI_NAME)
        self.assertEqual(ini_after.get("FrameGen", "Enabled"), "true")
        self.assertEqual(ini_after.get("FrameGen", "FGInput"), "fsrfg")
        self.assertEqual(ini_after.get("FrameGen", "FGOutput"), "fsrfg")
        verified_after = asyncio.run(self.service.verify_install(str(self.target)))
        self.assertTrue(verified_after["ok"] and verified_after["complete"], verified_after)

        # Re-enable ANR FG, then full uninstall -> game folder restored byte-for-byte
        self.assertTrue(self._enable()["ok"])
        (self.target / constants.ANR_PROVIDER_REL_DIR / "dlssg" / "nr_fg-20261121.log").write_text("log")
        uninstalled = asyncio.run(self.service.uninstall(str(self.target)))
        self.assertTrue(uninstalled["ok"], uninstalled)
        remaining = {
            p.relative_to(self.target).as_posix(): p.read_bytes()
            for p in self.target.rglob("*")
            if p.is_file()
        }
        self.assertEqual(remaining, self.original_files)
        self.assertFalse((self.target / "OptiScaler").exists())

    def test_running_game_rejected_before_and_after_fetch(self):
        with patch.object(installer.live, "status", return_value={"attached": True}), \
                patch.object(anr, "fetch") as fetch:
            res = asyncio.run(self.service.install_anr_fg(str(self.target)))
            self.assertFalse(res["ok"])
            fetch.assert_not_called()

    def test_unmanaged_install_rejected(self):
        (self.target / constants.MANIFEST_NAME).unlink()
        res = self._enable()
        self.assertFalse(res["ok"])

    def test_restore_point_rolls_back_from_anr_to_official_095(self):
        point = asyncio.run(
            self.service.create_restore_point(str(self.target), str(self.target), "")
        )
        self.assertTrue(point["ok"], point)
        self.assertTrue(self._enable()["ok"])
        self.assertTrue(anr.status(self.target)["active"])
        rolled = asyncio.run(self.service.rollback_install(str(self.target), str(self.target)))
        self.assertTrue(rolled["ok"], rolled)
        self.assertFalse(anr.status(self.target)["active"])
        self.assertEqual(
            installer._sha256_file(self.target / "dxgi.dll"),
            constants.RUNTIME_DLL_SHA256,
        )

    def test_existing_nr_fg_ini_is_preserved_on_reapply(self):
        self.assertTrue(self._enable()["ok"])
        cfg = self.target / anr.NR_FG_INI_REL
        cfg.write_bytes(b"[ANR]\nCustomUserSetting=42\n")
        self.assertTrue(self._enable()["ok"])
        self.assertEqual(cfg.read_bytes(), b"[ANR]\nCustomUserSetting=42\n")


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    unittest.main()
