#!/usr/bin/env python3
"""Offline unit and integration tests for Adaptive FG and display refresh matching."""
import asyncio
import logging
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))
from optiscaler import adaptive_fg, constants, installer, live, sysinfo
from optiscaler.inifile import IniFile
from optiscaler.service import OptiScalerService

ROOT = Path(__file__).resolve().parents[1]


class DisplayRefreshTests(unittest.TestCase):
    def test_parse_xrandr_gamescope_oled_90hz(self):
        sample = (
            "Screen 0: minimum 320 x 200, current 1280 x 800, maximum 16384 x 16384\n"
            "XWAYLAND0 connected primary 1280x800+0+0 (normal left inverted right x axis y axis) 0mm x 0mm\n"
            "   1280x800      89.99*+\n"
            "   1280x800      60.00  \n"
        )
        hz, conn = sysinfo._parse_xrandr_refresh(sample)
        self.assertAlmostEqual(hz, 89.99, places=2)
        self.assertEqual(conn, "XWAYLAND0")

    def test_parse_xrandr_docked_120hz_and_fractional(self):
        sample = (
            "HDMI-A-1 connected 1920x1080+0+0\n"
            "   1920x1080    119.88*+  60.00    59.94\n"
        )
        hz, conn = sysinfo._parse_xrandr_refresh(sample)
        self.assertAlmostEqual(hz, 119.88, places=2)
        self.assertEqual(conn, "HDMI-A-1")

    def test_drm_fallback_reads_vrefresh_and_mode_at_hz(self):
        with tempfile.TemporaryDirectory() as tmp:
            drm = Path(tmp)
            conn1 = drm / "card0-eDP-1"
            conn1.mkdir()
            (conn1 / "status").write_text("connected\n")
            (conn1 / "vrefresh").write_text("90\n")
            hz, conn = sysinfo._drm_refresh(drm)
            self.assertEqual(hz, 90.0)
            self.assertEqual(conn, "card0-eDP-1")

            (conn1 / "vrefresh").unlink()
            (conn1 / "modes").write_text("1280x800@60\n1280x800@40\n")
            hz2, _ = sysinfo._drm_refresh(drm)
            self.assertEqual(hz2, 60.0)

    def test_display_info_unavailable_returns_clean_dict(self):
        with patch.object(sysinfo, "_xrandr_refresh", return_value=(None, None)), \
                patch.object(sysinfo, "_drm_refresh", return_value=(None, None)):
            info = sysinfo.display_info()
            self.assertFalse(info["available"])
            self.assertIsNone(info["refresh_hz"])


