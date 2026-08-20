"""Live, in-game control of OptiScaler through the bundled ASI plugin.

OptiScaler only reads OptiScaler.ini at startup, so writing the file changes
nothing until the game restarts. Its in-game overlay avoids that because it runs
*inside* the game and writes straight into the live config object.

This module drives a small ASI plugin (built from ``asi/``) that OptiScaler
loads into the game process and that performs the same writes on our behalf. The
two sides talk through two plain files next to OptiScaler.ini:

    decky_optiscaler_live.cmd     what to apply, written here
    decky_optiscaler_live.status  what the ASI found and did, written there

Files rather than a socket because they need no ports, no permissions and no
knowledge of how Proton has wired the game's network up; the ASI polls the
command file five times a second.
"""

import os
import time
from pathlib import Path

from .constants import BACKUP_DIR

ASI_NAME = "decky_optiscaler_live.asi"
PLUGIN_SUBDIR = "plugins"
CMD_FILE = "decky_optiscaler_live.cmd"
STATUS_FILE = "decky_optiscaler_live.status"
LOG_FILE = "decky_optiscaler_live.log"

# A status file older than this means the ASI is not running - the game exited,
# or it never loaded. The ASI heartbeats every few seconds precisely so that
# this stays a statement about the game and not about whether anyone happened to
# change a setting recently.
STATUS_STALE_SECONDS = 20

# The backend ids OptiScaler accepts, from the overlay's own upscaler combos
# (OptiScaler/menu/menu_common.cpp). In 0.9.4 these are plain strings in both
# Config and State - they only became an enum after this release.
BACKEND_CODES = (
    "xess", "xess_12",
    "fsr21", "fsr21_12",
    "fsr22", "fsr22_12",
    "fsr31", "fsr31_12",
    "dlss", "dlssd",
)

# The FFX frame generators OptiScaler can be told to use, and the INI key that
# records the choice. The list itself is not fixed: the FFX SDK reports what it
# can offer to each game, so the running game is the authority and the ASI reads
# it out of State. These are only what the shipped reference INI documents, used
# when nothing is attached to ask.
FFX_FG_SECTION = "FSR"
FFX_FG_KEY = "FGIndex"
FFX_FG_ID = f"{FFX_FG_SECTION}.{FFX_FG_KEY}"
# An index has to be one the game actually reports; OptiScaler clamps anything
# else to 0, which would quietly select a generator nobody asked for.
FFX_FG_MAX = 16

# Which INI key names the backend for each graphics API. The live switch can
# only push one id into State::newBackend, and DX12 is what OptiScaler is
# overwhelmingly used with on Proton, so it wins when several are set at once.
BACKEND_KEY_PRIORITY = (
    "Upscalers.Dx12Upscaler",
    "Upscalers.VulkanUpscaler",
    "Upscalers.Dx11Upscaler",
)


class LiveField:
    """One INI key the ASI can apply without a restart."""

    def __init__(self, member, wire_type, encode, needs_backend_change=False,
                 needs_fg_change=False):
        self.member = member
        self.wire_type = wire_type
        self.encode = encode
        self.needs_backend_change = needs_backend_change
        # Written through the ASI's own "fgindex" verb rather than a plain
        # field write: OptiScaler rebuilds the frame generator from Config only
        # when State::FGchanged and State::SCchanged say to.
        self.needs_fg_change = needs_fg_change


def _bool(value):
    return "1" if str(value).strip().lower() in ("1", "true", "yes", "on") else "0"


def _int(value):
    return str(int(float(str(value).strip())))


def _float(value):
    return repr(float(str(value).strip()))


def _fg_index(value):
    """An index into the FFX FG version list the running game reported."""
    index = int(float(str(value).strip()))
    if index < 0 or index >= FFX_FG_MAX:
        raise ValueError(f"not an FFX FG index: {value!r}")
    return str(index)


def _backend(value):
    """An upscaler id, checked against the ones OptiScaler actually knows."""
    code = str(value).strip().lower()
    if code not in BACKEND_CODES:
        raise ValueError(f"not an OptiScaler backend id: {value!r}")
    return code


