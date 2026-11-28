#!/usr/bin/env python3
"""Focused offline unit tests for sysinfo, inifile, monitor, payload, service and RPC contracts."""

import ast
import asyncio
import hashlib
import inspect
import json
import logging
import os
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py_modules"))

from optiscaler import constants, inifile, installer, monitor, payload, sysinfo  # noqa: E402
from optiscaler.inifile import IniFile  # noqa: E402
from optiscaler.service import OptiScalerService  # noqa: E402


def _make_fake_payload(root: Path) -> Path:
    """Create a tiny synthetic extracted OptiScaler payload directory for fast unit tests."""
    source = root / "fake-payload"
    source.mkdir(parents=True, exist_ok=True)
    runtime_manifest = json.loads((ROOT / "defaults" / "runtime-manifest.json").read_text(encoding="utf-8"))
    ref_ini = (ROOT / "defaults" / "OptiScaler.reference.ini").read_bytes()
    dll_bytes = installer.DLL_MARKER + b"unit-test-core" + b"\0" * installer.MIN_OPTISCALER_SIZE
    pinned = {}
    for name in runtime_manifest["files"]:
        dest = source / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if name == "OptiScaler.dll":
            data = dll_bytes
        elif name == constants.INI_NAME:
            data = ref_ini
        else:
            data = f"synthetic-{name}".encode("utf-8")
        dest.write_bytes(data)
        pinned[name] = {
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    return source, pinned, pinned["OptiScaler.dll"]["sha256"]


class SysinfoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="decky-sysinfo-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.drm = self.root / "drm"
        self.kfd = self.root / "kfd"
        self.dmi = self.root / "dmi_product_name"
        self.drm.mkdir()
        self.kfd.mkdir()
        sysinfo.gpu_info.cache_clear()
        self.addCleanup(sysinfo.gpu_info.cache_clear)

    def _write_card(self, index: int, vendor: str, device: str, product_name: str = ""):
        dev = self.drm / f"card{index}" / "device"
        dev.mkdir(parents=True, exist_ok=True)
        (dev / "vendor").write_text(vendor + "\n", encoding="utf-8")
        (dev / "device").write_text(device + "\n", encoding="utf-8")
        if product_name:
            (dev / "product_name").write_text(product_name + "\n", encoding="utf-8")

    def _write_kfd_node(self, index: int, gfx_version: str):
        node = self.kfd / str(index)
        node.mkdir(parents=True, exist_ok=True)
        (node / "properties").write_text(
            f"cpu_cores_count 0\ngfx_target_version {gfx_version}\n", encoding="utf-8"
        )

    def _query(self, dmi_name: str = ""):
        if dmi_name:
            self.dmi.write_text(dmi_name + "\n", encoding="utf-8")
        elif self.dmi.exists():
            self.dmi.unlink()
        real_read = sysinfo._read

        def fake_read(path):
            if str(path) == "/sys/devices/virtual/dmi/id/product_name":
                return real_read(self.dmi)
            return real_read(path)

        sysinfo.gpu_info.cache_clear()
        with patch.object(sysinfo, "DRM_ROOT", self.drm), \
                patch.object(sysinfo, "KFD_NODES", self.kfd), \
                patch.object(sysinfo, "_read", side_effect=fake_read):
            return sysinfo.gpu_info()

    def test_decode_gfx_valid_and_invalid(self):
        self.assertEqual(sysinfo._decode_gfx("100303"), "gfx1033")
        self.assertEqual(sysinfo._decode_gfx("100305"), "gfx1035")
        self.assertEqual(sysinfo._decode_gfx("110000"), "gfx1100")
        self.assertEqual(sysinfo._decode_gfx("110501"), "gfx1151")
        self.assertEqual(sysinfo._decode_gfx("120001"), "gfx1201")
        self.assertIsNone(sysinfo._decode_gfx(""))
        self.assertIsNone(sysinfo._decode_gfx("gfx1033"))
        self.assertIsNone(sysinfo._decode_gfx("-1"))

    def test_steam_deck_van_gogh_rdna2_apu(self):
        self._write_card(0, "0x1002", "0x163f", "AMD Custom GPU 0405")
        self._write_kfd_node(1, "100303")
        info = self._query("Galileo")
        self.assertEqual(info["vendor"], "amd")
        self.assertEqual(info["generation"], "RDNA2")
        self.assertEqual(info["name"], "Van Gogh (Steam Deck)")
        self.assertEqual(info["gfx"], "gfx1033")
        self.assertEqual(info["fsr4"], "experimental")
        self.assertTrue(info["is_rdna2_apu"])

    def test_rdna2_discrete_is_not_rdna2_apu(self):
        self._write_card(0, "0x1002", "0x73bf", "AMD Radeon RX 6800 XT")
        self._write_kfd_node(1, "100300")
        info = self._query("Desktop Board")
        self.assertEqual(info["vendor"], "amd")
        self.assertEqual(info["generation"], "RDNA2")
        self.assertEqual(info["gfx"], "gfx1030")
        self.assertFalse(info["is_rdna2_apu"])

    def test_rdna3_and_rdna35_and_rdna4(self):
        self._write_card(0, "0x1002", "0x15bf")
        self._write_kfd_node(1, "110003")
        rdna3 = self._query()
        self.assertEqual(rdna3["generation"], "RDNA3")
        self.assertEqual(rdna3["fsr4"], "int8")
        self.assertFalse(rdna3["is_rdna2_apu"])

        # Replace with Strix Point RDNA3.5
        self._write_card(0, "0x1002", "0x1586")
        self._write_kfd_node(1, "110500")
        rdna35 = self._query()
        self.assertEqual(rdna35["generation"], "RDNA3.5")
        self.assertEqual(rdna35["fsr4"], "int8")
        self.assertFalse(rdna35["is_rdna2_apu"])

        # Replace with RDNA4 discrete (unknown PCI ID, resolved via KFD gfx1201)
        self._write_card(0, "0x1002", "0x7550", "AMD Radeon RX 9070 XT")
        self._write_kfd_node(1, "120001")
        rdna4 = self._query()
        self.assertEqual(rdna4["generation"], "RDNA4")
        self.assertEqual(rdna4["gfx"], "gfx1201")
        self.assertEqual(rdna4["fsr4"], "native")
        self.assertFalse(rdna4["is_rdna2_apu"])

    def test_nvidia_and_intel_gpus(self):
        self._write_card(0, "0x10de", "0x2684", "NVIDIA GeForce RTX 4090")
        nv = self._query()
        self.assertEqual(nv["vendor"], "nvidia")
        self.assertIsNone(nv["generation"])
        self.assertEqual(nv["fsr4"], "unknown")
        self.assertFalse(nv["is_rdna2_apu"])

        self._write_card(0, "0x8086", "0x56a0", "Intel Arc A770")
        intel = self._query()
        self.assertEqual(intel["vendor"], "intel")
        self.assertIsNone(intel["generation"])
        self.assertEqual(intel["fsr4"], "unknown")
        self.assertFalse(intel["is_rdna2_apu"])

    def test_multi_gpu_prefers_recognized_amd_device(self):
        self._write_card(0, "0x8086", "0x46a6", "Intel UHD Graphics")
        self._write_card(1, "0x1002", "0x163f", "AMD Custom GPU 0405")
        self._write_kfd_node(0, "0")  # CPU node skipped
        self._write_kfd_node(1, "100303")
        info = self._query()
        self.assertEqual(info["vendor"], "amd")
        self.assertEqual(info["generation"], "RDNA2")
        self.assertEqual(info["name"], "Van Gogh (Steam Deck)")
        self.assertTrue(info["is_rdna2_apu"])

    def test_marketing_fallback_without_sysfs_pci_or_kfd(self):
        info = self._query("Steam Deck Jupiter")
        self.assertEqual(info["vendor"], "amd")
        self.assertEqual(info["generation"], "RDNA2")
        self.assertTrue(info["is_rdna2_apu"])


class IniFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="decky-ini-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_utf8_bom_first_line_section_parses_and_saves_without_duplicate_section(self):
        path = self.root / "OptiScaler.ini"
        path.write_bytes(b"\xef\xbb\xbf[Plugins]\nLoadAsiPlugins=false\n[FSR]\nUpscalerIndex=0\n")
        ini = IniFile(path)
        self.assertEqual(ini.get("Plugins", "LoadAsiPlugins"), "false")
        self.assertEqual(ini.get("FSR", "UpscalerIndex"), "0")
        ini.set("Plugins", "LoadAsiPlugins", "true")
        ini.save()
        saved_bytes = path.read_bytes()
        self.assertFalse(saved_bytes.startswith(b"\xef\xbb\xbf"))
        saved_text = saved_bytes.decode("utf-8")
        self.assertEqual(saved_text.count("[Plugins]"), 1, saved_text)
        self.assertEqual(IniFile(path).get("Plugins", "LoadAsiPlugins"), "true")

    def test_crlf_input_parses_cleanly_without_cr_in_values(self):
        path = self.root / "crlf.ini"
        path.write_bytes(b"; header\r\n[Menu]\r\nShowFps=false\r\n[FSR]\r\nUpscalerIndex=0\r\n")
        ini = IniFile(path)
        self.assertEqual(ini.get("Menu", "ShowFps"), "false")
        self.assertEqual(ini.get("FSR", "UpscalerIndex"), "0")
        ini.set("Menu", "ShowFps", "true")
        ini.save()
        reloaded = IniFile(path)
        self.assertEqual(reloaded.get("Menu", "ShowFps"), "true")
        self.assertEqual(reloaded.get("FSR", "UpscalerIndex"), "0")
        self.assertIn("; header", path.read_text(encoding="utf-8"))
        self.assertNotIn("\r", reloaded.get("Menu", "ShowFps"))

    def test_duplicate_keys_and_update_forms(self):
        path = self.root / "dup.ini"
        path.write_text("[FSR]\nUpscalerIndex=0\nUpscalerIndex=2\n", encoding="utf-8")
        ini = IniFile(path)
        self.assertEqual(ini.get("FSR", "UpscalerIndex"), "2")
        ini.update({("FSR", "Fsr4Update"): "true", ("NewSection", "Key"): None})
        ini.update({"Menu": {"ShowFps": "true"}})
        ini.save()
        reloaded = IniFile(path)
        self.assertEqual(reloaded.get("FSR", "Fsr4Update"), "true")
        self.assertEqual(reloaded.get("NewSection", "Key"), "auto")
        self.assertEqual(reloaded.get("Menu", "ShowFps"), "true")

    def test_newline_and_nul_rejected_in_set(self):
        ini = IniFile(self.root / "inject.ini")
        for bad in ("true\n[Plugins]\nPath=evil", "true\rLoadAsiPlugins=true", "true\x00x"):
            with self.assertRaises(ValueError, msg=f"value {bad!r} must be rejected"):
                ini.set("Menu", "ShowFps", bad)
        for bad_key in ("ShowFps\nEvil", "ShowFps\r", "Show\x00Fps"):
            with self.assertRaises(ValueError, msg=f"key {bad_key!r} must be rejected"):
                ini.set("Menu", bad_key, "true")
        for bad_section in ("Menu]\n[Plugins", "Menu\r", "Menu\x00"):
            with self.assertRaises(ValueError, msg=f"section {bad_section!r} must be rejected"):
                ini.set(bad_section, "ShowFps", "true")


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="decky-monitor-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_tail_truncates_over_512kb_and_drops_partial_first_line(self):
        log = self.root / constants.LOG_NAME
        early = "[00:00:01.0] [I] EARLY_SENTINEL_SHOULD_BE_DROPPED\n"
        filler = "[00:00:02.0] [I] " + ("A" * 100) + "\n"
        late = "[00:09:59.9] [I] LATE_SENTINEL_PRESENT\n"
        # > 600 KB total so tail(max_bytes=512*1024) must seek past early lines.
        log.write_bytes((early + filler * 5200 + late).encode("utf-8"))
        self.assertGreater(log.stat().st_size, 512 * 1024)
        tailed = monitor.tail(log)
        self.assertNotIn("EARLY_SENTINEL_SHOULD_BE_DROPPED", tailed)
        self.assertIn("LATE_SENTINEL_PRESENT", tailed)
        # First line after seeking must not be a cut partial fragment.
        first_line = tailed.splitlines()[0]
        self.assertTrue(first_line.startswith("[00:00:02.0]"), first_line)

    def test_invalid_utf8_bytes_decoded_safely(self):
        log = self.root / constants.LOG_NAME
        log.write_bytes(b"[01:02:03.4] [I] Running on Wine 9.0\xff\xfe!\n")
        text = monitor.tail(log)
        self.assertIn("\ufffd", text)
        parsed = monitor.parse_log(text)
        self.assertEqual(parsed["total_lines"], 1)

    def test_all_hints_and_fg_signals_and_fact_overwrite(self):
        sample = "\n".join([
            "[10:00:00.1] [I] Running on Wine 10.0-GE!",
            "[10:00:00.2] [I] OptiScaler v0.9.5",
            "[10:00:00.3] [I] OptiScaler working as dxgi.dll",
            "[10:00:00.4] [I] Game's Exe: Game.exe",
            "[10:00:00.5] [I] Game Name: Test Game",
            "[10:00:00.6] [I] Game Version: 1.2.3",
            "[10:00:00.7] [I] Adapter Desc: AMD Custom GPU 0405",
            "[10:00:01.0] [I] Creating new XeSS upscaler",
            "[10:00:02.0] [I] changing backend to FSR 4.1.2",
            "[10:00:03.0] [I] XeFG swapchain created",
            "[10:00:03.1] [I] XeFG context created",  # duplicate signal must dedupe
            "[10:00:03.2] [I] Nukem's initialized",
            "[10:00:03.3] [I] FSR3 FG context created",
            "[10:00:03.4] [I] OptiFG context enabled",
            "[10:00:03.5] [I] DLSSG swapchain initialized",
            "[10:00:04.0] [W] Failed to load amdxcffx64.dll",
            "[10:00:04.1] [W] Failed to load nvngx_dlss.dll",
            "[10:00:04.2] [E] No supported upscaler found",
        ])
        parsed = monitor.parse_log(sample)
        self.assertEqual(parsed["state"]["upscaler"], "FSR 4.1.2")
        self.assertEqual(parsed["state"]["proxy"], "dxgi.dll")
        self.assertEqual(parsed["state"]["optiscaler_version"], "0.9.5")
        self.assertEqual(
            parsed["frame_generation"],
            ["XeFG", "Nukem's dlssg-to-fsr3", "FSR FG", "OptiFG", "DLSSG via Streamline"],
        )
        self.assertEqual(len(parsed["hints"]), len(monitor.HINTS), parsed["hints"])
        self.assertEqual(parsed["counts"]["warning"], 2)
        self.assertEqual(parsed["counts"]["error"], 1)

    def test_clear_log_regular_missing_and_symlink(self):
        self.assertFalse(monitor.clear_log(self.root))
        log = self.root / constants.LOG_NAME
        log.write_text("some log lines\n", encoding="utf-8")
        self.assertTrue(monitor.clear_log(self.root))
        self.assertEqual(log.stat().st_size, 0)

        target = self.root / "outside.txt"
        target.write_text("keep me", encoding="utf-8")
        log.unlink()
        log.symlink_to(target)
        with self.assertRaises((OSError, ValueError)):
            monitor.clear_log(self.root)
        self.assertEqual(target.read_text(encoding="utf-8"), "keep me")


class PayloadUnitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="decky-payload-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_extract_archive_fallback_chain_and_all_fail(self):
        archive = self.root / "test.7z"
        archive.write_bytes(b"fake")
        dest = self.root / "out"
        seen = []

        def fake_which(cmd):
            return f"/usr/bin/{cmd}" if cmd in ("7z", "bsdtar") else None

        def fake_run(argv, logger=None):
            seen.append(argv[0])
            if argv[0] == "7z":
                return False, "7z failed"
            return True, ""

        with patch.object(payload.shutil, "which", side_effect=fake_which), \
                patch.object(payload, "_run", side_effect=fake_run):
            result = payload.extract_archive(archive, dest)
        self.assertEqual(result, dest)
        self.assertEqual(seen, ["7z", "bsdtar"])

        with patch.object(payload.shutil, "which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "no supported archiver found"):
                payload.extract_archive(archive, dest)

        with patch.object(payload.shutil, "which", side_effect=fake_which), \
                patch.object(payload, "_run", return_value=(False, "corrupt")):
            with self.assertRaisesRegex(RuntimeError, "7z: corrupt; bsdtar: corrupt"):
                payload.extract_archive(archive, dest)

    def test_verify_archive_rejects_missing_and_bad_hash(self):
        missing = payload.Payload(self.root / "missing.7z", self.root / "extract")
        with self.assertRaises(FileNotFoundError):
            missing.verify_archive()

        bad = self.root / "bad.7z"
        bad.write_bytes(b"wrong archive bytes")
        item = payload.Payload(bad, self.root / "extract")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            item.verify_archive()

    def test_commit_staged_rolls_back_previous_cache_on_replace_error(self):
        extract_root = self.root / "extract"
        item = payload.Payload(self.root / "archive.7z", extract_root)
        item.root.mkdir(parents=True)
        (item.root / "OptiScaler.dll").write_bytes(b"previous working cache")
        staged = extract_root / "staged"
        staged.mkdir()
        (staged / "OptiScaler.dll").write_bytes(b"new staged cache")

        real_replace = os.replace
        calls = {"count": 0}

        def fail_second_replace(src, dst):
            calls["count"] += 1
            if calls["count"] == 2:
                raise OSError("simulated rename failure")
            return real_replace(src, dst)

        with patch.object(payload.os, "replace", side_effect=fail_second_replace):
            with self.assertRaises(OSError):
                item._commit_staged(staged)

        self.assertEqual((item.root / "OptiScaler.dll").read_bytes(), b"previous working cache")
        self.assertTrue((staged / "OptiScaler.dll").is_file())

        # Normal commit succeeds and cleans up the previous directory.
        item._commit_staged(staged)
        self.assertEqual((item.root / "OptiScaler.dll").read_bytes(), b"new staged cache")
        self.assertFalse(staged.exists())


class ServiceIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="decky-service-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / "home"
        self.steam = self.home / ".local" / "share" / "Steam"
        (self.steam / "steamapps" / "common").mkdir(parents=True)
        (self.home / ".steam").mkdir(parents=True, exist_ok=True)
        os.symlink(self.steam, self.home / ".steam" / "steam")

        (self.steam / "steamapps" / "libraryfolders.vdf").write_text(
            f'"libraryfolders"\n{{\n\t"0"\n\t{{\n\t\t"path"\t\t"{self.steam}"\n\t}}\n}}\n',
            encoding="utf-8",
        )
        (self.steam / "steamapps" / "appmanifest_1001.acf").write_text(
            '"AppState"\n{\n\t"appid"\t\t"1001"\n\t"name"\t\t"Alpha Game"\n'
            '\t"installdir"\t\t"AlphaGame"\n}\n',
            encoding="utf-8",
        )
        (self.steam / "steamapps" / "appmanifest_228980.acf").write_text(
            '"AppState"\n{\n\t"appid"\t\t"228980"\n\t"name"\t\t"Steamworks Common Redistributables"\n'
            '\t"installdir"\t\t"Steamworks Shared"\n}\n',
            encoding="utf-8",
        )
        self.alpha = self.steam / "steamapps" / "common" / "AlphaGame"
        (self.alpha / "bin").mkdir(parents=True)
        (self.alpha / "bin" / "Alpha.exe").write_bytes(b"MZ" + b"\0" * 1024)
        (self.alpha / "alt").mkdir(parents=True)
        (self.alpha / "alt" / "Alt.exe").write_bytes(b"MZ")
        (self.steam / "steamapps" / "common" / "Steamworks Shared").mkdir(parents=True)

        self.custom_lib = self.root / "custom-games"
        self.beta = self.custom_lib / "BetaGame"
        self.beta.mkdir(parents=True)
        (self.beta / "Beta.exe").write_bytes(b"MZ")

        self.source, pinned, dll_sha = _make_fake_payload(self.root)
        p1 = patch.object(payload, "_PINNED_FILES", pinned)
        p2 = patch.object(constants, "RUNTIME_DLL_SHA256", dll_sha)
        p1.start(); self.addCleanup(p1.stop)
        p2.start(); self.addCleanup(p2.stop)

        self.service = OptiScalerService(
            ROOT, self.root / "settings", self.root / "runtime", self.home,
            logging.getLogger("unit-service"),
        )
        self.service.ensure_payload = AsyncMock(return_value=str(self.source))
        self.service.live_asi_path = lambda: None

    def test_list_all_games_and_custom_library_removal(self):
        added = asyncio.run(self.service.add_custom_library(str(self.custom_lib), "Custom"))
        self.assertTrue(added["ok"], added)

        # Install into BetaGame so it sorts ahead of uninstalled Alpha Game.
        installed = asyncio.run(self.service.install(str(self.beta), "dxgi.dll"))
        self.assertTrue(installed["ok"], installed)

        games = asyncio.run(self.service.list_all_games())
        names = [g["name"] for g in games]
        self.assertEqual(names, ["BetaGame", "Alpha Game"])
        self.assertTrue(games[0]["installed"])
        self.assertFalse(games[1]["installed"])

        removed = asyncio.run(self.service.remove_custom_library(str(self.custom_lib)))
        self.assertTrue(removed["ok"], removed)
        libs = asyncio.run(self.service.list_libraries())
        self.assertFalse(any(lib["path"] == str(self.custom_lib) for lib in libs))

    def test_find_running_game_steam_shortcut_and_missing(self):
        found = asyncio.run(self.service.find_running_game("1001"))
        self.assertTrue(found["found"], found)
        self.assertEqual(found["name"], "Alpha Game")
        self.assertEqual(found["detail"]["name"], "Alpha Game")

        missing = asyncio.run(self.service.find_running_game("9999999"))
        self.assertFalse(missing["found"])

        shortcut = asyncio.run(self.service.find_running_game(
            "3000000001",
            {"exe": str(self.beta / "Beta.exe"), "start_dir": str(self.beta), "name": "Beta Shortcut"},
        ))
        self.assertTrue(shortcut["found"], shortcut)
        self.assertEqual(shortcut["path"], str(self.beta))
        self.assertEqual(shortcut["detail"]["target"], str(self.beta))

    def test_set_game_target_persists_and_clears(self):
        alt = self.alpha / "alt"
        res = asyncio.run(self.service.set_game_target(str(self.alpha), str(alt)))
        self.assertTrue(res["ok"], res)
        detail = asyncio.run(self.service.get_game(str(self.alpha), "Alpha Game"))
        self.assertEqual(detail["target"], str(alt))
        self.assertTrue(detail["target_is_saved"])

        cleared = asyncio.run(self.service.set_game_target(str(self.alpha), ""))
        self.assertTrue(cleared["ok"], cleared)
        after = asyncio.run(self.service.get_game(str(self.alpha), "Alpha Game"))
        self.assertFalse(after["target_is_saved"])

    def test_set_logging_reset_config_and_clear_log_success(self):
        target = self.alpha / "bin"
        installed = asyncio.run(self.service.install(str(target), "dxgi.dll"))
        self.assertTrue(installed["ok"], installed)

        on = asyncio.run(self.service.set_logging(str(target), True))
        self.assertTrue(on["ok"], on)
        ini = IniFile(target / constants.INI_NAME)
        self.assertEqual(ini.get("Log", "LogToFile"), "true")
        self.assertEqual(ini.get("Log", "LogLevel"), "2")
        self.assertEqual(ini.get("Log", "SingleFile"), "true")

        off = asyncio.run(self.service.set_logging(str(target), False))
        self.assertTrue(off["ok"], off)
        ini = IniFile(target / constants.INI_NAME)
        self.assertEqual(ini.get("Log", "LogToFile"), "false")
        self.assertEqual(ini.get("Log", "LogLevel"), "auto")

        # Mutate another setting and verify reset_config restores stock INI bytes & permissions.
        (target / constants.INI_NAME).chmod(0o640)
        mutated = asyncio.run(self.service.write_config(
            str(target), [{"section": "Menu", "key": "ShowFps", "value": "true"}]
        ))
        self.assertTrue(mutated["ok"], mutated)
        self.assertEqual(IniFile(target / constants.INI_NAME).get("Menu", "ShowFps"), "true")

        reset = asyncio.run(self.service.reset_config(str(target)))
        self.assertTrue(reset["ok"], reset)
        self.assertEqual((target / constants.INI_NAME).read_bytes(), (self.source / constants.INI_NAME).read_bytes())
        self.assertEqual((target / constants.INI_NAME).stat().st_mode & 0o777, 0o640)

        # clear_log truncates OptiScaler.log for managed installs and rejects unmanaged targets.
        log_path = target / constants.LOG_NAME
        log_path.write_text("line 1\nline 2\n", encoding="utf-8")
        cleared = asyncio.run(self.service.clear_log(str(target)))
        self.assertTrue(cleared["ok"], cleared)
        self.assertEqual(log_path.stat().st_size, 0)

        unmanaged = self.root / "unmanaged"
        unmanaged.mkdir()
        (unmanaged / constants.LOG_NAME).write_text("do not clear", encoding="utf-8")
        refused = asyncio.run(self.service.clear_log(str(unmanaged)))
        self.assertFalse(refused["ok"])
        self.assertEqual((unmanaged / constants.LOG_NAME).read_text(encoding="utf-8"), "do not clear")


class RpcContractTests(unittest.TestCase):
    @staticmethod
    def _load_main_module():
        fake_decky = types.ModuleType("decky")
        fake_decky.logger = logging.getLogger("rpc-contract-test")
        fake_decky.DECKY_PLUGIN_DIR = str(ROOT)
        fake_decky.DECKY_PLUGIN_SETTINGS_DIR = "/tmp/settings"
        fake_decky.DECKY_PLUGIN_RUNTIME_DIR = "/tmp/runtime"
        fake_decky.HOME = "/tmp/home"
        sys.path.insert(0, str(ROOT))
        try:
            with patch.dict(sys.modules, {"decky": fake_decky}):
                sys.modules.pop("main", None)
                import importlib
                return importlib.import_module("main")
        finally:
            if str(ROOT) in sys.path:
                sys.path.remove(str(ROOT))

    def test_api_ts_main_py_and_service_py_rpc_contract(self):
        api_text = (ROOT / "src" / "api.ts").read_text(encoding="utf-8")
        api_rpcs = sorted(set(re.findall(r'callable\s*<[\s\S]*?>\s*\(\s*"([^"]+)"\s*\)', api_text)))
        self.assertGreater(len(api_rpcs), 30, "expected to parse callable() RPC names from src/api.ts")

        main_source = (ROOT / "main.py").read_text(encoding="utf-8")
        tree = ast.parse(main_source)
        plugin_cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Plugin")
        plugin_methods = {
            node.name: node
            for node in plugin_cls.body
            if isinstance(node, ast.AsyncFunctionDef) and not node.name.startswith("_")
        }

        # 1. Every RPC invoked by src/api.ts must exist as a public async method on main.Plugin.
        missing_in_main = [rpc for rpc in api_rpcs if rpc not in plugin_methods]
        self.assertEqual(missing_in_main, [], f"src/api.ts calls RPCs missing from main.py: {missing_in_main}")

        # 2. Every public method on main.Plugin must delegate to a real async method on OptiScalerService
        #    with compatible arity.
        for name, node in sorted(plugin_methods.items()):
            service_calls = [
                call.func.attr
                for call in ast.walk(node)
                if isinstance(call, ast.Call)
                and isinstance(call.func, ast.Attribute)
                and isinstance(call.func.value, ast.Attribute)
                and isinstance(call.func.value.value, ast.Name)
                and call.func.value.value.id == "self"
                and call.func.value.attr == "service"
            ]
            self.assertTrue(service_calls, f"main.Plugin.{name} does not delegate to self.service")
            target_name = service_calls[0]
            svc_method = getattr(OptiScalerService, target_name, None)
            self.assertIsNotNone(svc_method, f"OptiScalerService.{target_name} missing for main.Plugin.{name}")
            self.assertTrue(
                inspect.iscoroutinefunction(svc_method),
                f"OptiScalerService.{target_name} must be async for main.Plugin.{name}",
            )
            plugin_params = [a.arg for a in node.args.args[1:]]
            svc_sig = inspect.signature(svc_method)
            svc_params = [p for p in list(svc_sig.parameters.values())[1:]
                          if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)]
            svc_required = [p for p in svc_params if p.default is inspect.Parameter.empty]
            self.assertGreaterEqual(
                len(plugin_params), len(svc_required),
                f"main.Plugin.{name} passes too few args for OptiScalerService.{target_name}",
            )
            self.assertLessEqual(
                len(plugin_params), len(svc_params),
                f"main.Plugin.{name} accepts more args than OptiScalerService.{target_name}",
            )

    def test_plugin_prepare_payload_and_rpc_forwarding(self):
        main_mod = self._load_main_module()
        plugin = main_mod.Plugin()
        mock_service = MagicMock()
        plugin.service = mock_service

        # prepare_payload wraps ensure_payload success and error cleanly.
        mock_service.ensure_payload = AsyncMock(return_value="/tmp/runtime/0.9.5")
        ok = asyncio.run(plugin.prepare_payload(True))
        self.assertEqual(ok, {"ok": True, "path": "/tmp/runtime/0.9.5"})
        mock_service.ensure_payload.assert_awaited_once_with(True)

        mock_service.ensure_payload = AsyncMock(side_effect=RuntimeError("extract boom"))
        err = asyncio.run(plugin.prepare_payload(False))
        self.assertFalse(err["ok"])
        self.assertIn("extract boom", err["error"])

        # Exercise every other public RPC forwarder on main.Plugin dynamically.
        for name, member in inspect.getmembers(main_mod.Plugin, predicate=inspect.iscoroutinefunction):
            if name.startswith("_") or name == "prepare_payload":
                continue
            sentinel = {"forwarded": name}
            setattr(mock_service, name, AsyncMock(return_value=sentinel))
            sig = inspect.signature(member)
            required_args = [
                f"arg_{i}"
                for i, p in enumerate(list(sig.parameters.values())[1:])
                if p.default is inspect.Parameter.empty
            ]
            result = asyncio.run(getattr(plugin, name)(*required_args))
            self.assertEqual(result, sentinel, f"main.Plugin.{name} did not return forwarded result")
            getattr(mock_service, name).assert_awaited_once()


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    unittest.main()
