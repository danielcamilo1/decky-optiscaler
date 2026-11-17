#!/usr/bin/env python3
"""File-backed schema-7 live-control regression checks.

The fake native side reads the real command file and publishes real status
files. It exercises backend protocol and lifecycle behavior; it is not a
substitute for the Windows ASI, OptiScaler, Proton, or device validation.
"""

import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py_modules"))

from optiscaler import constants, installer, live  # noqa: E402


def digest(data):
    return hashlib.sha256(data).hexdigest()


def hash_tree(root):
    """Capture regular files and mode bits for no-write assertions."""
    result = {}
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        files.sort()
        for name in files:
            path = Path(base) / name
            mode = path.lstat().st_mode
            result[path.relative_to(root).as_posix()] = (
                digest(path.read_bytes()), stat.S_IMODE(mode)
            )
    return result


def filesystem_state(root):
    """Capture every directory/file path, original bytes and permission mode."""
    root = Path(root)
    result = {".": ("dir", stat.S_IMODE(root.lstat().st_mode))}
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        files.sort()
        for name in dirs:
            path = Path(base) / name
            result[path.relative_to(root).as_posix()] = (
                "dir", stat.S_IMODE(path.lstat().st_mode)
            )
        for name in files:
            path = Path(base) / name
            result[path.relative_to(root).as_posix()] = (
                "file", digest(path.read_bytes()), stat.S_IMODE(path.lstat().st_mode)
            )
    return result


