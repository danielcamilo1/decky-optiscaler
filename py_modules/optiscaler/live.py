"""Schema-7 live control for the pinned OptiScaler 0.9.5 runtime.

The ASI and this module exchange bounded, newline-delimited files in the game
folder. A receipt confirms that the native menu path accepted a configuration request.
Runtime backend, FG state and telemetry are reported independently.
"""

import hashlib
import json
import math
import os
import re
import stat
import threading
import time
from pathlib import Path

from . import constants

ASI_NAME = "decky_optiscaler_live.asi"
PLUGIN_SUBDIR = "plugins"
CMD_FILE = "decky_optiscaler_live.cmd"
STATUS_FILE = "decky_optiscaler_live.status"
LOG_FILE = "decky_optiscaler_live.log"
CMD_TEMP_FILE = CMD_FILE + ".tmp"
STATUS_TEMP_FILE = STATUS_FILE + ".tmp"
LOG_TEMP_FILE = LOG_FILE + ".tmp"
CONTROL_FILES = (CMD_FILE, STATUS_FILE, LOG_FILE, CMD_TEMP_FILE,
                 STATUS_TEMP_FILE, LOG_TEMP_FILE)
STATUS_STALE_SECONDS = 20
MAX_UINT64 = (1 << 64) - 1
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
GENERATION_RE = re.compile(r"^[0-9a-fA-F]{16,64}$")
SEQ_RE = re.compile(r"^(?:0|[1-9][0-9]*)$")
API_NAMES = ("dx11", "dx12", "vulkan")
API_PROFILE_IDS = {"dx11": 1, "dx12": 2, "vulkan": 3}

BACKEND_CODES = (
    "xess", "xess_12", "fsr21", "fsr21_12", "fsr22", "fsr22_12",
    "fsr31", "fsr31_12", "dlss", "dlssd",
)
FFX_BACKENDS = ("fsr31", "fsr31_12")
FFX_FG_SECTION = "FSR"
FFX_FG_KEY = "FGIndex"
FFX_FG_ID = f"{FFX_FG_SECTION}.{FFX_FG_KEY}"
FFX_FG_MAX = 16
FFX_UPSCALER_SECTION = "FSR"
FFX_UPSCALER_KEY = "UpscalerIndex"
FFX_UPSCALER_ID = f"{FFX_UPSCALER_SECTION}.{FFX_UPSCALER_KEY}"
FFX_UPSCALER_MAX = 16
SCALAR_KEYS = (
    "FrameGen.Enabled", "OptiFG.HUDFix", "FrameGen.DebugView",
    "OptiFG.MakeDepthCopy", "OptiFG.HUDFixExtended",
    "XeFG.InterpolationCount", "Sharpness.OverrideSharpness",
    "Sharpness.Sharpness", "Menu.ShowFps",
)
BACKEND_KEY_BY_API = {
    "dx11": "Upscalers.Dx11Upscaler",
    "dx12": "Upscalers.Dx12Upscaler",
    "vulkan": "Upscalers.VulkanUpscaler",
}
KEY_API = {key: api for api, key in BACKEND_KEY_BY_API.items()}


class LiveField:
    """One INI key the fixed ASI can apply without restarting the game."""

    def __init__(self, member, wire_type, encode, action=None):
        self.member = member
        self.wire_type = wire_type
        self.encode = encode
        self.action = action


def _bool(value):
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return "1"
    if text in ("0", "false", "no", "off"):
        return "0"
    raise ValueError(f"not a boolean live value: {value!r}")


def _int(value):
    text = str(value).strip()
    if not re.fullmatch(r"[+-]?[0-9]+", text):
        raise ValueError(f"not an integer live value: {value!r}")
    return str(int(text, 10))


def _float(value):
    number = float(str(value).strip())
    if not math.isfinite(number):
        raise ValueError(f"not a finite live value: {value!r}")
    return repr(number)


def _index(value, label, maximum):
    text = _int(value)
    index = int(text)
    if not 0 <= index < maximum:
        raise ValueError(f"not a {label} index: {value!r}")
    return text


def _fg_index(value):
    return _index(value, "FFX FG", FFX_FG_MAX)


def _ffx_upscaler_index(value):
    return _index(value, "FFX upscaler", FFX_UPSCALER_MAX)


def _backend(value):
    code = str(value).strip().lower()
    if code not in BACKEND_CODES:
        raise ValueError(f"not an OptiScaler backend id: {value!r}")
    return code


def _backend_supported(code, api, plugin_root=None):
    """Whether the pinned runtime has this backend implementation for an API."""
    api_id = API_PROFILE_IDS.get(api)
    profile = _profile(plugin_root)
    entries = profile.get("backend_types") if profile else None
    if api_id is None or not isinstance(entries, list):
        return False
    return any(
        isinstance(entry, dict)
        and type(entry.get("api")) is int
        and entry.get("api") == api_id
        and entry.get("code") == code
        for entry in entries
    )


LIVE_FIELDS = {
    "FrameGen.Enabled": LiveField("FGEnabled", "bool", _bool),
    "OptiFG.HUDFix": LiveField("FGHUDFix", "bool", _bool),
    "FrameGen.DebugView": LiveField("FGDebugView", "bool", _bool),
    "OptiFG.MakeDepthCopy": LiveField("FGMakeDepthCopy", "bool", _bool),
    "OptiFG.HUDFixExtended": LiveField("FGHUDFixExtended", "bool", _bool),
    "XeFG.InterpolationCount": LiveField("FGXeFGInterpolationCount", "i32", _int),
    FFX_FG_ID: LiveField("FfxFGIndex", "i32", _fg_index, "change_fg_index"),
    FFX_UPSCALER_ID: LiveField(
        "FfxUpscalerIndex", "i32", _ffx_upscaler_index, "change_ffx_upscaler"
    ),
    "Upscalers.Dx11Upscaler": LiveField("Dx11Upscaler", "str", _backend, "switch_upscaler"),
    "Upscalers.Dx12Upscaler": LiveField("Dx12Upscaler", "str", _backend, "switch_upscaler"),
    "Upscalers.VulkanUpscaler": LiveField("VulkanUpscaler", "str", _backend, "switch_upscaler"),
    "Sharpness.OverrideSharpness": LiveField("OverrideSharpness", "bool", _bool),
    "Sharpness.Sharpness": LiveField("Sharpness", "f32", _float),
    "Menu.ShowFps": LiveField("ShowFps", "bool", _bool),
}


def is_live_key(section, key):
    return f"{section}.{key}" in LIVE_FIELDS


def asi_path(target_dir):
    return Path(target_dir) / PLUGIN_SUBDIR / ASI_NAME


def _control_path(target_dir, name):
    return Path(target_dir) / name


def installed(target_dir):
    return asi_path(target_dir).is_file()


def _plugin_root():
    # live.py -> optiscaler -> py_modules -> plugin root.
    return Path(__file__).resolve().parents[2]


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_json(path):
    path = Path(path)
    try:
        mode = path.lstat().st_mode
    except OSError:
        return None
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _profile(plugin_root=None):
    root = Path(plugin_root) if plugin_root is not None else _plugin_root()
    profile_path = root / "defaults" / constants.LIVE_PROFILE_FILE
    profile = _read_json(profile_path)
    if not profile:
        return None
    expected_keys = list(LIVE_FIELDS)
    if (profile.get("schema") != constants.LIVE_SCHEMA
            or profile.get("profile_id") != constants.LIVE_PROFILE_ID
            or profile.get("build_id") != constants.LIVE_BUILD_ID
            or profile.get("source_commit") != constants.LIVE_SOURCE_COMMIT
            or profile.get("core_sha256") != constants.LIVE_CORE_SHA256
            or profile.get("live_keys") != expected_keys):
        return None
    limits = profile.get("limits")
    if not isinstance(limits, dict):
        return None
    record = build_record(root)
    source_files = record.get("source_files") if record else None
    expected_hash = source_files.get(f"defaults/{constants.LIVE_PROFILE_FILE}") \
        if isinstance(source_files, dict) else None
    if expected_hash is not None:
        try:
            if _sha256(profile_path) != expected_hash:
                return None
        except OSError:
            return None
    return profile