class AdaptiveFgControllerTests(unittest.TestCase):
    def _live(self, base_fps, fg_enabled=True, can_enable=True, can_xefg=True, session="s1"):
        return {
            "ready": True,
            "attached": True,
            "live_write_safe": True,
            "session": session,
            "base_fps": base_fps,
            "fg_enabled": fg_enabled,
            "capabilities": {
                "fg_enable": can_enable,
                "change_xefg_count": can_xefg,
            },
            "can_change_fg_enable": can_enable,
            "can_change_xefg_count": can_xefg,
        }

    def test_resolve_target_matches_display_and_falls_back_to_manual(self):
        cfg = adaptive_fg.normalize_config({"enabled": True, "match_refresh_rate": True, "target_fps": 60})
        r90 = adaptive_fg.resolve_target_fps(cfg, {"available": True, "refresh_hz": 90, "source": "xrandr"})
        self.assertEqual(r90["effective_target_fps"], 90)
        self.assertEqual(r90["target_source"], "display")
        self.assertFalse(r90["fallback_used"])

        r_none = adaptive_fg.resolve_target_fps(cfg, {"available": False, "refresh_hz": None, "source": None})
        self.assertEqual(r_none["effective_target_fps"], 60)
        self.assertEqual(r_none["target_source"], "manual")
        self.assertTrue(r_none["fallback_used"])

        cfg_manual = adaptive_fg.normalize_config({"enabled": True, "match_refresh_rate": False, "target_fps": 72})
        r_manual = adaptive_fg.resolve_target_fps(cfg_manual, {"available": True, "refresh_hz": 90, "source": "xrandr"})
        self.assertEqual(r_manual["effective_target_fps"], 72)
        self.assertEqual(r_manual["target_source"], "manual")
        self.assertFalse(r_manual["fallback_used"])

    def test_xefg_steps_up_to_3x_then_down_to_1x_with_hysteresis(self):
        ctrl = adaptive_fg.AdaptiveFgController()
        cfg = adaptive_fg.normalize_config({
            "enabled": True, "match_refresh_rate": True, "target_fps": 60,
            "max_multiplier": 4, "allow_1x": True,
        })
        disp = {"available": True, "refresh_hz": 90, "source": "xrandr"}

        # Base FPS is 32 at 2X (64 total < 90*0.94): needs 3X (96 >= 90*0.97).
        # Sample 1: warmup, no switch.
        _, ch = ctrl.evaluate("g1", cfg, self._live(32.0), disp, fg_output="xefg", current_xefg_count=1, now=0.0)
        self.assertEqual(ch, [])
        # Sample 2: starts pending hold window at t=1.0.
        _, ch = ctrl.evaluate("g1", cfg, self._live(32.0), disp, fg_output="xefg", current_xefg_count=1, now=1.0)
        self.assertEqual(ch, [])
        # Still inside 1.5s hold window at t=2.0 -> no switch yet.
        _, ch = ctrl.evaluate("g1", cfg, self._live(32.0), disp, fg_output="xefg", current_xefg_count=1, now=2.0)
        self.assertEqual(ch, [])
        # Past 1.5s hold window at t=2.6 -> steps up to 3X (InterpolationCount=2).
        st, ch = ctrl.evaluate("g1", cfg, self._live(32.0), disp, fg_output="xefg", current_xefg_count=1, now=2.6)
        self.assertEqual(ch, [{"section": "XeFG", "key": "InterpolationCount", "value": "2"}])
        self.assertEqual(st["desired_multiplier"], 3)

        # Now base FPS improves to 98 fps while at 2X -> should hold 3.5s before stepping down to 1X.
        for t in (5.0, 6.0, 7.0, 8.0, 9.0, 10.0):
            _, ch = ctrl.evaluate("g1", cfg, self._live(98.0), disp, fg_output="xefg", current_xefg_count=1, now=t)
            if ch:
                break
        # Let EMA settle above 90*1.05 = 94.5 and pass 3.5s hold.
        for t in (11.0, 12.0, 13.0, 14.0, 15.0, 16.0):
            st, ch = ctrl.evaluate("g1", cfg, self._live(100.0), disp, fg_output="xefg", current_xefg_count=1, now=t)
            if ch:
                break
        self.assertEqual(ch, [{"section": "FrameGen", "key": "Enabled", "value": "false"}])
        self.assertEqual(st["desired_multiplier"], 1)

    def test_allow_1x_false_never_disables_fg(self):
        ctrl = adaptive_fg.AdaptiveFgController()
        cfg = adaptive_fg.normalize_config({
            "enabled": True, "match_refresh_rate": False, "target_fps": 60,
            "max_multiplier": 2, "allow_1x": False,
        })
        for t in range(1, 15):
            _, ch = ctrl.evaluate("g2", cfg, self._live(90.0), None, fg_output="fsrfg", current_xefg_count=1, now=float(t))
            self.assertEqual(ch, [])

    def test_fsrfg_adapts_between_1x_and_2x_when_base_fps_dips(self):
        ctrl = adaptive_fg.AdaptiveFgController()
        cfg = adaptive_fg.normalize_config({
            "enabled": True, "match_refresh_rate": True, "target_fps": 60,
            "max_multiplier": 4, "allow_1x": True,
        })
        disp = {"available": True, "refresh_hz": 90, "source": "xrandr"}
        # Currently at 1X (fg_enabled=False), base FPS = 48 (< 90*0.94) -> enables 2X.
        changes = []
        for t in (0.0, 1.0, 2.0, 3.0):
            st, ch = ctrl.evaluate("g3", cfg, self._live(48.0, fg_enabled=False, can_xefg=False), disp, fg_output="fsrfg", now=t)
            if ch:
                changes = ch
                break
        self.assertEqual(changes, [{"section": "FrameGen", "key": "Enabled", "value": "true"}])
        self.assertEqual(st["max_supported_multiplier"], 2)


class AdaptiveFgServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.service = OptiScalerService(
            ROOT, self.root / "settings", self.root / "runtime",
            self.root / "home", logging.getLogger("test-adaptive"),
        )
        self.payload = asyncio.run(self.service.ensure_payload())
        self.target = self.root / "game"
        self.target.mkdir()
        (self.target / "game.exe").write_bytes(b"MZ fake")
        installed = asyncio.run(self.service.install(str(self.target), "dxgi.dll", game_path=str(self.target)))
        self.assertTrue(installed["ok"], installed)

    def test_set_adaptive_fg_persists_and_syncs_framerate_limit(self):
        with patch("optiscaler.service.display_info", return_value={
            "available": True, "refresh_hz": 90, "exact_hz": 90.0, "source": "xrandr", "connector": "eDP-1"
        }):
            res = asyncio.run(self.service.set_adaptive_fg(str(self.target), {
                "enabled": True,
                "match_refresh_rate": True,
                "target_fps": 60,
                "max_multiplier": 3,
                "cap_to_target": True,
            }))
            self.assertTrue(res["ok"], res)
            self.assertEqual(res["resolved"]["effective_target_fps"], 90)
            self.assertEqual(res["framerate_limit"], "90")
            self.assertEqual(IniFile(self.target / constants.INI_NAME).get("Framerate", "FramerateLimit"), "90")

            # Turning cap_to_target off restores FramerateLimit to auto.
            res2 = asyncio.run(self.service.set_adaptive_fg(str(self.target), {"cap_to_target": False}))
            self.assertTrue(res2["ok"], res2)
            self.assertEqual(IniFile(self.target / constants.INI_NAME).get("Framerate", "FramerateLimit"), "auto")

            # Uninstall clears stored adaptive preference.
            asyncio.run(self.service.uninstall(str(self.target)))
            after = asyncio.run(self.service.get_adaptive_fg(str(self.target)))
            self.assertFalse(after["config"]["enabled"])


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    unittest.main()