class FileNativeEmulator:
    """A small protocol peer that consumes files instead of mocking live.py."""

    def __init__(self, target):
        self.target = Path(target)
        self.prefix = self.target.parent.parent / "plugin" / "wineprefix"
        self.drive_root = self.target.parent.parent
        self.session = "emulator-session-1"
        self.seq = "0"
        self.ack = "none"
        self.pending = False
        self.confirmed = []
        self.failed = []
        self.behavior = "config_request_accepted"
        self.api = "dx12"
        self.generation = "0123456789abcdef"
        self.directory_generation = 1
        self.result_directory_generation = "0"
        self.request = {"session": "", "api": "unknown", "generation": ""}
        self.fg_enabled = True
        self.capability_overrides = {}
        self.fg_ids = ["1", "2"]
        self.upscaler_ids = ["100", "200"]
        self.upscaler_restart_ids = []
        self.backends = {"dx12": "fsr31", "dx11": "fsr31", "vulkan": "fsr31"}
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._seen = None
        self._thread = None
        self.error = None
        self._error_reported = False

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if self.error is not None:
                self._error_reported = True
                raise AssertionError("file emulator worker failed") from self.error
            report = live.status(self.target, self.source, self.plugin_root)
            if report.get("ready"):
                return
            time.sleep(0.02)
        raise AssertionError("file emulator did not publish its ready heartbeat")

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        if self.error is not None and not self._error_reported:
            self._error_reported = True
            raise AssertionError("file emulator worker failed") from self.error

    @property
    def plugin_root(self):
        return self.target.parent.parent / "plugin"

    @property
    def source(self):
        return self.plugin_root / "bin" / live.ASI_NAME

    def set_behavior(self, behavior):
        with self._lock:
            self.behavior = behavior

    def set_api(self, api, generation, fg_ids=None, upscaler_ids=None,
                upscaler_restart_ids=None):
        with self._lock:
            self.api = api
            self.generation = generation
            if fg_ids is not None:
                self.fg_ids = list(fg_ids)
            if upscaler_ids is not None:
                self.upscaler_ids = list(upscaler_ids)
            if upscaler_restart_ids is not None:
                self.upscaler_restart_ids = list(upscaler_restart_ids)

    def set_backend(self, api, code):
        with self._lock:
            self.backends[api] = code

    def set_capabilities(self, **capabilities):
        with self._lock:
            self.capability_overrides.update({
                key: "1" if value is True else "0" if value is False else str(value)
                for key, value in capabilities.items()
            })

    def set_fg_enabled(self, enabled):
        with self._lock:
            self.fg_enabled = bool(enabled)

    def set_session(self, session):
        with self._lock:
            self.session = session
            self.seq = "0"
            self.ack = "none"
            self.result_directory_generation = "0"
            self.pending = False
            self.confirmed = []
            self.failed = []
            self.behavior = "config_request_accepted"

    def reject_pending_after_reauthorization(self, generation):
        with self._lock:
            self.generation = generation
            self.ack = "rejected"
            self.pending = False
            self.confirmed = []
            self.failed = ["Menu.ShowFps"]
            self.result_directory_generation = str(self.directory_generation)
        self._publish()

    def settle_pending(self):
        command = self.target / live.CMD_FILE
        lines = command.read_text(encoding="utf-8").splitlines()
        headers = dict(line.split(" ", 1) for line in lines[:5])
        with self._lock:
            self.session = headers["session"]
            self.seq = headers["seq"]
            self.request = dict(headers)
            self.ack = "config_request_accepted"
            self.pending = False
            self.result_directory_generation = str(self.directory_generation)
            self.confirmed = self._accepted_keys(lines[5:], headers["api"])
            self.failed = []
        self._publish()

    def context(self):
        report = live.status(self.target, self.source, self.plugin_root)
        return {
            "target": report["dir"],
            "session": report["session"],
            "active_api": report["active_api"],
            "capability_generation": report["capability_generation"],
        }

    def _accepted_keys(self, lines, api):
        confirmed = []
        member_to_key = {
            field.member: key for key, field in live.LIVE_FIELDS.items()
            if field.action is None
        }
        for line in lines:
            parts = line.split(" ")
            if parts[0] == "set" and len(parts) == 4:
                key = member_to_key.get(parts[1])
                if key:
                    confirmed.append(key)
            elif parts[0] == "backend" and len(parts) == 2:
                if self._backend_supported(api, parts[1]):
                    confirmed.append(live.BACKEND_KEY_BY_API[api])
            elif parts[0] == "fgindex" and len(parts) == 2:
                try:
                    if 0 <= int(parts[1]) < len(self.fg_ids):
                        confirmed.append(live.FFX_FG_ID)
                except ValueError:
                    pass
            elif parts[0] == "ffxupscaler" and len(parts) == 2:
                try:
                    if 0 <= int(parts[1]) < len(self.upscaler_ids):
                        confirmed.append(live.FFX_UPSCALER_ID)
                except ValueError:
                    pass
        return confirmed

    def _expected_keys(self, lines, api):
        expected = []
        member_to_key = {
            field.member: key for key, field in live.LIVE_FIELDS.items()
            if field.action is None
        }
        for line in lines:
            parts = line.split(" ")
            if parts[0] == "set" and len(parts) == 4:
                key = member_to_key.get(parts[1])
                if key:
                    expected.append(key)
            elif parts[0] == "backend" and len(parts) == 2:
                key = live.BACKEND_KEY_BY_API.get(api)
                if key:
                    expected.append(key)
            elif parts[0] == "fgindex" and len(parts) == 2:
                expected.append(live.FFX_FG_ID)
            elif parts[0] == "ffxupscaler" and len(parts) == 2:
                expected.append(live.FFX_UPSCALER_ID)
        return expected

    def _backend_supported(self, api, code):
        api_id = {"dx11": 1, "dx12": 2, "vulkan": 3}.get(api)
        if api_id is None:
            return False
        profile_path = self.plugin_root / "defaults" / constants.LIVE_PROFILE_FILE
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        entries = profile.get("backend_types", [])
        if not isinstance(entries, list):
            return False
        return any(
            isinstance(entry, dict)
            and type(entry.get("api")) is int
            and entry.get("api") == api_id
            and entry.get("code") == code
            for entry in entries
        )

    def _publish(self):
        with self._lock:
            data = {
                "session": self.session,
                "seq": self.seq,
                "request": dict(self.request),
                "ack": self.ack,
                "command_pending": "1" if self.pending else "0",
                "accepted_keys": "|".join(self.confirmed),
                "failed_keys": "|".join(self.failed),
                "api": self.api,
                "generation": self.generation,
                "fg_ids": "|".join(self.fg_ids),
                "upscaler_ids": "|".join(self.upscaler_ids),
                "upscaler_restart_ids": "|".join(self.upscaler_restart_ids),
                "backends": dict(self.backends),
                "directory_generation": self.directory_generation,
                "result_directory_generation": self.result_directory_generation,
                "fg_enabled": self.fg_enabled,
                "capability_overrides": dict(self.capability_overrides),
            }
        values = [
            ("schema", str(constants.LIVE_SCHEMA)), ("status", "ready"),
            ("session", data["session"]), ("seq", data["seq"]),
            ("directory_generation", str(data["directory_generation"])),
            ("result_directory_generation", data["result_directory_generation"]),
            ("request_session", data["request"]["session"]),
            ("request_api", data["request"]["api"]),
            ("request_generation", data["request"]["generation"]),
            ("ack", data["ack"]), ("accepted_count", str(len(data["accepted_keys"].split("|")) if data["accepted_keys"] else 0)),
            ("accepted_keys", data["accepted_keys"]), ("failed_keys", data["failed_keys"]),
            ("command_pending", data["command_pending"]),
            ("asi_build", constants.LIVE_BUILD_ID),
            ("abi_profile", constants.LIVE_PROFILE_ID),
            ("core_sha256", constants.LIVE_CORE_SHA256), ("core_valid", "1"),
            ("frame_ready", "1"), ("dir_verified", "1"),
            ("wine_prefix", str(self.prefix)),
            ("active_api", data["api"]),
            ("capability_generation", data["generation"]),
            ("dir", "\\\\?\\Z:" + self.target.as_posix().replace("/", "\\\\")),
            ("fps", "0"), ("frames", "0"), ("backend_entries", "2"),
            ("fg_enabled", "1" if data["fg_enabled"] else "0"),
            ("configured_fg_enabled", "1"),
            ("configured_fg_index", "0"), ("configured_ffx_upscaler_index", "0"),
            ("configured_dx12_upscaler", data["backends"]["dx12"]),
            ("configured_dx11_upscaler", data["backends"]["dx11"]),
            ("configured_vulkan_upscaler", data["backends"]["vulkan"]),
            ("dx12_upscaler", data["backends"]["dx12"]),
            ("dx11_upscaler", data["backends"]["dx11"]),
            ("vulkan_upscaler", data["backends"]["vulkan"]),
            ("pending_backend", ""), ("fgflags", "1"), ("fg_index", "0"),
            ("ffx_fg_versions", "FSR FG A|FSR FG B"),
            ("ffx_fg_ids", data["fg_ids"]), ("ffx_upscaler_index", "0"),
            ("ffx_upscaler_versions", "FSR 3.1.5|FSR 4.1.1"),
            ("ffx_upscaler_ids", data["upscaler_ids"]),
            ("ffx_upscaler_restart_ids", data["upscaler_restart_ids"]),
            ("rendered_ms", "0"), ("presented_ms", "0"), ("error", ""),
            ("telemetry_ready", "0"), ("telemetry_source", "unknown"),
            ("feature_progress_age_ms", "-1"),
            ("can_set_scalar", "1"), ("can_switch_upscaler", "1"),
            ("can_override_sharpness", "1"),
            ("switchable_backends", "|".join(code for code in live.BACKEND_CODES
                if code != "dlssd" and not (data["api"] == "dx11" and code == "xess")
                and self._backend_supported(data["api"], code))),
            ("can_change_fg", "1"), ("can_enable_fg", "1"),
            ("can_change_fg_version", "1"),
            ("can_change_ffx_upscaler", "1"), ("can_change_xefg_count", "1"),
            ("can_change_opti_fg", "1"), ("can_change_hud_fix", "1"),
            ("can_change_fsr_debug_view", "1"),
            ("can_reset_auto", "0"),
        ]
        values = [
            (key, data["capability_overrides"].get(key, value))
            for key, value in values
        ]
        path = self.target / live.STATUS_TEMP_FILE
        # Match GetFinalPathNameByHandleW's usual output: one separator after
        # the drive root, including the extended DOS form.
        game_suffix = self.target.relative_to(self.drive_root).as_posix().replace("/", chr(92))
        windows_dir = "\\\\?\\Z:" + chr(92) + game_suffix
        values = [
            (key, windows_dir if key == "dir" else value)
            for key, value in values
        ]
        path.write_text("".join(f"{key} {value}\n" for key, value in values), encoding="utf-8")
        os.replace(path, self.target / live.STATUS_FILE)

    def _consume(self):
        command = self.target / live.CMD_FILE
        if not command.is_file():
            return
        try:
            text = command.read_text(encoding="utf-8")
        except OSError:
            return
        lines = text.splitlines()
        if len(lines) < 6:
            return
        headers = dict(line.split(" ", 1) for line in lines[:5])
        identity = (headers.get("session"), headers.get("seq"))
        if identity == self._seen:
            return
        self._seen = identity
        operations = lines[5:]
        with self._lock:
            self.ack = "pending"
            self.seq = headers["seq"]
            self.request = dict(headers)
            self.result_directory_generation = "0"
            self.confirmed = []
            self.failed = []
            self.pending = True
            behavior = self.behavior
            api = headers.get("api", "unknown")
        self._publish()
        if behavior == "pending":
            return
        time.sleep(0.02)
        with self._lock:
            expected = self._expected_keys(operations, api)
            if behavior == "rejected":
                self.ack = "rejected"
                self.confirmed = []
                self.failed = expected
            else:
                confirmed = self._accepted_keys(operations, api)
                self.confirmed = confirmed
                self.failed = [key for key in expected if key not in confirmed]
                self.ack = "rejected" if self.failed else "config_request_accepted"
            self.result_directory_generation = str(self.directory_generation)
            self.pending = False
        self._publish()

    def _run(self):
        try:
            while not self._stop.is_set():
                self._consume()
                self._publish()
                self._stop.wait(0.08)
        except BaseException as exc:
            self.error = exc
            self._stop.set()


class LiveFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="decky-live-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plugin_root = self.root / "plugin"
        self.target = self.root / "library" / "Test Game"
        (self.plugin_root / "defaults").mkdir(parents=True)
        (self.plugin_root / "bin").mkdir()
        self.prefix = self.plugin_root / "wineprefix"
        (self.prefix / "dosdevices").mkdir(parents=True)
        (self.prefix / "dosdevices" / "z:").symlink_to(self.root, target_is_directory=True)
        (self.target / live.PLUGIN_SUBDIR).mkdir(parents=True)
        shutil.copy2(ROOT / "defaults" / constants.LIVE_PROFILE_FILE,
                     self.plugin_root / "defaults" / constants.LIVE_PROFILE_FILE)
        profile_path = self.plugin_root / "defaults" / constants.LIVE_PROFILE_FILE
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        # Keep the real ABI identity and give the file emulator several polling
        # turns to acknowledge commands under a loaded CI host.
        profile["limits"]["callback_timeout_ms"] = 1000
        profile_path.write_text(json.dumps(profile, indent=2), encoding="utf-8")

        self.asi_bytes = b"test-only schema 7 ASI artifact\0"
        self.source = self.plugin_root / "bin" / live.ASI_NAME
        self.source.write_bytes(self.asi_bytes)
        self.asi_hash = digest(self.asi_bytes)
        build = {
            "schema": constants.LIVE_SCHEMA,
            "build_id": constants.LIVE_BUILD_ID,
            "profile_id": constants.LIVE_PROFILE_ID,
            "sha256": self.asi_hash,
        }
        (self.plugin_root / "defaults" / constants.LIVE_BUILD_FILE).write_text(
            json.dumps(build, indent=2), encoding="utf-8"
        )

        self.runtime_bytes = b"test-only pinned core file"
        self.runtime_hash = digest(self.runtime_bytes)
        self.core = self.target / "dxgi.dll"
        self.core.write_bytes(self.runtime_bytes)
        self.ini_bytes = b"[Plugins]\nLoadAsiPlugins=false\n\n[General]\nKeep=1\n"
        self.ini = self.target / constants.INI_NAME
        self.ini.write_bytes(self.ini_bytes)
        os.chmod(self.ini, 0o640)
        self.backup = self.target / constants.BACKUP_DIR
        self.backup.mkdir()
        shutil.copy2(self.ini, self.backup / constants.INI_NAME)
        self.live_asi = live.asi_path(self.target)
        shutil.copy2(self.source, self.live_asi)
        os.chmod(self.live_asi, 0o640)
        files = ["dxgi.dll", constants.INI_NAME,
                 f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}", *live.CONTROL_FILES]
        manifest = {
            "plugin": "decky-optiscaler", "filename": "dxgi.dll",
            "optiscaler_version": constants.OPTISCALER_VERSION,
            "files": files, "dirs": [],
            "backups": {constants.INI_NAME: constants.INI_NAME},
            "runtime_artifacts_owned": [], "created_directories": [],
            "original_directories": {}, "backup_dir": constants.BACKUP_DIR,
            "live_asi": True, "live_asi_sha256": self.asi_hash,
            "live_build_id": constants.LIVE_BUILD_ID,
            "live_profile_id": constants.LIVE_PROFILE_ID,
            "live_schema": constants.LIVE_SCHEMA,
            "live_core_sha256": constants.LIVE_CORE_SHA256,
        }
        (self.target / constants.MANIFEST_NAME).write_text(
            json.dumps(manifest, indent=2), encoding="utf-8"
        )
        self.core_patch = patch.object(constants, "RUNTIME_DLL_SHA256", self.runtime_hash)
        self.core_patch.start()
        self.addCleanup(self.core_patch.stop)
        root_patch = patch.object(live, "_plugin_root", return_value=self.plugin_root)
        root_patch.start()
        self.addCleanup(root_patch.stop)

    def emulator(self):
        peer = FileNativeEmulator(self.target)
        self.addCleanup(peer.stop)
        peer.start()
        return peer

    def wait_for_status(self, predicate, timeout=2.0):
        deadline = time.monotonic() + timeout
        latest = None
        while time.monotonic() < deadline:
            latest = live.status(self.target, self.source, self.plugin_root)
            if predicate(latest):
                return latest
            time.sleep(0.01)
        raise AssertionError(f"live status did not reach the expected state: {latest!r}")