def build_record(plugin_root=None):
    """Read the pinned build metadata without requiring the ASI artifact yet."""
    root = Path(plugin_root) if plugin_root is not None else _plugin_root()
    record = _read_json(root / "defaults" / constants.LIVE_BUILD_FILE)
    if not record:
        return None
    digest = record.get("sha256")
    if (record.get("schema") != constants.LIVE_SCHEMA
            or record.get("build_id") != constants.LIVE_BUILD_ID
            or record.get("profile_id") != constants.LIVE_PROFILE_ID
            or record.get("core_sha256", constants.LIVE_CORE_SHA256) != constants.LIVE_CORE_SHA256
            or not isinstance(digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", digest)):
        return None
    return record


def known_asi_sha256(plugin_root=None):
    record = build_record(plugin_root)
    return record.get("sha256") if record else None


def build_info(plugin_root=None, source=None):
    """Read and verify the build metadata and the exact packaged ASI bytes."""
    root = Path(plugin_root) if plugin_root is not None else _plugin_root()
    source_path = Path(source) if source is not None else root / "bin" / ASI_NAME
    record = build_record(plugin_root)
    if not record or not source_path.is_file() or source_path.is_symlink():
        return None
    digest = record["sha256"]
    try:
        actual = _sha256(source_path)
    except OSError:
        return None
    if actual != digest:
        return None
    return {**record, "path": str(source_path), "sha256": actual}


def validate_live_source(source, plugin_root=None):
    if not _profile(plugin_root):
        raise ValueError("The pinned schema-7 ABI profile is missing or invalid.")
    info = build_info(plugin_root, source)
    if not info:
        raise ValueError("The packaged live ASI does not match defaults/live-build.json.")
    return info


def asi_current(target_dir, source, plugin_root=None):
    """Whether the installed ASI matches the build hash recorded by the package."""
    installed_path = asi_path(target_dir)
    if not source:
        return None
    info = build_info(plugin_root, source)
    if not info:
        return False
    try:
        mode = installed_path.lstat().st_mode
        if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
            return False
        return _sha256(installed_path) == info["sha256"]
    except OSError:
        return None


def install_plugin_asi(target_dir, source, name, logger=None):
    """Install an ASI only after checking the live artifact's pinned identity."""
    if not isinstance(name, str) or not name or name in (".", "..") or "/" in name or "\\" in name:
        return {"ok": False, "error": f"invalid ASI filename: {name!r}"}
    source = Path(source)
    if not source.is_file() or source.is_symlink():
        return {"ok": False, "error": f"{name} missing at {source}"}
    if name == ASI_NAME:
        try:
            validate_live_source(source)
        except ValueError as exc:
            return {"ok": False, "error": str(exc), "supported": False}
    from .installer import atomic_copy, require_stopped_target

    target = Path(target_dir).resolve()
    destination = target / PLUGIN_SUBDIR / name
    require_stopped_target(target)
    destination.parent.mkdir(parents=True, exist_ok=True)
    atomic_copy(source, destination, target_dir=target)
    if logger:
        logger.info("installed %s at %s", name, destination)
    return {"ok": True, "path": str(destination)}


def install_asi(target_dir, source, logger=None):
    return install_plugin_asi(target_dir, source, ASI_NAME, logger)


def remove_asi(target_dir, logger=None, allow_owned_asi=False, owned_paths=()):
    """Remove only the live files a manifest proves this install owns."""
    from .installer import (
        _assert_known_live_asi, _existing_mode, _safe_path, _TRANSACTIONS,
        require_stopped_target, target_transaction,
    )

    target = Path(target_dir).resolve()
    if str(target) not in getattr(_TRANSACTIONS, "targets", {}):
        with target_transaction(target, extra_names=CONTROL_FILES, require_stopped=True):
            return remove_asi(target, logger, allow_owned_asi, owned_paths)
    require_stopped_target(target)
    owned = set(owned_paths or ())
    if allow_owned_asi:
        owned.add(f"{PLUGIN_SUBDIR}/{ASI_NAME}")
    removed = []
    managed = [(f"{PLUGIN_SUBDIR}/{ASI_NAME}", asi_path(target))]
    managed.extend((name, _safe_path(target, name)) for name in CONTROL_FILES)
    for relative, path in managed:
        if relative not in owned:
            continue
        mode = _existing_mode(path)
        if mode is None:
            continue
        if not stat.S_ISREG(mode):
            raise ValueError(f"refusing to remove non-file live-control path: {path}")
        if relative == f"{PLUGIN_SUBDIR}/{ASI_NAME}":
            _assert_known_live_asi(path)
        require_stopped_target(target)
        path.unlink()
        removed.append(relative)
    return {"ok": True, "removed": removed}


def ini_requirements():
    return [{"section": "Plugins", "key": "LoadAsiPlugins", "value": "true"}]


def load_enabled(target_dir):
    ini = Path(target_dir) / constants.INI_NAME
    if not ini.is_file():
        return None
    try:
        text = ini.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    section = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            continue
        if section != "Plugins" or "=" not in line or line.startswith((";", "#")):
            continue
        key, _, value = line.partition("=")
        if key.strip().lower() == "loadasiplugins":
            return value.strip().lower() in ("true", "1", "yes", "on")
    return False


def loaded_by_optiscaler(target_dir):
    log = Path(target_dir) / constants.LOG_NAME
    if not log.is_file():
        return None
    try:
        with log.open("r", encoding="utf-8", errors="replace") as handle:
            head = handle.read(400_000)
    except OSError:
        return None
    if ASI_NAME.lower() in head.lower():
        return True
    return False if "for *.asi" in head else None


def _parse_status(text):
    """Parse a one-value-per-line status document and reject duplicate keys."""
    out = {}
    for line_number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        key, sep, value = line.strip().partition(" ")
        if not key or key in out:
            raise ValueError(f"duplicate or empty live status key at line {line_number}")
        out[key] = value.strip() if sep else ""
    return out


def _number(text, cast, unknown=None):
    if text in (None, ""):
        return None
    try:
        value = cast(text)
    except (TypeError, ValueError, OverflowError):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return None if value == unknown else value


def _flag(raw, name):
    return {"1": True, "0": False}.get(raw.get(name))


def _split_pipe(value):
    if not value:
        return []
    return [item for item in value.split("|") if item]


def _valid_seq(value):
    if not isinstance(value, str) or not SEQ_RE.fullmatch(value):
        return False
    try:
        return int(value, 10) <= MAX_UINT64
    except ValueError:
        return False


def _directory_generation(value, allow_zero=False):
    """Parse the native directory epoch without treating missing as equality."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, str) and SEQ_RE.fullmatch(value):
        try:
            parsed = int(value, 10)
        except ValueError:
            return None
    else:
        return None
    if parsed < 0 or parsed > MAX_UINT64 or (parsed == 0 and not allow_zero):
        return None
    return parsed


def _raw_status(target_dir):
    path = _control_path(target_dir, STATUS_FILE)
    try:
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
            raise ValueError("live status path is not a regular file")
        raw = _parse_status(path.read_text(encoding="utf-8", errors="replace"))
        age = max(0.0, time.time() - path.stat().st_mtime)
        return raw, age, None
    except FileNotFoundError:
        return None, None, None
    except (OSError, ValueError) as exc:
        return None, None, str(exc)


def _frame_rates(fps, present_slot_ms, fg_slot_ms):
    if not fps or fps <= 0 or not present_slot_ms or not fg_slot_ms:
        return None, None
    if present_slot_ms <= 0 or fg_slot_ms <= 0:
        return None, None
    presented_ms, rendered_ms = sorted((present_slot_ms, fg_slot_ms))
    ratio = presented_ms / rendered_ms
    if ratio > 0.95:
        return round(fps, 1), round(fps, 1)
    counted_ms = 1000.0 / fps
    to_presented = abs(counted_ms - presented_ms) / presented_ms
    to_rendered = abs(counted_ms - rendered_ms) / rendered_ms
    if min(to_presented, to_rendered) > 0.30:
        return None, None
    if to_presented <= to_rendered:
        return round(fps * ratio, 1), round(fps, 1)
    return round(fps, 1), round(fps / ratio, 1)


def _same_dir(windows_path, target_dir, wine_prefix=None):
    """Resolve a Wine drive through this process's actual prefix mapping."""
    if not isinstance(windows_path, str) or not isinstance(wine_prefix, str) or not wine_prefix:
        return None
    windows_path = windows_path.strip()
    # Both DOS forms must include a root separator; ``Z:folder`` and ``Z:``
    # are drive-relative and cannot be resolved from the current directory.
    extended = re.fullmatch(r"\\\\\?\\([A-Za-z]):[\\/](.*)", windows_path)
    if extended:
        drive, suffix = extended.groups()
    else:
        # Do not accept extended UNC or volume paths: only DOS drive mappings
        # can be resolved faithfully through Proton's dosdevices directory.
        if windows_path.startswith("\\\\?\\"):
            return None
        match = re.fullmatch(r"([A-Za-z]):[\\/](.*)", windows_path)
        if not match:
            return None
        drive, suffix = match.groups()
    suffix = suffix or ""
    parts = [part for part in re.split(r"[\\/]", suffix) if part]
    if any(part in (".", "..") or ":" in part for part in parts):
        return None
    try:
        prefix_path = Path(wine_prefix)
        if not prefix_path.is_absolute():
            return None
        prefix = prefix_path.resolve(strict=True)
        if not prefix.is_dir():
            return None
        dosdevices = prefix / "dosdevices"
        if not dosdevices.is_dir():
            return None
        wanted = f"{drive.casefold()}:"
        matches = [entry for entry in dosdevices.iterdir()
                   if entry.name.casefold() == wanted]
        if len(matches) != 1:
            return None
        mapped_root = matches[0].resolve(strict=True)
        mapped = mapped_root.joinpath(*parts).resolve(strict=True)
        target = Path(target_dir).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return None
    return mapped.is_dir() and mapped == target


def _manifest_identity(target_dir, source, plugin_root=None):
    from . import installer

    info = build_info(plugin_root, source)
    profile = _profile(plugin_root)
    try:
        manifest = installer.read_manifest(target_dir)
    except (OSError, ValueError):
        return False, "The install manifest is missing or invalid.", info, False
    if not manifest:
        return False, "Set up this game with the plugin before using live control.", info, False
    if not installer.runtime_current(target_dir):
        return False, "This game does not have the pinned OptiScaler core.", info, False
    install_base_ready = bool(info and profile)
    expected_live = bool(info and profile)
    installed_hash = asi_current(target_dir, source, plugin_root)
    if not expected_live or installed_hash is not True:
        return False, "The live ASI is missing, unknown, or out of date.", info, install_base_ready
    if (not manifest.get("live_asi")
            or manifest.get("live_schema") != constants.LIVE_SCHEMA
            or manifest.get("live_asi_sha256") != info["sha256"]
            or manifest.get("live_build_id") != constants.LIVE_BUILD_ID
            or manifest.get("live_profile_id") != constants.LIVE_PROFILE_ID
            or manifest.get("live_core_sha256") != constants.LIVE_CORE_SHA256):
        return False, "The manifest does not identify the installed schema-7 live ASI.", info, install_base_ready
    required = {
        f"{PLUGIN_SUBDIR}/{ASI_NAME}", *CONTROL_FILES, constants.INI_NAME,
    }
    if not required.issubset(set(manifest.get("files", []))):
        return False, "The manifest does not own every live-control path.", info, install_base_ready
    return True, None, info, install_base_ready


def _live_control_preflight(target_dir, source, plugin_root, install_base_ready=True):
    """Return installability and live-write safety from one path preflight."""
    if not install_base_ready:
        return False, False, None
    try:
        from . import installer
        legacy = installer._preflight_live_control(
            target_dir, live_asi=source, plugin_root=plugin_root,
            reject_command_alias=False,
        )
    except (OSError, ValueError) as exc:
        return False, False, str(exc)
    if legacy:
        return True, False, "Upgrade the legacy live ASI while the game is stopped before sending live changes."
    try:
        installer._preflight_live_control(
            target_dir, live_asi=source, plugin_root=plugin_root,
            reject_command_alias=True,
        )
    except (OSError, ValueError) as exc:
        # A stopped install can adopt and preserve a single old mailbox alias;
        # the running bridge must not publish a second Wine-equivalent slot.
        return True, False, str(exc)
    return True, True, None


def _live_write_preflight(target_dir, source=None, plugin_root=None):
    """Recheck managed live-control paths before exposing or sending writes."""
    _, safe, error = _live_control_preflight(
        target_dir, source, plugin_root, install_base_ready=True
    )
    return safe, error


def _read_measurements(report, raw):
    report["telemetry_ready"] = raw.get("telemetry_ready") == "1"
    source = raw.get("telemetry_source", "unknown")
    report["telemetry_source"] = source if source in (
        "state_present_counter", "core_intervals", "unknown"
    ) else "unknown"
    report["feature_progress_age_ms"] = _number(
        raw.get("feature_progress_age_ms"), int, unknown=-1
    )
    report["fps"] = _number(raw.get("fps"), float)
    if report["fps"] is not None and report["fps"] <= 0:
        report["fps"] = None
    if not report["telemetry_ready"] or report["telemetry_source"] != "state_present_counter":
        report["fps"] = None
    report["frames"] = _number(raw.get("frames"), int)
    report["backend_entries"] = _number(raw.get("backend_entries"), int, unknown=-1)
    report["fg_enabled"] = _flag(raw, "fg_enabled")
    report["configured_fg_enabled"] = _flag(raw, "configured_fg_enabled")
    report["upscaler"] = {
        "dx12": raw.get("dx12_upscaler") or None,
        "dx11": raw.get("dx11_upscaler") or None,
        "vulkan": raw.get("vulkan_upscaler") or None,
    }
    report["pending_backend"] = raw.get("pending_backend") or None
    report["fg_index"] = _number(raw.get("fg_index"), int, unknown=-1)
    report["ffx_fg_versions"] = _split_pipe(raw.get("ffx_fg_versions"))
    report["ffx_fg_ids"] = _split_pipe(raw.get("ffx_fg_ids"))
    report["ffx_upscaler_versions"] = _split_pipe(raw.get("ffx_upscaler_versions"))
    report["ffx_upscaler_ids"] = _split_pipe(raw.get("ffx_upscaler_ids"))
    report["ffx_upscaler_index"] = _number(raw.get("ffx_upscaler_index"), int, unknown=-1)
    report["configured_fg_index"] = _number(
        raw.get("configured_fg_index"), int, unknown=-1
    )
    report["configured_ffx_upscaler_index"] = _number(
        raw.get("configured_ffx_upscaler_index"), int, unknown=-1
    )
    report["configured_upscaler"] = {
        "dx12": raw.get("configured_dx12_upscaler") or None,
        "dx11": raw.get("configured_dx11_upscaler") or None,
        "vulkan": raw.get("configured_vulkan_upscaler") or None,
    }
    report["rendered_ms"] = _number(raw.get("rendered_ms"), float, unknown=0.0)
    report["presented_ms"] = _number(raw.get("presented_ms"), float, unknown=0.0)
    if report["rendered_ms"] is not None and report["rendered_ms"] <= 0:
        report["rendered_ms"] = None
    if report["presented_ms"] is not None and report["presented_ms"] <= 0:
        report["presented_ms"] = None
    if not report["telemetry_ready"]:
        report["rendered_ms"] = None
        report["presented_ms"] = None
    report["base_fps"], report["total_fps"] = _frame_rates(
        report["fps"], report["presented_ms"], report["rendered_ms"]
    )
    report["present_path_fps"] = None
    if (report["telemetry_ready"] and report["telemetry_source"] == "core_intervals"
            and report["presented_ms"] and report["presented_ms"] > 0):
        report["present_path_fps"] = round(1000.0 / report["presented_ms"], 1)


def _capabilities(report, raw=None):
    raw = raw or {}
    ready = bool(report.get("ready") and report.get("live_write_safe") is True
                 and _directory_generation(report.get("directory_generation")) is not None)
    api_known = report.get("active_api") in API_NAMES
    scalar = ready and raw.get("can_set_scalar") == "1"
    report["switchable_backends"] = [code for code in _split_pipe(raw.get("switchable_backends"))
                                      if code in BACKEND_CODES]
    report["can_override_sharpness"] = scalar and raw.get("can_override_sharpness") == "1"
    switch = ready and api_known and raw.get("can_switch_upscaler") == "1" and bool(report["switchable_backends"])
    fg_change = ready and raw.get("can_change_fg") == "1"
    fg_can_enable = ready and raw.get("can_enable_fg") == "1"
    opti_fg = ready and raw.get("can_change_opti_fg") == "1"
    hud_fix = ready and raw.get("can_change_hud_fix") == "1"
    fg_scalar = scalar and (opti_fg or hud_fix)
    fsr_debug = ready and raw.get("can_change_fsr_debug_view") == "1"
    fg_ids = report.get("ffx_fg_ids", [])
    fg_versions = report.get("ffx_fg_versions", [])
    fg_version = (ready and api_known and raw.get("can_change_fg_version") == "1"
                  and bool(fg_ids) and len(fg_ids) == len(fg_versions))
    fg = fg_version
    upscaler_ids = report.get("ffx_upscaler_ids", [])
    upscaler_versions = report.get("ffx_upscaler_versions", [])
    ffx = (ready and api_known and raw.get("can_change_ffx_upscaler") == "1"
           and bool(upscaler_ids) and len(upscaler_ids) == len(upscaler_versions))
    xefg_available = ready and raw.get("can_change_xefg_count") == "1"
    xefg = xefg_available
    caps = {
        "set_scalar": bool(scalar),
        "switch_upscaler": bool(switch),
        "change_fg_index": bool(fg),
        "change_ffx_upscaler": bool(ffx),
        "reset_auto": raw.get("can_reset_auto") == "1" and ready,
        "fg_scalar": bool(fg_scalar),
        "fg_enable": bool(fg_can_enable),
        "fg_change": bool(fg_change),
        "can_change_opti_fg": bool(opti_fg),
        "can_change_hud_fix": bool(hud_fix),
        "fsr_debug_view": bool(fsr_debug),
        "change_xefg_count": bool(xefg),
    }
    for key in LIVE_FIELDS:
        if key == "FrameGen.Enabled":
            allowed = fg_change or fg_can_enable
        elif key == "OptiFG.HUDFix":
            allowed = scalar and hud_fix
        elif key == "FrameGen.DebugView":
            allowed = fsr_debug
        elif key == "OptiFG.MakeDepthCopy":
            allowed = scalar and opti_fg
        elif key == "OptiFG.HUDFixExtended":
            allowed = scalar and hud_fix
        elif key == "XeFG.InterpolationCount":
            allowed = scalar and xefg
        elif key == FFX_FG_ID:
            allowed = fg
        elif key == FFX_UPSCALER_ID:
            allowed = ffx
        elif key == "Sharpness.OverrideSharpness":
            allowed = report["can_override_sharpness"]
        elif key in SCALAR_KEYS:
            allowed = scalar
        else:
            api = KEY_API[key]
            allowed = switch and report.get("active_api") == api
        caps[key] = bool(allowed)
    report["capabilities"] = caps
    report["live_keys"] = [key for key in LIVE_FIELDS if caps.get(key)]
    report["can_switch_upscaler"] = bool(switch)
    report["can_set_scalar"] = bool(scalar)
    report["can_change_fg"] = bool(fg_change)
    report["can_enable_fg"] = bool(fg_can_enable)
    report["can_change_opti_fg"] = bool(opti_fg)
    report["can_change_hud_fix"] = bool(hud_fix)
    report["can_change_fg_scalar"] = bool(fg_scalar)
    report["can_change_fg_enable"] = bool(fg_change or fg_can_enable)
    report["can_change_fsr_debug_view"] = bool(ready and raw.get("can_change_fsr_debug_view") == "1")
    report["can_change_fg_version"] = bool(fg_version)
    report["can_change_xefg_count"] = bool(xefg_available)
    report["can_change_ffx_upscaler"] = bool(ffx)


def status(target_dir, source=None, plugin_root=None):
    """Return target support, live readiness, verified capabilities and telemetry."""
    target = Path(target_dir).resolve()
    if source is None:
        source = Path(plugin_root or _plugin_root()) / "bin" / ASI_NAME
    supported, identity_reason, _, install_base_ready = _manifest_identity(
        target, source, plugin_root
    )
    can_install, live_write_safe, live_write_error = _live_control_preflight(
        target, source, plugin_root, install_base_ready
    )
    path = _control_path(target, STATUS_FILE)
    report = {
        "supported": supported,
        "can_install": can_install,
        "capabilities": {
            "set_scalar": False, "switch_upscaler": False,
            "change_fg_index": False, "change_ffx_upscaler": False,
            "reset_auto": False, "fg_scalar": False,
            "fg_enable": False, "fsr_debug_view": False,
            "change_xefg_count": False,
            "can_change_opti_fg": False, "can_change_hud_fix": False,
            **{key: False for key in LIVE_FIELDS},
        },
        "reason": identity_reason,
        "asi_installed": installed(target),
        "asi_current": asi_current(target, source, plugin_root),
        "load_enabled": load_enabled(target),
        "loaded_by_optiscaler": loaded_by_optiscaler(target),
        "attached": False,
        "legacy_running": False,
        "ready": False,
        "state": "absent",
        "native_state": None,
        "error": None,
        "session": None,
        "seq": None,
        "ack": None,
        "command_pending": False,
        "accepted_count": None,
        "request_session": None,
        "request_api": None,
        "request_generation": None,
        "accepted_keys": [],
        "failed_keys": [],
        "schema": None,
        "asi_build": None,
        "abi_profile": None,
        "core_sha256": None,
        "core_valid": False,
        "frame_ready": False,
        "active_api": "unknown",
        "capability_generation": None,
        "directory_generation": None,
        "result_directory_generation": None,
        "dir_verified": False,
        "can_switch_upscaler": False,
        "can_set_scalar": False,
        "switchable_backends": [],
        "can_override_sharpness": False,
        "can_change_opti_fg": False,
        "can_change_hud_fix": False,
        "can_change_fg": False,
        "can_enable_fg": False,
        "can_change_fg_scalar": False,
        "can_change_fg_enable": False,
        "can_change_fsr_debug_view": False,
        "can_change_fg_version": False,
        "can_change_xefg_count": False,
        "can_change_ffx_upscaler": False,
        "live_write_safe": live_write_safe,
        "live_write_error": live_write_error,
        "can_reset_auto": False,
        "fg_index": None,
        "ffx_fg_versions": [],
        "ffx_fg_ids": [],
        "ffx_upscaler_index": None,
        "ffx_upscaler_versions": [],
        "ffx_upscaler_ids": [],
        "age": None,
        "fps": None,
        "frames": None,
        "backend_entries": None,
        "fg_enabled": None,
        "configured_fg_enabled": None,
        "configured_fg_index": None,
        "configured_ffx_upscaler_index": None,
        "configured_upscaler": None,
        "base_fps": None,
        "total_fps": None,
        "present_path_fps": None,
        "rendered_ms": None,
        "presented_ms": None,
        "telemetry_ready": False,
        "telemetry_source": "unknown",
        "feature_progress_age_ms": None,
        "upscaler": None,
        "pending_backend": None,
        "dir": None,
        "native_dir": None,
        "dir_matches": None,
        "live_keys": [],
    }
    raw, age, parse_error = _raw_status(path.parent)
    if parse_error:
        report["state"] = "unknown"
        report["error"] = parse_error
        return report
    if raw is None:
        if supported:
            report["state"] = "disconnected"
            report["reason"] = "The pinned live-control files are installed; waiting for this game to start."
        return report

    report["age"] = round(age, 1)
    schema = _number(raw.get("schema"), int)
    report["schema"] = schema
    native_state = raw.get("status", "unknown").lower()
    report["native_state"] = native_state
    report["state"] = native_state
    report["error"] = raw.get("error") or None
    report["session"] = raw.get("session") if SESSION_RE.fullmatch(raw.get("session", "")) else None
    report["asi_build"] = raw.get("asi_build") or None
    report["abi_profile"] = raw.get("abi_profile") or None
    report["core_sha256"] = (raw.get("core_sha256") or "").lower() or None
    report["core_valid"] = raw.get("core_valid") == "1"
    report["frame_ready"] = raw.get("frame_ready") == "1"
    report["dir_verified"] = raw.get("dir_verified") == "1"
    directory_generation = _directory_generation(raw.get("directory_generation"))
    report["directory_generation"] = str(directory_generation) if directory_generation is not None else None
    active_api = raw.get("active_api", "unknown").lower()
    report["active_api"] = active_api if active_api in API_NAMES else "unknown"
    generation = raw.get("capability_generation") or ""
    report["capability_generation"] = generation if GENERATION_RE.fullmatch(generation) else None
    if age >= STATUS_STALE_SECONDS:
        report["state"] = "disconnected"
        report["legacy_running"] = False
        report["reason"] = identity_reason if not supported else "Waiting for a fresh schema-7 heartbeat."
        return report

    reported_dir = raw.get("dir") or None
    report["native_dir"] = reported_dir
    report["can_reset_auto"] = raw.get("can_reset_auto") == "1"

    # Use the Wine prefix only after the heartbeat identifies the pinned ASI
    # and core. File contents under the target folder are not path authority.
    raw_identity = (
        supported
        and schema == constants.LIVE_SCHEMA
        and report["session"] is not None
        and report["asi_build"] == constants.LIVE_BUILD_ID
        and report["abi_profile"] == constants.LIVE_PROFILE_ID
        and report["core_sha256"] == constants.LIVE_CORE_SHA256
        and report["core_valid"]
    )
    wine_prefix = raw.get("wine_prefix") if raw_identity else None
    report["dir_matches"] = (
        _same_dir(reported_dir, target, wine_prefix) if reported_dir and wine_prefix else None
    )
    if report["dir_matches"] is True:
        report["dir"] = str(target)

    # Only expose acknowledgement fields for the exact sequence still present
    # in the mailbox. A late acknowledgement may reconcile its own pending
    # operation, but never carries keys forward to a newer command.
    command = None
    command_error = None
    try:
        command = _read_command_header(_control_path(target, CMD_FILE))
    except (OSError, ValueError) as exc:
        command_error = str(exc)
    raw_seq = raw.get("seq") if _valid_seq(raw.get("seq")) else None
    if raw_seq is not None:
        report["seq"] = raw_seq
    result_directory_generation = _directory_generation(
        raw.get("result_directory_generation"), allow_zero=True
    )
    report["result_directory_generation"] = str(result_directory_generation) if result_directory_generation is not None else None
    ack = _matching_receipt(raw, command)
    command_matches = bool(
        raw_identity and ack is not None and report["dir_matches"] is True
        and result_directory_generation is not None
        and (ack != "config_request_accepted" or (
            report["dir_verified"]
            and result_directory_generation == directory_generation
        ))
    )
    if command_matches:
        report["request_session"] = raw.get("request_session")
        report["request_api"] = raw.get("request_api")
        report["request_generation"] = raw.get("request_generation")
    report["command_pending"] = bool(
        raw.get("command_pending") == "1" or command_error is not None
        or (command and report["session"] == command.get("session")
            and command.get("seq") != raw_seq)
    )
    if command_matches:
        report["ack"] = ack
        if ack in ("config_request_accepted", "rejected"):
            report["accepted_count"] = _number(raw.get("accepted_count"), int)
            report["accepted_keys"] = _split_pipe(raw.get("accepted_keys"))
            if ack == "rejected":
                report["failed_keys"] = _split_pipe(raw.get("failed_keys"))
    if command_error:
        report["error"] = report["error"] or command_error

    if schema != constants.LIVE_SCHEMA:
        report["supported"] = False
        report["legacy_running"] = True
        # This heartbeat belongs to the legacy bridge. Keep its runtime guard
        # separate from `attached`, which describes a verified schema-7 ASI.
        report["attached"] = False
        report["state"] = "legacy"
        report["reason"] = "The running live ASI uses an older schema; reinstall schema-7 live control."
        return report

    if not raw_identity:
        report["supported"] = False
        report["state"] = "unsupported"
        report["reason"] = "The live heartbeat does not match this game's schema-7 runtime and ABI profile."
        return report
    if report["dir_matches"] is False:
        report["supported"] = False
        report["state"] = "wrongdir"
        report["reason"] = "The live ASI reports a different game folder."
        return report
    if report["dir_matches"] is not True:
        report["supported"] = False
        report["state"] = "unsupported"
        report["reason"] = "The live ASI game folder could not be verified through this Wine prefix."
        return report

    active_states = (
        "ready", "loaded", "searching", "attached", "awaiting_config", "awaiting_frame", "failed"
    )
    report["attached"] = native_state in active_states
    if native_state == "awaiting_config" and not report["dir_verified"]:
        report["supported"] = True
        report["state"] = "awaiting_config"
        report["reason"] = "The ASI is attached and waiting for OptiScaler to authorize its active Config."
        return report
    if not report["dir_verified"]:
        report["supported"] = False
        report["state"] = "unsupported"
        report["reason"] = "The live ASI has not verified this game's directory for commands."
        return report

    _read_measurements(report, raw)
    report["ready"] = (
        native_state == "ready"
        and report["frame_ready"]
        and report["active_api"] in (*API_NAMES, "unknown")
        and report["capability_generation"] is not None
        and report["directory_generation"] is not None
    )
    report["can_change_fg_version"] = raw.get("can_change_fg_version") == "1"
    report["can_change_xefg_count"] = raw.get("can_change_xefg_count") == "1"
    report["can_change_fg"] = raw.get("can_change_fg") == "1"
    report["can_enable_fg"] = raw.get("can_enable_fg") == "1"
    report["can_change_opti_fg"] = raw.get("can_change_opti_fg") == "1"
    report["can_change_hud_fix"] = raw.get("can_change_hud_fix") == "1"
    report["can_change_fsr_debug_view"] = raw.get("can_change_fsr_debug_view") == "1"
    report["supported"] = True
    if report["command_pending"] or report["ack"] == "pending":
        report["state"] = "queued"
        report["reason"] = "A configuration request is waiting for the native menu callback."
    elif report["ack"] == "rejected":
        report["state"] = "rejected"
        report["reason"] = report["error"] or "The live ASI rejected the last command."
    elif report["ack"] == "timeout":
        report["state"] = "timeout"
        report["reason"] = report["error"] or "The configuration request was not acknowledged before the timeout."
    elif native_state == "awaiting_config":
        report["state"] = "awaiting_config"
        report["reason"] = "The ASI is waiting for OptiScaler to authorize its active Config."
    elif native_state == "awaiting_frame" or (native_state == "ready" and not report["frame_ready"]):
        report["state"] = "awaiting_frame"
        report["reason"] = "The ASI is attached and waiting for a confirmed rendered frame."
    elif native_state == "failed":
        report["state"] = "failed"
        report["reason"] = report["error"] or "The live ASI failed while attaching to OptiScaler."
    elif report["ready"]:
        report["state"] = "ready"
        report["reason"] = None
    elif native_state in ("loaded", "searching", "attached"):
        report["state"] = native_state
        report["reason"] = "The live ASI is attached and waiting for its capability snapshot."
    else:
        report["state"] = "unknown"
        report["reason"] = "The live ASI reported an unrecognized state."
    if report["ready"] and not report["live_write_safe"]:
        report["reason"] = report["live_write_error"] or "Live-control paths are not safe to write."
    _capabilities(report, raw)
    return report


def _context_matches(context, target, current):
    if not isinstance(context, dict):
        return False
    try:
        context_target = Path(context.get("target", "")).resolve()
    except (OSError, RuntimeError):
        return False
    return (
        context_target == Path(target).resolve()
        and isinstance(context.get("session"), str)
        and context.get("session") == current.get("session")
        and context.get("active_api") in API_NAMES
        and context.get("active_api") == current.get("active_api")
        and isinstance(context.get("capability_generation"), str)
        and context.get("capability_generation") == current.get("capability_generation")
        and GENERATION_RE.fullmatch(context.get("capability_generation", "")) is not None
    )


def _key(change):
    return f"{change.get('section', '')}.{change.get('key', '')}"


def _read_command_header(path):
    path = Path(path)
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
        raise ValueError("live command path is not a regular file")
    header = {}
    try:
        lines = path.read_text(encoding="utf-8", errors="strict").splitlines()
    except (OSError, UnicodeError) as exc:
        raise ValueError(f"live command file is unreadable: {exc}") from exc
    for line in lines[:5]:
        name, sep, value = line.partition(" ")
        if not sep or name in header:
            raise ValueError("live command header is malformed")
        header[name] = value.strip()
    if list(header) != ["schema", "session", "seq", "api", "generation"]:
        raise ValueError("live command header is not schema 7")
    if (header.get("schema") != str(constants.LIVE_SCHEMA)
            or not _valid_seq(header.get("seq"))
            or header.get("api") not in (*API_NAMES, "unknown")
            or not GENERATION_RE.fullmatch(header.get("generation", ""))):
        raise ValueError("live command header identity is invalid")
    keys = []
    members = {field.member: key for key, field in LIVE_FIELDS.items()}
    for line in lines[5:]:
        parts = line.split(" ")
        if len(parts) == 4 and parts[0] == "set":
            key = members.get(parts[1])
        elif len(parts) == 2 and parts[0] == "backend":
            key = BACKEND_KEY_BY_API.get(header["api"])
        elif len(parts) == 2 and parts[0] in ("fgindex", "ffxupscaler"):
            key = FFX_FG_ID if parts[0] == "fgindex" else FFX_UPSCALER_ID
        else:
            key = None
        if not key or key in keys:
            raise ValueError("live command contains invalid or duplicate operations")
        keys.append(key)
    if not keys or len(keys) > 32:
        raise ValueError("live command has no bounded operation batch")
    header["keys"] = keys
    return header


def _matching_receipt(raw, command):
    """Validate a receipt against the command it acknowledges, not today's caps."""
    if not command or any(raw.get(wire) != command.get(key) for wire, key in (
            ("session", "session"), ("seq", "seq"),
            ("request_session", "session"), ("request_api", "api"),
            ("request_generation", "generation"))):
        return None
    ack = raw.get("ack")
    if ack == "config_request_accepted":
        keys = _split_pipe(raw.get("accepted_keys"))
        expected = command["keys"]
        if (len(keys) != len(expected) or len(set(keys)) != len(keys)
                or set(keys) != set(expected)
                or _number(raw.get("accepted_count"), int) != len(keys)
                or _split_pipe(raw.get("failed_keys"))):
            return None
    return ack if ack in ("pending", "config_request_accepted", "rejected") else None


def _command_slot_error(target, session):
    """Fail closed while a same-session command has no real terminal ack."""
    command = _read_command_header(_control_path(target, CMD_FILE))
    raw, _, err = _raw_status(target)
    if err:
        return err
    if raw and raw.get("session") == session and raw.get("command_pending") == "1":
        return "A live command is queued or awaiting runtime confirmation for this session."
    if raw and raw.get("session") == session and raw.get("ack") == "pending":
        return "A live command is still pending for this session."
    if not command or command.get("session") != session:
        return None
    if raw and raw.get("session") != session:
        return None
    if raw and _matching_receipt(raw, command) in ("config_request_accepted", "rejected"):
        return None
    return "A previous command has no terminal acknowledgement; wait for it or restart the game."


_target_locks_guard = threading.Lock()
_target_locks = {}


def _target_lock(target):
    key = str(Path(target).resolve())
    with _target_locks_guard:
        lock = _target_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _target_locks[key] = lock
        return lock


def _next_seq(target, session):
    raw, _, _ = _raw_status(target)
    previous = (int(raw["seq"]) if raw and raw.get("session") == session
                and _valid_seq(raw.get("seq")) else 0)
    command = _read_command_header(_control_path(target, CMD_FILE))
    if command and command.get("session") == session:
        previous = max(previous, int(command["seq"]))
    sequence = max(time.time_ns(), previous + 1)
    if sequence > MAX_UINT64:
        raise OverflowError("schema-7 command sequence exhausted uint64")
    return str(sequence)


def _write_command(target, body):
    target = Path(target)
    path = _control_path(target, CMD_FILE)
    temp = _control_path(target, CMD_TEMP_FILE)
    encoded = body.encode("utf-8")
    if len(encoded) > 4096:
        raise ValueError("live command exceeds the schema-7 byte limit")
    for candidate in (path, temp):
        try:
            mode = candidate.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
            raise ValueError(f"live-control path is not a regular file: {candidate}")
    temp.unlink(missing_ok=True)
    with temp.open("xb") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)
    try:
        directory_fd = os.open(str(target), os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError:
        pass


def _await_ack(target, current, session, seq, expected_keys, api, generation, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw, age, error = _raw_status(target)
        if error or not raw or age is None or age >= STATUS_STALE_SECONDS:
            time.sleep(0.05)
            continue
        try:
            command = _read_command_header(_control_path(target, CMD_FILE))
        except (OSError, ValueError):
            command = None
        if (not command or command.get("session") != session
                or command.get("seq") != seq or command.get("api") != api
                or command.get("generation") != generation):
            time.sleep(0.05)
            continue

        # Revalidate the cheap, per-heartbeat identity fields on every poll.
        # The 26 MB core hash was already checked by the status preflight and
        # is deliberately not reread at 20 Hz.
        if (raw.get("schema") != str(constants.LIVE_SCHEMA)
                or raw.get("session") != session
                or raw.get("asi_build") != constants.LIVE_BUILD_ID
                or raw.get("abi_profile") != constants.LIVE_PROFILE_ID
                or raw.get("core_sha256", "").lower() != constants.LIVE_CORE_SHA256
                or raw.get("core_valid") != "1"):
            time.sleep(0.05)
            continue

        receipt = _matching_receipt(raw, command)
        if receipt == "rejected":
            # Reauthorization may reject a command before it was bound to a
            # directory (generation 0), or invalidate an already accepted
            # command using its original directory generation. Either is a
            # terminal failure for this exact mailbox sequence; it can never
            # be treated as an applied result for the newer context.
            result_generation = _directory_generation(
                raw.get("result_directory_generation"), allow_zero=True
            )
            directory_generation = _directory_generation(
                current.get("directory_generation")
            )
            if (directory_generation is not None
                    and result_generation in (0, directory_generation)
                    and _same_dir(raw.get("dir"), target, raw.get("wine_prefix")) is True):
                failed = _split_pipe(raw.get("failed_keys")) or list(expected_keys)
                return {
                    "ack": "rejected", "confirmed": False,
                    "accepted_keys": [], "failed_keys": list(dict.fromkeys(failed)),
                    "error": raw.get("error") or
                             "The live ASI rejected the command after its authorization changed.",
                }
            time.sleep(0.05)
            continue

        directory_generation = _directory_generation(raw.get("directory_generation"))
        result_generation = _directory_generation(raw.get("result_directory_generation"))
        if (raw.get("dir_verified") != "1"
                or directory_generation is None
                or directory_generation != _directory_generation(current.get("directory_generation"))
                or result_generation is None
                or result_generation != directory_generation
                or _same_dir(raw.get("dir"), target, raw.get("wine_prefix")) is not True
                or raw.get("request_session") != session
                or raw.get("request_api") != api
                or raw.get("request_generation") != generation):
            time.sleep(0.05)
            continue
        if receipt == "config_request_accepted":
            confirmed = _split_pipe(raw.get("accepted_keys"))
            failed = [key for key in expected_keys if key not in confirmed]
            failed = list(dict.fromkeys(failed))
            ok = not failed
            return {
                "ack": "config_request_accepted", "confirmed": ok,
                "accepted_keys": confirmed, "failed_keys": failed,
                "error": None if ok else (raw.get("error") or
                         "The live bridge did not accept every requested key."),
            }
        if raw.get("seq") == seq and raw.get("ack") == "timeout":
            return {
                "ack": "timeout", "confirmed": False,
                "accepted_keys": [], "failed_keys": [],
                "error": raw.get("error") or "The native callback did not acknowledge the request in time.",
            }
        time.sleep(0.05)
    return {
        "ack": "timeout", "confirmed": False,
        "accepted_keys": [], "failed_keys": [],
        "error": "Timed out waiting for a matching configuration-request receipt.",
    }


def _result(*, sent=False, confirmed=False, ack=None, session=None, seq=None,
            accepted_keys=(), sent_keys=(), context=None, directory_generation=None,
            deferred=(), failed_keys=(),
            error=None, reason=None, **extra):
    return {
        "ok": bool(confirmed), "sent": bool(sent), "confirmed": bool(confirmed),
        "ack": ack, "session": session, "seq": seq,
        "accepted_keys": list(accepted_keys),
        "sent_keys": list(sent_keys), "context": context,
        "directory_generation": directory_generation,
        "deferred": list(deferred), "failed_keys": list(failed_keys),
        "error": error, "reason": reason, **extra,
    }


def _send(target, current, operation_lines, expected_keys, api, generation,
          source=None, plugin_root=None):
    target = Path(target).resolve()
    session = current.get("session")
    if (api not in (*API_NAMES, "unknown")
            or not isinstance(generation, str)
            or not GENERATION_RE.fullmatch(generation)):
        reason = "A live command needs a current capability generation."
        return _result(sent=False, session=session, deferred=expected_keys,
                       reason=reason, error=reason)
    lock = _target_lock(target)
    with lock:
        if _directory_generation(current.get("directory_generation")) is None:
            reason = "The live ASI has not reported a valid game-directory generation."
            return _result(sent=False, session=session, deferred=expected_keys,
                           reason=reason, error=reason)
        safe, safety_error = _live_write_preflight(target, source, plugin_root)
        if not safe:
            reason = safety_error or "Live-control paths are not safe to write."
            return _result(sent=False, session=session, deferred=expected_keys,
                           reason=reason, error=reason)
        try:
            slot_error = _command_slot_error(target, session)
        except (OSError, ValueError) as exc:
            slot_error = str(exc)
        if slot_error:
            return _result(
                sent=False, session=session, deferred=expected_keys,
                reason=slot_error, error=slot_error,
            )
        try:
            seq = _next_seq(target, session)
            body_lines = [
                f"schema {constants.LIVE_SCHEMA}", f"session {session}",
                f"seq {seq}", f"api {api}", f"generation {generation}",
                *operation_lines,
            ]
            if len(operation_lines) > 32:
                raise ValueError("live command exceeds the schema-7 operation limit")
            _write_command(target, "\n".join(body_lines) + "\n")
        except (OSError, ValueError, OverflowError) as exc:
            return _result(
                sent=False, session=session, deferred=expected_keys,
                reason=str(exc), error=str(exc),
            )
        profile = _profile(plugin_root)
        timeout_ms = 15000
        if profile:
            configured = _number(profile.get("limits", {}).get("callback_timeout_ms"), int)
            if configured and 100 <= configured <= 120000:
                timeout_ms = configured
        ack = _await_ack(target, current, session, seq, expected_keys,
                         api, generation, timeout_ms / 1000.0)
        accepted_keys = ack["accepted_keys"]
        active_api = current.get("active_api")
        result_context = {
            "target": str(target),
            "session": session,
            "active_api": active_api if active_api in API_NAMES else "unknown",
            "capability_generation": generation,
        }
        return _result(
            sent=True, confirmed=ack["confirmed"], ack=ack["ack"],
            session=session, seq=seq,
            accepted_keys=accepted_keys,
            sent_keys=expected_keys, context=result_context,
            directory_generation=current.get("directory_generation"),
            failed_keys=ack["failed_keys"],
            deferred=(), error=ack["error"],
            reason=None if ack["confirmed"] else ack["error"],
        )


def _dynamic_context(change, fallback):
    context = change.get("live_context") if isinstance(change, dict) else None
    return context if context is not None else fallback


def apply_changes(target_dir, changes, live_context=None, source=None, plugin_root=None):
    """Persisted INI edits may be pushed only through verified schema-7 gates."""
    changes = list(changes or [])
    target = Path(target_dir).resolve()
    current = status(target, source, plugin_root)
    deferred, operation_lines, expected_keys = [], [], []
    scalar_lines, fg_line, ffx_line, backend_lines = [], None, None, []
    dynamic_api = None
    dynamic_generation = None
    selected_backend = None
    backend_candidates = []
    counts = {}
    for change in changes:
        key = _key(change)
        counts[key] = counts.get(key, 0) + 1

    def defer(key):
        if key not in deferred:
            deferred.append(key)

    if current.get("supported") is not True or current.get("ready") is not True:
        reason = current.get("reason") or "The game has no fresh, ready schema-7 live session."
        return _result(deferred=[_key(change) for change in changes], reason=reason, error=reason,
                       attached=current.get("attached", False))

    dynamic = []
    encoded_items = []

    def can_apply_key(key, encoded=None):
        caps = current.get("capabilities", {})
        if key == "FrameGen.Enabled":
            return (current.get("can_enable_fg") is True if encoded == "1"
                    else current.get("can_change_fg") is True)
        return caps.get(key) is True

    for change in changes:
        key = _key(change)
        if counts[key] > 1:
            defer(key)
            continue
        field = LIVE_FIELDS.get(key)
        if not field:
            defer(key)
            continue
        try:
            encoded = field.encode(change.get("value"))
        except (TypeError, ValueError, OverflowError):
            defer(key)
            continue
        if field.action:
            context = _dynamic_context(change, live_context)
            if not _context_matches(context, target, current):
                defer(key)
                continue
            if not can_apply_key(key, encoded):
                defer(key)
                continue
            if field.action == "change_ffx_upscaler":
                upscaler_ids = current.get("ffx_upscaler_ids", [])
                upscaler_versions = current.get("ffx_upscaler_versions", [])
                index = int(encoded)
                if index >= len(upscaler_ids) or index >= len(upscaler_versions):
                    defer(key)
                    continue
            elif field.action == "change_fg_index":
                fg_ids = current.get("ffx_fg_ids", [])
                fg_versions = current.get("ffx_fg_versions", [])
                index = int(encoded)
                if index >= len(fg_ids) or index >= len(fg_versions):
                    defer(key)
                    continue
            dynamic_api = context["active_api"]
            dynamic_generation = context["capability_generation"]
            dynamic.append((key, field, encoded, context))
        else:
            if not can_apply_key(key, encoded):
                defer(key)
                continue
            encoded_items.append((key, field, encoded))

    for key, field, encoded, context in dynamic:
        if field.action == "switch_upscaler":
            if KEY_API.get(key) != context["active_api"]:
                defer(key)
                continue
            if (not _backend_supported(encoded, context["active_api"], plugin_root)
                    or encoded not in current.get("switchable_backends", [])):
                defer(key)
                continue
            backend_candidates.append((key, encoded))
        elif field.action == "change_fg_index":
            if not can_apply_key(key, encoded):
                defer(key)
                continue
            if fg_line is not None:
                defer(key)
                continue
            fg_line = (key, f"fgindex {encoded}")
        elif field.action == "change_ffx_upscaler":
            if not current.get("capabilities", {}).get("change_ffx_upscaler"):
                defer(key)
                continue
            if ffx_line is not None:
                defer(key)
                continue
            ffx_line = (key, f"ffxupscaler {encoded}")

    if backend_candidates:
        selected = [item for item in backend_candidates if item[0] == BACKEND_KEY_BY_API[dynamic_api]]
        for key, _ in backend_candidates:
            if key != BACKEND_KEY_BY_API[dynamic_api]:
                defer(key)
        codes = {code for _, code in selected}
        if len(codes) != 1 or not current.get("capabilities", {}).get("switch_upscaler"):
            for key, _ in selected:
                defer(key)
        else:
            key, selected_backend = selected[0]
            backend_lines = [(key, f"backend {selected_backend}")]

    # FFX upscaler selection is only meaningful on the active FFX backend (or
    # in the same atomic batch that selects one on that API).
    if ffx_line:
        active_backend = (current.get("upscaler") or {}).get(dynamic_api)
        final_backend = selected_backend if selected_backend is not None else active_backend
        if final_backend not in FFX_BACKENDS:
            defer(ffx_line[0])
            ffx_line = None

    # Enabling FG first lets the rest of this same batch configure the
    # features that become writable with the newly active generator.
    encoded_items.sort(key=lambda item: (item[0] != "FrameGen.Enabled",))
    for key, field, encoded in encoded_items:
        scalar_lines.append((key, f"set {field.member} {field.wire_type} {encoded}"))
    if ffx_line:
        expected_keys.append(ffx_line[0])
        operation_lines.append(ffx_line[1])
    for key, line in backend_lines:
        expected_keys.append(key)
        operation_lines.append(line)
    if fg_line:
        expected_keys.append(fg_line[0])
        operation_lines.append(fg_line[1])
    for key, line in scalar_lines:
        expected_keys.append(key)
        operation_lines.append(line)

    if not operation_lines:
        return _result(deferred=deferred, reason=(current.get("reason") if not deferred else None),
                       attached=True, ready=True)
    dynamic_sent = bool(ffx_line or backend_lines or fg_line)
    if dynamic_sent:
        api, generation = dynamic_api, dynamic_generation
    else:
        # A scalar still belongs to the generation that authorized this
        # snapshot. Unknown is only the API field; generation is never optional.
        api, generation = "unknown", current.get("capability_generation")
    result = _send(target, current, operation_lines, expected_keys, api, generation,
                   source, plugin_root)
    for key in result.get("deferred", []):
        defer(key)
    result["deferred"] = deferred
    result["backend_change"] = bool(backend_lines)
    result["backend"] = selected_backend
    result["fg_change"] = bool(fg_line)
    result["ffx_upscaler_change"] = bool(ffx_line)
    result["attached"] = True
    return result


def switch_backend(target_dir, code, live_context=None, source=None, plugin_root=None):
    """Switch the backend selected by the captured API/session/generation."""
    target = Path(target_dir).resolve()
    try:
        code = _backend(code)
    except ValueError as exc:
        return _result(reason=str(exc), error=str(exc))
    current = status(target, source, plugin_root)
    if current.get("supported") is not True or current.get("ready") is not True:
        reason = current.get("reason") or "The game has no fresh, ready schema-7 live session."
        return _result(deferred=["switch_upscaler"], reason=reason, error=reason,
                       attached=current.get("attached", False))
    if not _context_matches(live_context, target, current):
        reason = "The backend selection is stale or has no live context; refresh the live status and choose again."
        return _result(deferred=["switch_upscaler"], reason=reason, error=reason,
                       attached=True)
    api = live_context["active_api"]
    key = BACKEND_KEY_BY_API[api]
    if not current.get("capabilities", {}).get("switch_upscaler"):
        reason = "OptiScaler has not exposed the active backend map for switching."
        return _result(deferred=[key], reason=reason, error=reason, attached=True)
    if current.get("capabilities", {}).get(key) is not True:
        reason = "The active API backend is not available for live switching."
        return _result(deferred=[key], reason=reason, error=reason, attached=True)
    if not _backend_supported(code, api, plugin_root) or code not in current.get("switchable_backends", []):
        reason = f"OptiScaler does not provide the {code} backend for {api}."
        return _result(deferred=[key], reason=reason, error=reason, attached=True)
    result = _send(target, current, [f"backend {code}"], [key], api,
                   live_context["capability_generation"], source, plugin_root)
    result.update({"backend": code, "backend_change": True, "attached": True})
    return result


def log_tail(target_dir, lines=40):
    path = _control_path(target_dir, LOG_FILE)
    try:
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
            return []
        limit = max(1, min(int(lines), 2000))
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    except (OSError, TypeError, ValueError):
        return []