# Only settings OptiScaler genuinely re-reads while rendering belong here.
# Anything that is consumed once, when a feature or swapchain is created, would
# appear to work and silently do nothing, so it is deliberately left out and
# keeps its "restart to apply" treatment.
LIVE_FIELDS = {
    # Frame generation: FGEnabled is checked per frame by the swapchain and by
    # every FG dispatch path, which is exactly why the overlay's hotkey works.
    "FrameGen.Enabled": LiveField("FGEnabled", "bool", _bool),
    "OptiFG.HUDFix": LiveField("FGHUDFix", "bool", _bool),
    "FrameGen.DebugView": LiveField("FGDebugView", "bool", _bool),
    "OptiFG.MakeDepthCopy": LiveField("FGMakeDepthCopy", "bool", _bool),
    "OptiFG.HUDFixExtended": LiveField("FGHUDFixExtended", "bool", _bool),
    "XeFG.InterpolationCount": LiveField("FGXeFGInterpolationCount", "i32", _int),

    # Which FFX frame generator to run - the overlay's "Change FG" button.
    # Config::FfxFGIndex is read when FSRFG_Dx12 builds its context, so unlike
    # the upscaler this *is* a Config write; what makes it happen now rather
    # than next launch is the pair of State flags the ASI raises with it.
    FFX_FG_ID: LiveField("FfxFGIndex", "i32", _fg_index, needs_fg_change=True),

    # Upscaler override. Writing Config alone would not switch anything: the
    # overlay's own "change upscaler" path puts the id in State::newBackend and
    # marks every backend changed. Note that the overlay does *not* touch Config
    # when it does that - see _drop_upscaler_writes for why we no longer do
    # either.
    "Upscalers.Dx11Upscaler": LiveField(
        "Dx11Upscaler", "str", _backend, needs_backend_change=True),
    "Upscalers.Dx12Upscaler": LiveField(
        "Dx12Upscaler", "str", _backend, needs_backend_change=True),
    "Upscalers.VulkanUpscaler": LiveField(
        "VulkanUpscaler", "str", _backend, needs_backend_change=True),

    # Cheap per-frame knobs, safe to move while playing.
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


def install_plugin_asi(target_dir, source, name, logger=None):
    """Drop an ASI into the game's OptiScaler plugin folder.

    OptiScaler loads every .asi in this folder once ``LoadAsiPlugins`` is on,
    which is how both our live-control module and OptiPatcher get in.
    """
    source = Path(source)
    if not source.is_file():
        return {"ok": False, "error": f"{name} missing at {source}"}
    destination = Path(target_dir) / PLUGIN_SUBDIR / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(source.read_bytes())
    if logger:
        logger.info("installed %s at %s", name, destination)
    return {"ok": True, "path": str(destination)}


def install_asi(target_dir, source, logger=None):
    """Drop the live-control ASI into the game's OptiScaler plugin folder."""
    return install_plugin_asi(target_dir, source, ASI_NAME, logger)


def remove_asi(target_dir, logger=None):
    """Remove the ASI and every file the live channel created."""
    removed = []
    for path in (
        asi_path(target_dir),
        _control_path(target_dir, CMD_FILE),
        _control_path(target_dir, STATUS_FILE),
        _control_path(target_dir, LOG_FILE),
    ):
        try:
            if path.is_file():
                path.unlink()
                removed.append(path.name)
        except OSError as exc:
            if logger:
                logger.warning("could not remove %s: %s", path, exc)

    # Only clean the plugins folder up if we are the ones who created it.
    plugin_dir = Path(target_dir) / PLUGIN_SUBDIR
    try:
        if plugin_dir.is_dir() and not any(plugin_dir.iterdir()):
            plugin_dir.rmdir()
    except OSError:
        pass
    return {"ok": True, "removed": removed}


def ini_requirements():
    """INI settings OptiScaler needs before it will load the ASI at all.

    Only the switch. ``Plugins.Path`` is deliberately left alone: OptiScaler
    already defaults it to ``<dll folder>/plugins``, and writing a *relative*
    path here would be resolved against the game's working directory instead,
    which is not reliably the folder OptiScaler was loaded from.
    """
    return [
        {"section": "Plugins", "key": "LoadAsiPlugins", "value": "true"},
    ]


def load_enabled(target_dir):
    """Whether OptiScaler.ini actually switches ASI loading on.

    It defaults to *false*, so an install that predates this plugin - or one
    whose ini was replaced - loads nothing at all, silently.
    """
    ini = Path(target_dir) / "OptiScaler.ini"
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
            return value.strip().lower() == "true"
    return False


def loaded_by_optiscaler(target_dir):
    """Whether OptiScaler's own log says it loaded our plugin this run.

    This is the one unambiguous answer to "is it even being loaded?" - the
    difference between a missing switch and a plugin that loaded but could not
    find what it needed in memory.
    """
    log = Path(target_dir) / "OptiScaler.log"
    if not log.is_file():
        return None
    try:
        # The line we want is written during startup, so the head is enough.
        with log.open("r", encoding="utf-8", errors="replace") as handle:
            head = handle.read(400_000)
    except OSError:
        return None
    if ASI_NAME.lower() in head.lower():
        return True
    # It logs "Checking <path> for *.asi" at debug level; seeing that without
    # our name means the folder was searched and we were not in it.
    return False if "for *.asi" in head else None


def _parse_status(text):
    out = {}
    for line in text.splitlines():
        parts = line.strip().split(" ", 1)
        if not parts[0]:
            continue
        out[parts[0]] = parts[1].strip() if len(parts) > 1 else ""
    return out


def _number(text, cast, unknown=None):
    """One numeric status line, or None when it is missing or unreadable.

    The plugin writes -1 for "could not read this", which is not the same
    statement as 0 and must not be shown as one.
    """
    if text in (None, ""):
        return None
    try:
        value = cast(text)
    except (TypeError, ValueError):
        return None
    return None if value == unknown else value


def _read_measurements(report, raw):
    """The numbers and names the plugin sampled out of the running game."""
    report["fps"] = _number(raw.get("fps"), float)
    report["frames"] = _number(raw.get("frames"), int)
    report["backend_entries"] = _number(raw.get("backend_entries"), int, unknown=-1)
    report["fg_enabled"] = {"1": True, "0": False}.get(raw.get("fg_enabled"))
    report["upscaler"] = {
        "dx12": raw.get("dx12_upscaler") or None,
        "dx11": raw.get("dx11_upscaler") or None,
        "vulkan": raw.get("vulkan_upscaler") or None,
    }
    report["pending_backend"] = raw.get("pending_backend") or None
    report["fg_index"] = _number(raw.get("fg_index"), int, unknown=-1)
    # The frame generators the FFX SDK reported to *this* game, in FfxFGIndex
    # order. Empty until the game has asked it, which is not an error.
    versions = raw.get("ffx_fg_versions") or ""
    report["ffx_fg_versions"] = [name for name in versions.split("|") if name]


def status(target_dir):
    """What the in-game side is doing right now."""
    path = _control_path(target_dir, STATUS_FILE)
    report = {
        "asi_installed": installed(target_dir),
        "load_enabled": load_enabled(target_dir),
        "loaded_by_optiscaler": loaded_by_optiscaler(target_dir),
        "attached": False,
        "state": "absent",
        "error": None,
        "seq": None,
        "can_switch_upscaler": False,
        # Whether the ASI located State::FGchanged/SCchanged, without which the
        # FFX frame generator can be recorded but not changed in this session.
        "can_change_fg": False,
        "fg_index": None,
        "ffx_fg_versions": [],
        # Which status-file format the in-game plugin speaks. An install that
        # predates a feature reports an older number rather than nothing at all.
        "schema": None,
        "age": None,
        "fps": None,
        "frames": None,
        # How many upscalers OptiScaler has registered. Zero means a switch has
        # nothing to act on yet, which is a different problem from not being
        # able to find the map at all (None).
        "backend_entries": None,
        "fg_enabled": None,
        "upscaler": None,
        "pending_backend": None,
        # Where the in-game side decided its control files live. It should be
        # target_dir; anything else means the plugin is writing where nothing is
        # reading, which is exactly how it used to fail.
        "dir": None,
        "dir_matches": None,
    }
    if not path.is_file():
        return report
    try:
        raw = _parse_status(path.read_text(encoding="utf-8", errors="replace"))
        age = time.time() - path.stat().st_mtime
    except OSError as exc:
        report["error"] = str(exc)
        return report

    report["age"] = round(age, 1)
    report["state"] = raw.get("status", "unknown")
    report["error"] = raw.get("error") or None
    report["seq"] = raw.get("seq")
    _read_measurements(report, raw)
    # Switching needs both halves of the overlay's own path: the backend map to
    # mark, and State::newBackend to write. A null either side means frame
    # generation still works but the upscaler cannot move yet.
    def _found(name):
        value = raw.get(name, "0")
        return bool(value) and value not in ("0", "0x0", "(nil)", "0000000000000000")

    # A switch works by marking every entry of State::changeBackend, so with no
    # entries there is nothing to mark however healthy the pointers look. Older
    # plugin builds do not report the count at all; there, fall back to the
    # pointers rather than claiming the switch is unavailable.
    registered = report["backend_entries"]
    report["can_switch_upscaler"] = (
        _found("backends") and _found("newbackend")
        and (registered is None or registered > 0)
    )
    # Changing the FFX frame generator needs both halves too: the flags to
    # raise, and a list to pick an index out of. An ASI that could not identify
    # State::CapturedHudlesses reports a null pointer here and the switch is
    # simply not offered - the ini still records the choice for the next launch.
    report["schema"] = _number(raw.get("schema"), int)
    report["can_change_fg"] = _found("fgflags") and bool(report["ffx_fg_versions"])
    # "loaded" means the plugin is running but has not finished looking yet;
    # both it and "ready" mean the game really does have our plugin in it.
    report["attached"] = report["state"] in ("ready", "loaded", "searching") \
        and age < STATUS_STALE_SECONDS
    report["ready"] = report["state"] == "ready" and report["attached"]
    reported_dir = raw.get("dir") or None
    report["dir"] = reported_dir
    if reported_dir:
        report["dir_matches"] = _same_dir(reported_dir, target_dir)
    return report


def _same_dir(windows_path, target_dir):
    """Whether a path the ASI reported is the folder we are managing.

    The ASI reports a Windows path (``Z:\\home\\deck\\...`` under Proton), so the
    comparison is on the tail rather than on the whole string.
    """
    tail = windows_path.replace("\\", "/").rstrip("/").lower()
    ours = str(Path(target_dir)).replace("\\", "/").rstrip("/").lower()
    if not tail or not ours:
        return None
    return tail.endswith(ours) or ours.endswith(tail)


def apply_changes(target_dir, changes):
    """Ask the running game to adopt these INI changes immediately.

    ``changes`` are the same {section, key, value} dicts the config writer uses.
    Returns which ones were sent and which need a restart regardless.
    """
    live, deferred = [], []
    backend_codes = {}
    for change in changes:
        ini_key = f"{change['section']}.{change['key']}"
        field = LIVE_FIELDS.get(ini_key)
        if field is None:
            deferred.append(ini_key)
            continue
        try:
            encoded = field.encode(change["value"])
        except (TypeError, ValueError):
            deferred.append(ini_key)
            continue
        if field.needs_fg_change:
            # Its own verb: the ASI has to write Config and raise both State
            # flags together, and a plain field write would do only the first.
            live.append(f"fgindex {encoded}")
            continue
        live.append(f"set {field.member} {field.wire_type} {encoded}")
        if field.needs_backend_change:
            backend_codes[ini_key] = encoded

    # One id goes into State::newBackend; the API-specific keys disagree by
    # design (fsr31 on DX12 is fsr31_12 on DX11), so pick by API priority.
    switch_to = None
    for ini_key in BACKEND_KEY_PRIORITY:
        if ini_key in backend_codes:
            switch_to = backend_codes[ini_key]
            break
    if switch_to:
        live = _drop_upscaler_writes(live)
        # First, so the id is in place before anything else this command does.
        live.insert(0, f"backend {switch_to}")

    if not live:
        return {"ok": True, "applied": [], "deferred": deferred, "sent": False}

    seq = int(time.time() * 1000)
    body = "\n".join([f"seq {seq}", *live, ""])
    path = _control_path(target_dir, CMD_FILE)
    try:
        # Write-then-replace so the ASI never reads a half-written command file.
        temp = path.with_suffix(".cmd.tmp")
        temp.write_text(body, encoding="utf-8")
        os.replace(temp, path)
    except OSError as exc:
        return {"ok": False, "error": str(exc), "applied": [], "deferred": deferred, "sent": False}

    return {
        "ok": True,
        "sent": True,
        "seq": seq,
        "applied": [line.split(" ")[1] for line in live if line.startswith("set ")],
        "deferred": deferred,
        "backend_change": bool(switch_to),
        "backend": switch_to,
        "fg_change": any(line.startswith("fgindex ") for line in live),
    }


def _drop_upscaler_writes(lines):
    """Remove the Config upscaler writes from a command that also switches.

    The overlay's "Change Upscaler" button writes *only* State::newBackend; it
    leaves Config::Dx12Upscaler alone and OptiScaler updates it once it has
    rebuilt the feature. It also refuses to act when newBackend already equals
    the Config value, so pushing the new id into Config first is at best
    pointless and at worst turns the switch into a no-op - exactly the shape of
    "frame generation toggles, the upscaler never moves".

    The INI is still written either way, so the choice survives a restart
    regardless of what the running game does with it.
    """
    members = {LIVE_FIELDS[key].member for key in BACKEND_KEY_PRIORITY}
    return [line for line in lines
            if not (line.startswith("set ") and line.split(" ")[1] in members)]


def switch_backend(target_dir, code):
    """Push an upscaler switch on its own, the way the overlay's button does.

    Separate from apply_changes because it is a deliberate action rather than a
    side effect of editing a setting: OptiScaler rebuilds the upscaler when it
    sees this, which costs a frame.
    """
    code = str(code).strip().lower()
    if code not in BACKEND_CODES:
        return {"ok": False, "error": f"not an OptiScaler backend id: {code}"}
    seq = int(time.time() * 1000)
    body = "\n".join([f"seq {seq}", f"backend {code}", ""])
    path = _control_path(target_dir, CMD_FILE)
    try:
        temp = path.with_suffix(".cmd.tmp")
        temp.write_text(body, encoding="utf-8")
        os.replace(temp, path)
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "sent": True, "backend": code, "seq": seq}


def log_tail(target_dir, lines=40):
    path = _control_path(target_dir, LOG_FILE)
    if not path.is_file():
        return []
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]
    except OSError:
        return []