class LiveStatusAndProtocolTests(LiveFixture):
    def test_installed_but_not_started_is_supported_and_not_ready(self):
        report = live.status(self.target, self.source, self.plugin_root)
        self.assertTrue(report["supported"])
        self.assertFalse(report["ready"])
        self.assertEqual(report["state"], "disconnected")
        result = live.apply_changes(self.target, [
            {"section": "FrameGen", "key": "Enabled", "value": "true"}
        ], source=self.source, plugin_root=self.plugin_root)
        self.assertFalse(result["sent"])
        self.assertEqual(result["sent_keys"], [])
        self.assertIsNone(result["context"])
        self.assertIn("FrameGen.Enabled", result["deferred"])
        self.assertFalse((self.target / live.CMD_FILE).exists())

    def test_scalar_and_dynamic_changes_require_native_file_ack(self):
        peer = self.emulator()
        report = live.status(self.target, self.source, self.plugin_root)
        self.assertTrue(report["ready"])
        self.assertEqual(report["dir"], str(self.target.resolve()))
        self.assertTrue(report["native_dir"].startswith("\\\\?\\Z:"))
        self.assertIsNone(report["fps"], "a zero source counter is unknown, not 0 FPS")

        scalar = live.apply_changes(self.target, [
            {"section": "Sharpness", "key": "Sharpness", "value": "0.35"}
        ], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(scalar["sent"], repr(scalar))
        self.assertTrue(scalar["confirmed"], repr(scalar))
        self.assertEqual(scalar["ack"], "config_request_accepted")
        self.assertRegex(scalar["seq"], r"^[0-9]+$")
        self.assertEqual(scalar["accepted_keys"], ["Sharpness.Sharpness"])
        self.assertEqual(scalar["sent_keys"], ["Sharpness.Sharpness"])
        self.assertEqual(scalar["context"], {
            "target": str(self.target.resolve()),
            "session": "emulator-session-1",
            "active_api": "dx12",
            "capability_generation": "0123456789abcdef",
        })
        command = (self.target / live.CMD_FILE).read_text(encoding="utf-8")
        self.assertIn("schema 7\n", command)
        self.assertIn("session emulator-session-1\n", command)
        self.assertIn("api unknown\ngeneration 0123456789abcdef\n", command)

        context = peer.context()
        dynamic = live.apply_changes(self.target, [{
            "section": "Upscalers", "key": "Dx12Upscaler", "value": "xess",
            "live_context": context,
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(dynamic["confirmed"], repr(dynamic))
        self.assertEqual(dynamic["accepted_keys"], ["Upscalers.Dx12Upscaler"])
        self.assertEqual(dynamic["sent_keys"], ["Upscalers.Dx12Upscaler"])
        self.assertEqual(dynamic["context"], context)
        command = (self.target / live.CMD_FILE).read_text(encoding="utf-8")
        self.assertIn("api dx12\n", command)
        self.assertIn(f"generation {context['capability_generation']}\n", command)

        ffg = live.apply_changes(self.target, [{
            "section": "FSR", "key": "FGIndex", "value": "1",
            "live_context": peer.context(),
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(ffg["confirmed"])
        self.assertEqual(ffg["accepted_keys"], ["FSR.FGIndex"])

        # A receipt retains its request identity when current capabilities change.
        peer.set_api("dx12", "fedcba9876543210")
        self.wait_for_status(lambda status:
                             status["capability_generation"] == "fedcba9876543210")
        changed = live.status(self.target, self.source, self.plugin_root)
        self.assertEqual(changed["ack"], "config_request_accepted")
        self.assertEqual(changed["accepted_keys"], ["FSR.FGIndex"])

    def test_receipts_require_original_identity_and_exact_keys_and_count(self):
        peer = self.emulator()
        result = live.apply_changes(self.target, [{
            "section": "Menu", "key": "ShowFps", "value": "true",
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(result["confirmed"], result)
        peer.stop()
        path = self.target / live.STATUS_FILE
        original = path.read_text()
        command = (self.target / live.CMD_FILE).read_bytes()
        for key, value in (
            ("accepted_count", "0"),
            ("accepted_keys", "Menu.ShowFps|Menu.ShowFps"),
            ("accepted_keys", "Menu.ShowFps|Sharpness.Sharpness"),
            ("request_generation", "ffffffffffffffff"),
            ("request_api", "vulkan"),
        ):
            with self.subTest(key=key, value=value):
                path.write_text("\n".join(
                    f"{key} {value}" if line.startswith(key + " ") else line
                    for line in original.splitlines()) + "\n")
                self.assertIsNone(live.status(self.target, self.source, self.plugin_root)["ack"])
                next_result = live.apply_changes(self.target, [{
                    "section": "Menu", "key": "ShowFps", "value": "false",
                }], source=self.source, plugin_root=self.plugin_root)
                self.assertFalse(next_result["sent"], next_result)
                self.assertEqual((self.target / live.CMD_FILE).read_bytes(), command)
        path.write_text(original)

    def test_verified_unknown_api_session_still_accepts_scalar_commands(self):
        peer = self.emulator()
        generation = "abcdef0123456789"
        peer.set_api("unknown", generation)
        self.wait_for_status(lambda report: report["ready"]
                             and report["active_api"] == "unknown"
                             and report["capability_generation"] == generation)

        result = live.apply_changes(self.target, [{
            "section": "Menu", "key": "ShowFps", "value": "true",
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(result["confirmed"], repr(result))
        self.assertEqual(result["accepted_keys"], ["Menu.ShowFps"])
        command = (self.target / live.CMD_FILE).read_text(encoding="utf-8")
        self.assertIn("api unknown\n", command)
        self.assertIn(f"generation {generation}\n", command)

    def test_fg_activation_gate_does_not_block_safe_disable_or_scalars(self):
        peer = self.emulator()
        peer.set_capabilities(can_change_fg=True, can_enable_fg=False)
        peer.set_fg_enabled(False)
        self.wait_for_status(lambda report: report["ready"]
                             and report["fg_enabled"] is False
                             and report["can_change_fg"] is True
                             and report["can_enable_fg"] is False)

        mixed = live.apply_changes(self.target, [
            {"section": "FrameGen", "key": "Enabled", "value": "true"},
            {"section": "Menu", "key": "ShowFps", "value": "true"},
        ], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(mixed["confirmed"], repr(mixed))
        self.assertEqual(mixed["accepted_keys"], ["Menu.ShowFps"])
        self.assertEqual(mixed["deferred"], ["FrameGen.Enabled"])
        command = (self.target / live.CMD_FILE).read_text(encoding="utf-8")
        self.assertNotIn("set FGEnabled ", command)
        self.assertIn("set ShowFps ", command)

        peer.set_fg_enabled(True)
        self.wait_for_status(lambda report: report["fg_enabled"] is True)
        disabled = live.apply_changes(self.target, [
            {"section": "FrameGen", "key": "Enabled", "value": "false"},
        ], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(disabled["confirmed"], repr(disabled))
        self.assertEqual(disabled["accepted_keys"], ["FrameGen.Enabled"])

    def test_extended_and_plain_dos_paths_use_the_actual_wine_drive_mapping(self):
        suffix = self.target.relative_to(self.root).as_posix().replace("/", chr(92))
        extended = r"\\?\Z:" + chr(92) + suffix
        normal = "Z:" + chr(92) + suffix
        self.assertTrue(live._same_dir(extended, self.target, str(self.prefix)))
        self.assertTrue(live._same_dir(normal, self.target, str(self.prefix)))
        self.assertIsNone(live._same_dir(
            r"\\?\UNC\server\share\game", self.target, str(self.prefix)
        ))
        self.assertIsNone(live._same_dir(
            r"\\?\Volume{1234}\game", self.target, str(self.prefix)
        ))
        for relative in (r"Z:folder", "Z:", r"\\?\Z:", r"\\?\Z:folder"):
            self.assertIsNone(live._same_dir(relative, self.target, str(self.prefix)))
        self.assertIsNone(live._same_dir(extended, self.target, "relative-prefix"))

        wrong_prefix = self.root / "wrong-prefix"
        mapped_root = self.root / "other-z-drive"
        (wrong_prefix / "dosdevices").mkdir(parents=True)
        (wrong_prefix / "dosdevices" / "z:").symlink_to(mapped_root, target_is_directory=True)
        mapped_root.joinpath(*suffix.split(chr(92))).mkdir(parents=True)
        self.assertFalse(live._same_dir(extended, self.target, str(wrong_prefix)))

    def test_directory_generation_must_be_positive_uint64(self):
        self.assertEqual(live._directory_generation("1"), 1)
        self.assertEqual(live._directory_generation(str(live.MAX_UINT64)), live.MAX_UINT64)
        for value in (None, "", "0", "-1", "+1", "1.0", str(live.MAX_UINT64 + 1)):
            self.assertIsNone(live._directory_generation(value), value)
        self.assertEqual(live._directory_generation("0", allow_zero=True), 0)
        self.assertIsNone(live._directory_generation("-1", allow_zero=True))
        self.assertIsNone(live._directory_generation(-1, allow_zero=True))

    def test_missing_or_zero_directory_generation_never_makes_live_ready(self):
        peer = self.emulator()
        peer.stop()
        status_path = self.target / live.STATUS_FILE
        original = status_path.read_text(encoding="utf-8")
        for replacement in (None, "0"):
            with self.subTest(generation=replacement):
                lines = [line for line in original.splitlines()
                         if not line.startswith("directory_generation ")]
                if replacement is not None:
                    lines.append(f"directory_generation {replacement}")
                status_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
                report = live.status(self.target, self.source, self.plugin_root)
                self.assertIsNone(report["directory_generation"])
                self.assertFalse(report["ready"])
                sent = live.apply_changes(self.target, [{
                    "section": "Menu", "key": "ShowFps", "value": "true",
                }], source=self.source, plugin_root=self.plugin_root)
                self.assertFalse(sent["sent"])
                self.assertFalse((self.target / live.CMD_FILE).exists())

    def test_per_key_capabilities_filter_hudfixextended_without_dragging_valid_scalars(self):
        peer = self.emulator()
        peer.set_capabilities(can_change_hud_fix=False, can_change_opti_fg=True)
        self.wait_for_status(lambda status: status["ready"]
                             and status["can_change_hud_fix"] is False
                             and status["can_change_opti_fg"] is True)
        report = live.status(self.target, self.source, self.plugin_root)
        self.assertFalse(report["capabilities"]["OptiFG.HUDFixExtended"])
        self.assertTrue(report["capabilities"]["OptiFG.MakeDepthCopy"])

        mixed = live.apply_changes(self.target, [
            {"section": "OptiFG", "key": "HUDFixExtended", "value": "false"},
            {"section": "OptiFG", "key": "MakeDepthCopy", "value": "false"},
            {"section": "Sharpness", "key": "Sharpness", "value": "0.45"},
        ], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(mixed["confirmed"], repr(mixed))
        self.assertEqual(
            mixed["accepted_keys"], ["OptiFG.MakeDepthCopy", "Sharpness.Sharpness"]
        )
        self.assertEqual(mixed["deferred"], ["OptiFG.HUDFixExtended"])
        command = (self.target / live.CMD_FILE).read_text(encoding="utf-8")
        self.assertNotIn("set FGHUDFixExtended ", command)

    def test_ready_fg_configuration_is_independent_of_actual_fg_activity(self):
        peer = self.emulator()
        peer.set_fg_enabled(False)
        self.wait_for_status(lambda status: status["ready"]
                             and status["fg_enabled"] is False)

        disabled_off = live.apply_changes(self.target, [
            {"section": "FrameGen", "key": "DebugView", "value": "false"},
            {"section": "Sharpness", "key": "Sharpness", "value": "0.40"},
        ], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(disabled_off["confirmed"], repr(disabled_off))
        self.assertEqual(
            disabled_off["accepted_keys"], ["FrameGen.DebugView", "Sharpness.Sharpness"]
        )

        disabled_on = live.apply_changes(self.target, [
            {"section": "FrameGen", "key": "DebugView", "value": "true"},
            {"section": "Sharpness", "key": "Sharpness", "value": "0.50"},
        ], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(disabled_on["confirmed"], repr(disabled_on))
        self.assertEqual(disabled_on["accepted_keys"], ["FrameGen.DebugView", "Sharpness.Sharpness"])
        self.assertEqual(disabled_on["deferred"], [])

        companion = live.apply_changes(self.target, [
            {"section": "FrameGen", "key": "Enabled", "value": "true"},
            {"section": "FrameGen", "key": "DebugView", "value": "true"},
            {"section": "OptiFG", "key": "HUDFixExtended", "value": "true"},
            {"section": "OptiFG", "key": "MakeDepthCopy", "value": "false"},
        ], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(companion["confirmed"], repr(companion))
        self.assertEqual(companion["accepted_keys"], [
            "FrameGen.Enabled", "FrameGen.DebugView",
            "OptiFG.HUDFixExtended", "OptiFG.MakeDepthCopy",
        ])

    def test_dynamic_context_rejects_api_change_and_equal_length_reorder(self):
        peer = self.emulator()
        old = peer.context()
        before = (self.target / live.CMD_FILE).read_bytes() if (self.target / live.CMD_FILE).exists() else None
        peer.set_api("dx11", "1111111111111111")
        self.wait_for_status(lambda report: report["active_api"] == "dx11"
                             and report["capability_generation"] == "1111111111111111")
        stale_api = live.apply_changes(self.target, [{
            "section": "Upscalers", "key": "Dx12Upscaler", "value": "xess",
            "live_context": old,
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertFalse(stale_api["sent"])
        self.assertIn("Upscalers.Dx12Upscaler", stale_api["deferred"])
        current = live.status(self.target, self.source, self.plugin_root)
        self.assertEqual(current["active_api"], "dx11")
        self.assertEqual(len(current["ffx_upscaler_ids"]), len(peer.upscaler_ids))

        peer.set_api("dx12", "2222222222222222", upscaler_ids=["200", "100"])
        self.wait_for_status(lambda report: report["active_api"] == "dx12"
                             and report["capability_generation"] == "2222222222222222"
                             and report["ffx_upscaler_ids"] == ["200", "100"])
        reordered = live.status(self.target, self.source, self.plugin_root)
        self.assertEqual(reordered["ffx_upscaler_ids"], ["200", "100"])
        self.assertEqual(len(reordered["ffx_upscaler_ids"]), 2)
        stale_generation = live.switch_backend(
            self.target, "xess_12", old, self.source, self.plugin_root
        )
        self.assertFalse(stale_generation["sent"])
        after = (self.target / live.CMD_FILE).read_bytes() if (self.target / live.CMD_FILE).exists() else None
        self.assertEqual(after, before)

    def test_backend_selection_must_exist_for_active_api(self):
        peer = self.emulator()
        cases = (
            ("dx12", "Upscalers.Dx12Upscaler", "fsr31_12"),
            ("dx11", "Upscalers.Dx11Upscaler", "fsr21"),
            ("vulkan", "Upscalers.VulkanUpscaler", "xess_12"),
        )
        for index, (api, key, code) in enumerate(cases, start=1):
            generation = f"{index:x}" * 16
            peer.set_api(api, generation)
            self.wait_for_status(lambda report, api=api, generation=generation:
                                 report["active_api"] == api
                                 and report["capability_generation"] == generation)
            context = peer.context()
            before = ((self.target / live.CMD_FILE).read_bytes()
                      if (self.target / live.CMD_FILE).exists() else None)

            applied = live.apply_changes(self.target, [{
                "section": key.split(".")[0], "key": key.split(".")[1],
                "value": code, "live_context": context,
            }], source=self.source, plugin_root=self.plugin_root)
            self.assertFalse(applied["sent"], repr(applied))
            self.assertIn(key, applied["deferred"], repr(applied))

            switched = live.switch_backend(
                self.target, code, context, self.source, self.plugin_root
            )
            self.assertFalse(switched["sent"], repr(switched))
            self.assertIn(key, switched["deferred"], repr(switched))
            after = ((self.target / live.CMD_FILE).read_bytes()
                     if (self.target / live.CMD_FILE).exists() else None)
            self.assertEqual(after, before)

    def test_vulkan_version_requests_use_the_reported_ordered_list(self):
        peer = self.emulator()
        generation = "3333333333333333"
        peer.set_api(
            "vulkan", generation,
            upscaler_ids=["9001", "100"],
            upscaler_restart_ids=["9001"],
        )
        peer.set_backend("vulkan", "fsr31")
        self.wait_for_status(lambda report: report["active_api"] == "vulkan"
                             and report["capability_generation"] == generation
                             and report["ffx_upscaler_ids"] == ["9001", "100"])
        context = peer.context()

        blocked = live.apply_changes(self.target, [
            {"section": "FSR", "key": "UpscalerIndex", "value": "0",
             "live_context": context},
            {"section": "Sharpness", "key": "Sharpness", "value": "0.45"},
        ], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(blocked["confirmed"], repr(blocked))
        self.assertEqual(blocked["deferred"], [], repr(blocked))
        self.assertEqual(set(blocked["accepted_keys"]), {"Sharpness.Sharpness", live.FFX_UPSCALER_ID})

        sdk = live.apply_changes(self.target, [{
            "section": "FSR", "key": "UpscalerIndex", "value": "1",
            "live_context": context,
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(sdk["confirmed"], repr(sdk))
        self.assertEqual(sdk["accepted_keys"], [live.FFX_UPSCALER_ID])

    def test_ffx_indexes_must_exist_and_same_batch_backend_must_remain_ffx(self):
        peer = self.emulator()
        context = peer.context()
        out_of_range = live.apply_changes(self.target, [
            {"section": "FSR", "key": "FGIndex", "value": "5",
             "live_context": context},
            {"section": "FSR", "key": "UpscalerIndex", "value": "5",
             "live_context": context},
            {"section": "Menu", "key": "ShowFps", "value": "true"},
        ], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(out_of_range["confirmed"], repr(out_of_range))
        self.assertEqual(out_of_range["accepted_keys"], ["Menu.ShowFps"])
        self.assertIn(live.FFX_FG_ID, out_of_range["deferred"])
        self.assertIn(live.FFX_UPSCALER_ID, out_of_range["deferred"])

        peer.set_backend("dx12", "fsr31")
        same_batch = live.apply_changes(self.target, [
            {"section": "Upscalers", "key": "Dx12Upscaler", "value": "xess",
             "live_context": context},
            {"section": "FSR", "key": "UpscalerIndex", "value": "1",
             "live_context": context},
        ], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(same_batch["confirmed"], repr(same_batch))
        self.assertEqual(same_batch["accepted_keys"], ["Upscalers.Dx12Upscaler"])
        self.assertEqual(same_batch["deferred"], [live.FFX_UPSCALER_ID])

    def test_live_preflight_and_send_entry_both_block_unsafe_paths(self):
        peer = self.emulator()
        renamed = self.target / live.PLUGIN_SUBDIR / "old-live-copy.asi"
        shutil.copy2(self.source, renamed)
        current = live.status(self.target, self.source, self.plugin_root)
        self.assertTrue(current["ready"])
        self.assertFalse(current["live_write_safe"])
        self.assertFalse(current["capabilities"]["switch_upscaler"])
        before = ((self.target / live.CMD_FILE).read_bytes()
                  if (self.target / live.CMD_FILE).exists() else None)
        switch = live.switch_backend(
            self.target, "xess", peer.context(), self.source, self.plugin_root
        )
        self.assertFalse(switch["sent"])
        self.assertEqual(switch["sent_keys"], [])
        self.assertIsNone(switch["context"])
        after = ((self.target / live.CMD_FILE).read_bytes()
                 if (self.target / live.CMD_FILE).exists() else None)
        self.assertEqual(after, before)

        renamed.unlink()
        alias = self.target / live.CMD_FILE.upper()
        alias.write_bytes(b"occupied alias")
        (self.target / live.CMD_FILE).write_bytes(b"canonical occupant")
        current = live.status(self.target, self.source, self.plugin_root)
        self.assertFalse(current["live_write_safe"])
        switch = live.switch_backend(
            self.target, "xess", peer.context(), self.source, self.plugin_root
        )
        self.assertFalse(switch["sent"])

    def test_send_rechecks_path_preflight_and_keeps_every_deferred_key(self):
        peer = self.emulator()
        with patch.object(live, "_live_write_preflight", return_value=(False, "unsafe")):
            blocked = live.apply_changes(self.target, [{
                "section": "Menu", "key": "ShowFps", "value": "true",
            }], source=self.source, plugin_root=self.plugin_root)
        self.assertFalse(blocked["sent"])
        self.assertEqual(blocked["deferred"], ["Menu.ShowFps"])
        self.assertEqual(blocked["sent_keys"], [])
        self.assertIsNone(blocked["context"])

        with patch.object(live, "_write_command", side_effect=OSError("disk full")):
            write_failed = live.apply_changes(self.target, [
                {"section": "Menu", "key": "ShowFps", "value": "true"},
                {"section": "FSR", "key": "FGIndex", "value": "5",
                 "live_context": peer.context()},
            ], source=self.source, plugin_root=self.plugin_root)
        self.assertFalse(write_failed["sent"])
        self.assertIn("Menu.ShowFps", write_failed["deferred"])
        self.assertIn(live.FFX_FG_ID, write_failed["deferred"])

        peer.set_behavior("pending")
        pending = live.apply_changes(self.target, [{
            "section": "Menu", "key": "ShowFps", "value": "true",
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(pending["sent"])
        waiting = live.apply_changes(self.target, [
            {"section": "Menu", "key": "ShowFps", "value": "false"},
            {"section": "FSR", "key": "FGIndex", "value": "5",
             "live_context": peer.context()},
        ], source=self.source, plugin_root=self.plugin_root)
        self.assertFalse(waiting["sent"])
        self.assertIn("Menu.ShowFps", waiting["deferred"])
        self.assertIn(live.FFX_FG_ID, waiting["deferred"])

    def test_hardlinked_command_temp_does_not_modify_the_user_file(self):
        user_file = self.root / "user-owned.txt"
        original = b"user bytes that must remain unchanged"
        user_file.write_bytes(original)
        temp = self.target / live.CMD_TEMP_FILE
        os.link(user_file, temp)
        self.emulator()

        result = live.apply_changes(self.target, [{
            "section": "Menu", "key": "ShowFps", "value": "true",
        }], source=self.source, plugin_root=self.plugin_root)

        self.assertTrue(result["sent"], result)
        self.assertEqual(user_file.read_bytes(), original)
        command = self.target / live.CMD_FILE
        self.assertNotEqual(user_file.stat().st_ino, command.stat().st_ino)

    def test_pending_timeout_does_not_allow_command_overwrite_until_session_changes(self):
        peer = self.emulator()
        peer.set_behavior("pending")
        first = live.apply_changes(self.target, [{
            "section": "Menu", "key": "ShowFps", "value": "true"
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(first["sent"])
        self.assertEqual(first["ack"], "timeout")
        self.assertFalse(first["confirmed"])
        original = (self.target / live.CMD_FILE).read_bytes()
        second = live.apply_changes(self.target, [{
            "section": "Menu", "key": "ShowFps", "value": "false"
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertFalse(second["sent"])
        self.assertEqual((self.target / live.CMD_FILE).read_bytes(), original)

        peer.settle_pending()
        self.wait_for_status(lambda report: report["session"] == first["session"]
                             and report["seq"] == first["seq"]
                             and report["ack"] == "config_request_accepted")
        peer.set_behavior("config_request_accepted")
        late_terminal = live.apply_changes(self.target, [{
            "section": "Menu", "key": "ShowFps", "value": "false"
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(late_terminal["confirmed"], repr(late_terminal))
        self.assertEqual(late_terminal["session"], "emulator-session-1")

        peer.set_behavior("pending")
        pending_again = live.apply_changes(self.target, [{
            "section": "Menu", "key": "ShowFps", "value": "true"
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(pending_again["sent"])
        self.assertEqual(pending_again["ack"], "timeout")

        peer.set_session("emulator-session-2")
        self.wait_for_status(lambda report: report["session"] == "emulator-session-2"
                             and report["ack"] is None)
        third = live.apply_changes(self.target, [{
            "section": "Menu", "key": "ShowFps", "value": "false"
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(third["confirmed"])
        self.assertEqual(third["session"], "emulator-session-2")

    def test_late_reauthorization_rejection_is_terminal_but_never_applied(self):
        peer = self.emulator()
        peer.set_behavior("pending")
        sent = live.apply_changes(self.target, [{
            "section": "Menu", "key": "ShowFps", "value": "true"
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(sent["sent"])
        self.assertEqual(sent["ack"], "timeout")

        peer.reject_pending_after_reauthorization("abcdef0123456789")
        self.wait_for_status(lambda status: status["active_api"] == "dx12"
                             and status["capability_generation"] == "abcdef0123456789"
                             and status["ack"] == "rejected")
        terminal = live.status(self.target, self.source, self.plugin_root)
        self.assertEqual(terminal["seq"], sent["seq"])
        self.assertEqual(terminal["ack"], "rejected")
        self.assertEqual(terminal["accepted_keys"], [])
        self.assertIn("Menu.ShowFps", terminal["failed_keys"])
        self.assertEqual(terminal["result_directory_generation"], "1")

        peer.set_behavior("config_request_accepted")
        next_command = live.apply_changes(self.target, [{
            "section": "Menu", "key": "ShowFps", "value": "false"
        }], source=self.source, plugin_root=self.plugin_root)
        self.assertTrue(next_command["confirmed"], repr(next_command))
        self.assertNotEqual(next_command["seq"], sent["seq"])

    def test_schema_profile_maps_exactly_fourteen_keys(self):
        profile = live._profile(self.plugin_root)
        self.assertIsNotNone(profile)
        self.assertEqual(list(live.LIVE_FIELDS), profile["live_keys"])
        self.assertEqual(len(live.LIVE_FIELDS), 14)
        self.assertEqual(live.LIVE_FIELDS["FrameGen.Enabled"].member, "FGEnabled")
        self.assertEqual(live.LIVE_FIELDS["FSR.FGIndex"].member, "FfxFGIndex")
        self.assertEqual(live.LIVE_FIELDS["FSR.UpscalerIndex"].member, "FfxUpscalerIndex")
        self.assertEqual(live.LIVE_FIELDS["Upscalers.Dx12Upscaler"].wire_type, "str")
        with self.assertRaises(ValueError):
            live.LIVE_FIELDS["FrameGen.Enabled"].encode("auto")


class LiveInstallLifecycleTests(LiveFixture):
    def test_unknown_same_name_hash_and_custom_ini_fail_without_writes(self):
        before = hash_tree(self.target)
        ini = self.ini.read_text(encoding="utf-8")
        self.ini.write_text(ini + "\n[Plugins]\nPath=custom_plugins\n", encoding="utf-8")
        after_user_change = hash_tree(self.target)
        with self.assertRaisesRegex(ValueError, "Plugins.Path is custom"):
            installer.install_live_component(
                self.target, self.source, plugin_root=self.plugin_root
            )
        self.assertEqual(hash_tree(self.target), after_user_change)
        self.ini.write_bytes(self.ini_bytes)
        self.live_asi.write_bytes(b"unknown same-name ASI")
        unknown_before = hash_tree(self.target)
        report = live.status(self.target, self.source, self.plugin_root)
        self.assertFalse(report["supported"])
        with self.assertRaisesRegex(ValueError, "unknown bytes"):
            installer.install_live_component(
                self.target, self.source, plugin_root=self.plugin_root
            )
        self.assertEqual(hash_tree(self.target), unknown_before)
        self.assertNotEqual(before, after_user_change)

    def test_os_exit_during_staged_ini_write_recovers_complete_target_tree(self):
        before = filesystem_state(self.target)
        child = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from optiscaler import constants, installer, live
live._plugin_root = lambda: Path(sys.argv[2]).resolve().parent.parent / "plugin"
constants.RUNTIME_DLL_SHA256 = sys.argv[4]
original = installer.atomic_copy
def crash_after_stage(source, destination, target_dir=None):
    source = Path(source)
    if "live-ini-staging" in source.parts and source.name == constants.INI_NAME:
        assert b"LoadAsiPlugins=true" in source.read_bytes()
        os._exit(73)
    return original(source, destination, target_dir=target_dir)
installer.atomic_copy = crash_after_stage
installer.install_live_component(sys.argv[2], sys.argv[3], plugin_root=sys.argv[5])
'''
        result = subprocess.run(
            [sys.executable, "-c", child, str(ROOT / "py_modules"),
             str(self.target), str(self.source), self.runtime_hash,
             str(self.plugin_root)],
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(result.returncode, 73, result.stderr)
        self.assertTrue(any(path.name.startswith(installer.TRANSACTION_PREFIX)
                            for path in self.target.iterdir()))
        recovered = installer.recover_target_transactions(self.target)
        self.assertTrue(any(entry["action"] == "rolled_back" for entry in recovered))
        self.assertEqual(filesystem_state(self.target), before)

    def test_managed_ini_recovery_keeps_its_intent_if_recovery_is_interrupted(self):
        before = filesystem_state(self.target)
        mutate = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from optiscaler import constants, installer, live
live._plugin_root = lambda: Path(sys.argv[2]).resolve().parent.parent / "plugin"
with installer.target_transaction(
        sys.argv[2], extra_names=(constants.INI_NAME, constants.MANIFEST_NAME),
        include_known=False, intent=installer.TRANSACTION_INTENT_MANAGED_INI):
    installer.atomic_copy(sys.argv[3], Path(sys.argv[2]) / constants.INI_NAME,
                          target_dir=sys.argv[2])
    os._exit(73)
'''
        crashed = subprocess.run(
            [sys.executable, "-c", mutate, str(ROOT / "py_modules"),
             str(self.target), str(self.source)],
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(crashed.returncode, 73, crashed.stderr)

        interrupt_recovery = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from optiscaler import installer, live
live._plugin_root = lambda: Path(sys.argv[2]).resolve().parent.parent / "plugin"
original = installer._copy_path
def stop_after_stage(source, destination):
    if Path(destination).name.startswith(installer.TRANSACTION_COPY_PREFIX):
        os._exit(74)
    return original(source, destination)
installer._copy_path = stop_after_stage
installer.recover_target_transactions(sys.argv[2])
'''
        interrupted = subprocess.run(
            [sys.executable, "-c", interrupt_recovery, str(ROOT / "py_modules"),
             str(self.target)],
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(interrupted.returncode, 74, interrupted.stderr)
        journals = [
            path for path in self.target.iterdir()
            if path.name.startswith(installer.TRANSACTION_PREFIX)
        ]
        self.assertEqual(len(journals), 1)
        journal = journals[0]
        record = json.loads((journal / installer.TRANSACTION_RECORD).read_text())
        self.assertEqual(record["intent"], installer.TRANSACTION_INTENT_MANAGED_INI)
        installer.recover_target_transactions(self.target)
        self.assertEqual(filesystem_state(self.target), before)

    def test_legacy_normal_false_journal_cannot_recover_binary_while_game_is_running(self):
        journal = self.target / f"{installer.TRANSACTION_PREFIX}legacy-normal"
        entries = journal / "entries"
        entries.mkdir(parents=True)
        saved_core = entries / "000000"
        saved_core.write_bytes(b"core before interrupted normal transaction")
        self.core.write_bytes(b"core changed after interrupted normal transaction")
        record = {
            "version": installer.TRANSACTION_LEGACY_VERSION,
            "target": str(self.target.resolve()),
            "status": "active",
            "require_stopped": False,
            "intent": installer.TRANSACTION_INTENT_NORMAL,
            "records": [{"name": "dxgi.dll", "exists": True, "stored": "000000"}],
        }
        (journal / installer.TRANSACTION_RECORD).write_text(json.dumps(record))

        with patch.object(live, "status", return_value={
                "attached": True, "legacy_running": False}):
            with self.assertRaisesRegex(RuntimeError, "Close the game"):
                installer.recover_target_transactions(self.target)
        self.assertEqual(
            self.core.read_bytes(), b"core changed after interrupted normal transaction"
        )

        with patch.object(live, "status", return_value={
                "attached": False, "legacy_running": False}):
            recovered = installer.recover_target_transactions(self.target)
        self.assertTrue(any(item["action"] == "rolled_back" for item in recovered))
        self.assertEqual(
            self.core.read_bytes(), b"core before interrupted normal transaction"
        )

    def test_known_legacy_upgrade_and_remove_restore_exact_file_baseline(self):
        legacy = b"fake 0.9.4 legacy ASI bytes"
        legacy_hash = digest(legacy)
        manifest = installer.read_manifest(self.target)
        manifest["files"] = [
            name for name in manifest["files"]
            if name not in (f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}", *live.CONTROL_FILES)
        ]
        manifest["live_asi"] = False
        for key in ("live_asi_sha256", "live_build_id", "live_profile_id",
                    "live_schema", "live_core_sha256"):
            manifest.pop(key, None)
        (self.target / constants.MANIFEST_NAME).write_text(
            json.dumps(manifest, indent=2), encoding="utf-8"
        )
        self.live_asi.write_bytes(legacy)
        os.chmod(self.live_asi, 0o620)
        target_mode = stat.S_IMODE(self.target.stat().st_mode)
        plugin_dir = self.target / live.PLUGIN_SUBDIR
        plugin_dir_mode = stat.S_IMODE(plugin_dir.stat().st_mode)
        old_command = self.target / live.CMD_FILE
        old_command.write_bytes(b"user baseline command file\n")
        os.chmod(old_command, 0o600)
        baseline_ini = self.ini.read_bytes()
        baseline_ini_mode = stat.S_IMODE(self.ini.stat().st_mode)
        old_command_mode = stat.S_IMODE(old_command.stat().st_mode)

        with patch.object(constants, "LEGACY_LIVE_ASI_SHA256", legacy_hash), \
                patch.object(live, "known_asi_sha256", lambda plugin_root=None: self.asi_hash):
            installed = installer.install_live_component(
                self.target, self.source, plugin_root=self.plugin_root
            )
            self.assertTrue(installed["installed"])
            self.assertEqual(digest(self.live_asi.read_bytes()), self.asi_hash)
            manifest = installer.read_manifest(self.target)
            self.assertTrue(manifest["live_asi"])
            self.assertTrue(set(live.CONTROL_FILES).issubset(manifest["files"]))
            self.assertIn(f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}", manifest["backups"])
            self.assertIn(live.CMD_FILE, manifest["backups"])
            self.assertTrue(live.load_enabled(self.target))

            removed = installer.uninstall(self.target)
            self.assertEqual(
                set(removed), {"path", "removed", "restored", "backup_dir"}
            )
            self.assertEqual(removed["path"], str(self.target.resolve()))
            self.assertEqual(
                Path(removed["backup_dir"]).resolve(),
                (self.target / constants.BACKUP_DIR).resolve(),
            )
            self.assertIsInstance(removed["removed"], list)
            self.assertIn(constants.MANIFEST_NAME, removed["removed"])
            self.assertEqual(
                set(removed["restored"]),
                {
                    constants.INI_NAME,
                    f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}",
                    live.CMD_FILE,
                },
            )
            self.assertEqual((self.live_asi).read_bytes(), legacy)
            self.assertEqual(stat.S_IMODE(self.live_asi.stat().st_mode), 0o620)
            self.assertEqual(self.ini.read_bytes(), baseline_ini)
            self.assertEqual(stat.S_IMODE(self.ini.stat().st_mode), baseline_ini_mode)
            self.assertEqual(old_command.read_bytes(), b"user baseline command file\n")
            self.assertEqual(stat.S_IMODE(old_command.stat().st_mode), old_command_mode)
            self.assertEqual(
                filesystem_state(self.target),
                {
                    ".": ("dir", target_mode),
                    live.PLUGIN_SUBDIR: ("dir", plugin_dir_mode),
                    f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}": (
                        "file", digest(legacy), 0o620
                    ),
                    constants.INI_NAME: (
                        "file", digest(baseline_ini), baseline_ini_mode
                    ),
                    live.CMD_FILE: (
                        "file", digest(b"user baseline command file\n"), old_command_mode
                    ),
                },
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
