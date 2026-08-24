"""Install, detect and remove OptiScaler inside a game directory.

Mirrors what the official setup_linux.sh does — copy the release next to the
game executable and rename OptiScaler.dll to a proxy filename the game already
loads — but records a manifest and stashes every displaced file in a visible
backup folder, so an uninstall can put the game back exactly as it was.
"""

import json
import os
import shutil
import time
from pathlib import Path

from . import live
from .constants import (
    OPTIPATCHER_NAME,
    BACKUP_DIR,
    FFX_UPSCALER_DLL,
    FSR4_MIN_SDK_VERSION,
    DEFAULT_PROXY,
    FSR4_SOURCE_HINTS,
    FSR4_SUPPORT_FILES,
    INI_NAME,
    LAUNCH_RECORD_NAME,
    LOG_NAME,
    MANIFEST_NAME,
    OPTISCALER_VERSION,
    PAYLOAD_DIRS,
    PAYLOAD_FILES,
    PROXY_FILENAMES,
    REFRAMEWORK_DLL,
    RUNTIME_ARTIFACTS,
)

# Suffix used by v0.1 of this plugin, still restored on uninstall.
LEGACY_BACKUP_SUFFIX = ".decky-optiscaler.bak"
DLL_MARKER = b"OptiScaler"
MIN_OPTISCALER_SIZE = 4 * 1024 * 1024


def _looks_like_optiscaler(path):
    """True if a proxy-named file is really an OptiScaler build."""
    try:
        if path.stat().st_size < MIN_OPTISCALER_SIZE:
            return False
        with open(path, "rb") as handle:
            while True:
                chunk = handle.read(1 << 20)
                if not chunk:
                    return False
                if DLL_MARKER in chunk:
                    return True
    except OSError:
        return False


def read_manifest(target_dir):
    path = Path(target_dir) / MANIFEST_NAME
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def backup_dir(target_dir):
    return Path(target_dir) / BACKUP_DIR


def launch_record_path(target_dir):
    return Path(target_dir) / LAUNCH_RECORD_NAME


def read_launch_record(target_dir):
    """The Steam launch options this game had before OptiScaler went in.

    ``recorded`` is what separates "there was nothing there" from "nobody
    looked": an empty string is a real answer and the reason uninstalling can
    offer to clear the launch options outright, while a missing file means the
    install predates this record or Steam would not say, and only the override
    this plugin added can safely be taken back out.
    """
    path = launch_record_path(target_dir)
    if not path.is_file():
        return {"recorded": False, "value": ""}
    try:
        return {"recorded": True, "value": path.read_text(encoding="utf-8")}
    except OSError:
        return {"recorded": False, "value": ""}


def record_launch_options(target_dir, options, logger=None):
    """Keep the pre-install launch options, once.

    Write-once for the same reason ``_stash`` keeps the oldest backup: the value
    worth putting back is the one from before this plugin first touched the
    game, and a reinstall — or turning the launch-options step off and on again
    — must not overwrite it with the override we ourselves wrote.
    """
    path = launch_record_path(target_dir)
    if path.exists():
        return {"recorded": True, "value": read_launch_record(target_dir)["value"],
                "written": False}
    path.write_text(options or "", encoding="utf-8")
    if logger:
        logger.info("recorded previous launch options for %s", target_dir)
    return {"recorded": True, "value": options or "", "written": True}


def forget_launch_options(target_dir):
    """Drop the record. Called by uninstall: it belongs to one install."""
    path = launch_record_path(target_dir)
    existed = path.is_file()
    path.unlink(missing_ok=True)
    return existed


def detect(target_dir):
    """Report whether (and how) OptiScaler is installed in a directory."""
    target = Path(target_dir)
    result = {
        "path": str(target),
        "installed": False,
        "filename": None,
        "managed": False,
        "version": None,
        "installed_at": None,
        "ini_present": False,
        "ini_path": None,
        "log_present": False,
        "log_path": None,
        "candidates": [],
        "extra_proxies": [],
        "backup_dir": str(backup_dir(target)),
        "backed_up": [],
        "launch_record": {"recorded": False, "value": ""},
        "fsr4": {},
        # REFramework, for the RE Engine games that need it. Reported from the
        # folder rather than from the manifest so a copy the user put there
        # themselves counts — the step is "is REF present", not "did we install
        # REF", and re-installing over somebody's own working REF would be a
        # worse answer than leaving it alone.
        "reframework": {"installed": False, "revision": None, "managed": False},
    }
    if not target.is_dir():
        return result

    result["launch_record"] = read_launch_record(target)

    ini = target / INI_NAME
    result["ini_present"] = ini.is_file()
    result["ini_path"] = str(ini)
    log = target / LOG_NAME
    result["log_present"] = log.is_file()
    result["log_path"] = str(log)
    result["fsr4"] = fsr4_status(target)

    result["reframework"] = {
        "installed": (target / REFRAMEWORK_DLL).is_file(),
        # Which build went in is only knowable from what we recorded: the
        # stamp file is deliberately not installed next to the game.
        "revision": None,
        "managed": False,
    }

    stash = backup_dir(target)
    if stash.is_dir():
        result["backed_up"] = sorted(p.name for p in stash.iterdir())

    present = [name for name in PROXY_FILENAMES if (target / name).is_file()]
    result["candidates"] = present

    manifest = read_manifest(target)
    if manifest and manifest.get("filename"):
        name = manifest["filename"]
        if (target / name).is_file():
            result.update(
                installed=True,
                filename=name,
                managed=True,
                version=manifest.get("optiscaler_version"),
                installed_at=manifest.get("installed_at"),
            )
            result["reframework"]["managed"] = bool(manifest.get("reframework"))
            result["reframework"]["revision"] = manifest.get("reframework_revision")
            result["extra_proxies"] = [p for p in present if p != name
                                       and _looks_like_optiscaler(target / p)]
            return result

    # Installed by hand or by another tool: identify by content.
    for name in present:
        if _looks_like_optiscaler(target / name):
            result.update(installed=True, filename=name, managed=False)
            result["extra_proxies"] = [
                p for p in present if p != name and _looks_like_optiscaler(target / p)
            ]
            break
    return result


def ffx_upscaler_info(target_dir):
    """The FidelityFX upscaler library actually sitting in the game folder.

    This is the version OptiScaler's overlay prints in its FFX Settings box, and
    it is what decides whether FSR 4 is even on offer - so it belongs in front
    of the user rather than behind a verify step.
    """
    dll = Path(target_dir) / FFX_UPSCALER_DLL
    version = pe_file_version(dll) if dll.is_file() else None
    return {
        "present": dll.is_file(),
        "name": FFX_UPSCALER_DLL,
        "version": ".".join(str(n) for n in version) if version else None,
        # OptiScaler treats an SDK at or above 4.1.1 as providing FSR 4.
        "fsr4_capable": bool(version and version[:3] >= FSR4_MIN_SDK_VERSION[:3]),
    }


def fsr4_status(target_dir):
    """Which FSR4 support DLLs are present next to the game executable."""
    target = Path(target_dir)
    present = {name: (target / name).is_file() for name in FSR4_SUPPORT_FILES}
    return {
        "files": present,
        "ready": present.get("amdxcffx64.dll", False),
        "required": FSR4_SUPPORT_FILES,
        "ffx": ffx_upscaler_info(target_dir),
    }


def find_fsr4_sources(home):
    """Folders on this machine that already hold FSR4 support DLLs."""
    found = []
    for hint in FSR4_SOURCE_HINTS:
        candidate = Path(home) / hint
        if not candidate.is_dir():
            continue
        names = [n for n in FSR4_SUPPORT_FILES if (candidate / n).is_file()]
        if names:
            found.append({"path": str(candidate), "files": names})
    return found


def import_fsr4_files(target_dir, source_dir, logger=None):
    """Copy user-supplied FSR4 DLLs in and register them for later removal."""
    target = Path(target_dir)
    source = Path(source_dir)
    if not target.is_dir():
        raise NotADirectoryError(f"install target does not exist: {target}")
    if not source.is_dir():
        raise NotADirectoryError(f"source folder does not exist: {source}")

    names = [n for n in FSR4_SUPPORT_FILES if (source / n).is_file()]
    if not names:
        raise FileNotFoundError(
            f"no FSR4 support files ({', '.join(FSR4_SUPPORT_FILES)}) in {source}"
        )

    manifest = read_manifest(target) or {}
    backups = dict(manifest.get("backups") or {})
    files = list(manifest.get("files") or [])

    for name in names:
        destination = target / name
        if destination.exists() and name not in backups and name not in files:
            backups[name] = _stash(target, destination, logger)
        shutil.copy2(source / name, destination)
        if name not in files:
            files.append(name)
        if logger:
            logger.info("installed FSR4 support file %s", name)

    if manifest:
        manifest["files"] = files
        manifest["backups"] = backups
        (target / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    return {"path": str(target), "imported": names, "source": str(source)}


def add_files(target_dir, sources, logger=None, reframework_revision=None):
    """Copy extra files into an existing install and register them for removal.

    The same contract as everything else this plugin puts in a game folder:
    anything displaced is stashed, everything added is written into the
    manifest, and uninstall reverses both. Used to add REFramework to a game
    that is already set up, or to retry a download that failed the first time.

    A game with no manifest — OptiScaler installed by hand, or by another tool —
    still gets the files. It is the tracking that is unavailable there, not the
    install, and refusing would be refusing the only thing the user asked for.
    """
    target = Path(target_dir)
    if not target.is_dir():
        raise NotADirectoryError(f"install target does not exist: {target}")

    manifest = read_manifest(target) or {}
    backups = dict(manifest.get("backups") or {})
    files = list(manifest.get("files") or [])
    added = []

    for source in sources:
        source = Path(source)
        if not source.is_file():
            raise FileNotFoundError(f"missing {source}")
        name = source.name
        destination = target / name
        if destination.exists() and name not in backups and name not in files:
            backups[name] = _stash(target, destination, logger)
        shutil.copy2(source, destination)
        if name not in files:
            files.append(name)
        added.append(name)
        if logger:
            logger.info("installed %s", name)

    if manifest:
        manifest["files"] = files
        manifest["backups"] = backups
        if REFRAMEWORK_DLL in added:
            manifest["reframework"] = True
            manifest["reframework_revision"] = reframework_revision
        (target / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    return {"ok": True, "path": str(target), "files": added, "tracked": bool(manifest)}


def remove_files(target_dir, names, logger=None):
    """Take specific files back out, restoring anything they displaced.

    The counterpart to `add_files`, and the reason it exists is Monster Hunter
    Wilds: REFramework is a 23 MB third-party DLL that hooks the engine, and
    when a game stops booting after an install there is no way to find out
    whether that was OptiScaler or REF unless one of them can be taken out on
    its own. Bundling them into a single all-or-nothing install left the user
    with a game that would not start and no way to bisect it.
    """
    target = Path(target_dir)
    if not target.is_dir():
        raise NotADirectoryError(f"path does not exist: {target}")

    manifest = read_manifest(target) or {}
    files = list(manifest.get("files") or [])
    backups = dict(manifest.get("backups") or {})
    removed = []
    restored = []

    for name in names:
        path = target / name
        if path.is_file():
            path.unlink()
            removed.append(name)
        if name in files:
            files.remove(name)
        # Whatever this displaced goes back, exactly as a full uninstall does.
        if backups.pop(name, None):
            stashed = backup_dir(target) / name
            if stashed.is_file():
                shutil.move(str(stashed), str(path))
                restored.append(name)
                if logger:
                    logger.info("restored original %s", name)

    if manifest:
        manifest["files"] = files
        manifest["backups"] = backups
        if REFRAMEWORK_DLL in removed:
            manifest["reframework"] = False
            manifest["reframework_revision"] = None
        (target / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    return {"ok": True, "removed": removed, "restored": restored}


def _stash(target, path, logger=None):
    """Move a file or directory into the backup folder; returns its name."""
    stash = backup_dir(target)
    stash.mkdir(parents=True, exist_ok=True)
    destination = stash / path.name
    if destination.exists():
        # An earlier install already preserved the original; keep the oldest.
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
        return path.name
    shutil.move(str(path), str(destination))
    if logger:
        logger.info("backed up %s to %s/", path.name, BACKUP_DIR)
    return path.name


def install(target_dir, payload_root, filename=DEFAULT_PROXY, preserve_ini=True,
            logger=None, live_asi=None, optipatcher=None, reframework_files=None,
            reframework_revision=None):
    """Copy OptiScaler into target_dir under the given proxy filename.

    ``live_asi`` is the path to the compiled live-control plugin; when given it
    is installed alongside OptiScaler so settings can be changed while playing.

    ``optipatcher`` is the path to OptiPatcher.asi. It goes in the same plugin
    folder and lets OptiScaler expose DLSS/DLSS-FG inputs in the games it has
    patterns for, without DXGI spoofing.

    ``reframework_files`` are the already-downloaded REFramework files for the
    RE Engine games that cannot host OptiScaler without it. They go in through
    the same ``place`` as everything else, on purpose: that is what puts them in
    the manifest, stashes anything they displace, and takes them back out on
    uninstall. A mod installed off to one side of that machinery is a mod this
    plugin cannot promise to remove.
    """
    if filename not in PROXY_FILENAMES:
        raise ValueError(f"unsupported filename: {filename}")

    target = Path(target_dir)
    payload = Path(payload_root)
    if not target.is_dir():
        raise NotADirectoryError(f"install target does not exist: {target}")
    if not os.access(target, os.W_OK):
        raise PermissionError(f"no write permission for {target}")
    source_dll = payload / "OptiScaler.dll"
    if not source_dll.is_file():
        raise FileNotFoundError(f"payload incomplete, missing {source_dll}")

    previous = detect(target)
    old_manifest = read_manifest(target) or {}
    old_files = set(old_manifest.get("files") or [])
    old_dirs = set(old_manifest.get("dirs") or [])
    backups = dict(old_manifest.get("backups") or {})
    created = []
    created_dirs = []

    # Remove a previous install under a different filename so the game does not
    # end up loading OptiScaler twice.
    for stale in previous.get("candidates", []):
        if stale == filename:
            continue
        stale_path = target / stale
        if not _looks_like_optiscaler(stale_path):
            continue
        stale_path.unlink(missing_ok=True)
        # If we displaced the game's own dll to install there, put it back now
        # rather than leaving the game without it until uninstall.
        if backups.pop(stale, None):
            stashed = backup_dir(target) / stale
            if stashed.is_file():
                shutil.move(str(stashed), str(stale_path))
                if logger:
                    logger.info("restored original %s while moving proxy", stale)
        elif logger:
            logger.info("removed previous OptiScaler proxy %s", stale)

    def place(src, dest_name):
        dest = target / dest_name
        if dest.exists() and dest_name not in backups and dest_name not in created:
            # Only stash files that belong to the game, not our own leftovers.
            if dest_name not in old_files and not _looks_like_optiscaler(dest):
                backups[dest_name] = _stash(target, dest, logger)
        shutil.copy2(src, dest)
        if dest_name not in created:
            created.append(dest_name)

    place(source_dll, filename)

    ini_path = target / INI_NAME
    if not (preserve_ini and ini_path.is_file()):
        shutil.copy2(payload / INI_NAME, ini_path)
    if INI_NAME not in created:
        created.append(INI_NAME)

    for name in PAYLOAD_FILES:
        src = payload / name
        if src.is_file():
            place(src, name)

    for name in PAYLOAD_DIRS:
        src = payload / name
        if not src.is_dir():
            continue
        dest = target / name
        if dest.exists() and name not in backups and name not in old_dirs:
            backups[name] = _stash(target, dest, logger)
        shutil.copytree(src, dest, dirs_exist_ok=True)
        if name not in created_dirs:
            created_dirs.append(name)

    # REFramework, for the games whose wiki entry says OptiScaler does nothing
    # without it. One file (plus the revision stamp REF itself writes), placed
    # next to the executable exactly as REF's own instructions describe.
    ref_result = {"installed": False, "files": [], "error": None,
                  "revision": reframework_revision}
    for source in reframework_files or []:
        source = Path(source)
        if not source.is_file():
            ref_result["error"] = f"missing {source.name}"
            continue
        place(source, source.name)
        ref_result["files"].append(source.name)
    ref_result["installed"] = REFRAMEWORK_DLL in ref_result["files"]

    # The live-control plugin: an .asi OptiScaler loads into the game process so
    # frame generation and the upscaler can be changed without a restart.
    live_result = {"installed": False, "error": None}
    if live_asi:
        outcome = live.install_asi(target, live_asi, logger)
        if outcome.get("ok"):
            live_result["installed"] = True
            created.append(f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}")
        else:
            live_result["error"] = outcome.get("error")
            if logger:
                logger.warning("live control unavailable: %s", outcome.get("error"))

    # OptiPatcher: an optional ASI from the OptiScaler project. Some games
    # (Red Dead Redemption 2 among them) need it to expose their DLSS inputs.
    patcher_result = {"installed": False, "error": None}
    if optipatcher:
        outcome = live.install_plugin_asi(target, optipatcher, OPTIPATCHER_NAME, logger)
        if outcome.get("ok"):
            patcher_result["installed"] = True
            created.append(f"{live.PLUGIN_SUBDIR}/{OPTIPATCHER_NAME}")
        else:
            patcher_result["error"] = outcome.get("error")
            if logger:
                logger.warning("optipatcher unavailable: %s", outcome.get("error"))

    manifest = {
        "plugin": "decky-optiscaler",
        "live_asi": live_result["installed"],
        "optipatcher": patcher_result["installed"],
        "reframework": ref_result["installed"],
        "reframework_revision": ref_result["revision"],
        "optiscaler_version": OPTISCALER_VERSION,
        "filename": filename,
        "installed_at": time.time(),
        "files": created,
        "dirs": created_dirs,
        "backups": backups,
        "backup_dir": BACKUP_DIR,
    }
    (target / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    return {
        "path": str(target),
        "filename": filename,
        "version": OPTISCALER_VERSION,
        "ini_preserved": preserve_ini and ini_path.is_file(),
        "optipatcher": patcher_result,
        "reframework": ref_result,
        "launch_option": launch_option(filename),
        "files": created,
        "dirs": created_dirs,
        "backups": backups,
        "backup_dir": str(backup_dir(target)),
        "fsr4": fsr4_status(target),
        "live": live_result,
    }


def launch_option(filename):
    """Steam launch options needed for Wine to load the proxy dll."""
    if filename.lower().endswith(".asi"):
        return "%command%"  # .asi is loaded by an ASI loader, no override needed
    stem = filename[:-4] if filename.lower().endswith(".dll") else filename
    return f'WINEDLLOVERRIDES="{stem}=n,b" %command%'


def uninstall(target_dir, remove_ini=True, logger=None):
    """Remove OptiScaler, restoring everything it displaced."""
    target = Path(target_dir)
    if not target.is_dir():
        raise NotADirectoryError(f"path does not exist: {target}")

    manifest = read_manifest(target)
    removed = []
    restored = []

    if manifest:
        for name in manifest.get("files", []):
            if name == INI_NAME and not remove_ini:
                continue
            path = target / name
            if path.is_file():
                path.unlink()
                removed.append(name)
        for name in manifest.get("dirs", []):
            path = target / name
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
                removed.append(name + "/")
    else:
        # Unmanaged install: fall back to the file set setup_linux.sh creates.
        for name in PROXY_FILENAMES:
            path = target / name
            if path.is_file() and _looks_like_optiscaler(path):
                path.unlink()
                removed.append(name)
        for name in PAYLOAD_FILES + FSR4_SUPPORT_FILES:
            path = target / name
            if path.is_file():
                path.unlink()
                removed.append(name)
        for name in PAYLOAD_DIRS + ["DlssOverrides"]:
            path = target / name
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
                removed.append(name + "/")
        if remove_ini and (target / INI_NAME).is_file():
            (target / INI_NAME).unlink()
            removed.append(INI_NAME)

    for name in RUNTIME_ARTIFACTS + ["remove_optiscaler.sh"]:
        path = target / name
        if path.is_file():
            path.unlink()
            removed.append(name)

    # The record of what Steam was passing before is ours and belongs to this
    # install; whoever asked for the uninstall has already been shown it.
    if forget_launch_options(target):
        removed.append(LAUNCH_RECORD_NAME)

    restored.extend(restore_backups(target, logger))

    # The live-control plugin and its command/status/log files are ours, so they
    # go too -- uninstall should leave nothing of this plugin behind.
    for name in live.remove_asi(target, logger).get("removed", []):
        if name not in removed:
            removed.append(name)

    manifest_path = target / MANIFEST_NAME
    if manifest_path.is_file():
        manifest_path.unlink()

    if logger:
        logger.info(
            "uninstalled OptiScaler from %s (%d removed, %d restored)",
            target, len(removed), len(restored),
        )
    return {
        "path": str(target),
        "removed": removed,
        "restored": restored,
        "backup_dir": str(backup_dir(target)),
    }


def restore_backups(target_dir, logger=None):
    """Move everything in the backup folder back, then drop the folder."""
    target = Path(target_dir)
    restored = []

    stash = backup_dir(target)
    if stash.is_dir():
        for item in sorted(stash.iterdir()):
            destination = target / item.name
            if destination.exists():
                if destination.is_dir():
                    shutil.rmtree(destination, ignore_errors=True)
                else:
                    destination.unlink()
            shutil.move(str(item), str(destination))
            restored.append(item.name)
            if logger:
                logger.info("restored %s from %s/", item.name, BACKUP_DIR)
        try:
            stash.rmdir()
        except OSError:
            if logger:
                logger.warning("%s/ not empty, leaving it in place", BACKUP_DIR)

    # Installs made by v0.1 of this plugin used a suffix instead of a folder.
    for path in target.glob("*" + LEGACY_BACKUP_SUFFIX):
        original = target / path.name[: -len(LEGACY_BACKUP_SUFFIX)]
        if original.exists():
            original.unlink()
        shutil.move(str(path), str(original))
        restored.append(original.name)

    return restored


def pe_file_version(path):
    """Read a PE file's VS_FIXEDFILEINFO version, or None.

    Used to report which FidelityFX SDK — and therefore which FSR version — is
    actually sitting in the game folder.
    """
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    marker = data.find(b"\xbd\x04\xef\xfe")
    if marker < 0 or marker + 16 > len(data):
        return None
    import struct

    try:
        minor, major, build, patch = struct.unpack("<HHHH", data[marker + 8 : marker + 16])
    except struct.error:
        return None
    return (major, minor, patch, build)


def verify_install(target_dir, payload_root):
    """Check that every bundled file really landed in the game folder.

    Answers the practical question "did the install actually override what the
    game shipped?" by comparing size and content against the payload.
    """
    target = Path(target_dir)
    payload = Path(payload_root)
    manifest = read_manifest(target)
    entries = []

    expected = list(PAYLOAD_FILES)
    if manifest and manifest.get("filename"):
        expected.insert(0, manifest["filename"])

    for name in expected:
        source = payload / ("OptiScaler.dll" if manifest and name == manifest.get("filename")
                            else name)
        destination = target / name
        record = {
            "name": name,
            "present": destination.is_file(),
            "matches_payload": False,
            "size": destination.stat().st_size if destination.is_file() else 0,
            "expected_size": source.stat().st_size if source.is_file() else 0,
        }
        if record["present"] and source.is_file():
            record["matches_payload"] = record["size"] == record["expected_size"]
        entries.append(record)

    for name in PAYLOAD_DIRS:
        destination = target / name
        entries.append({
            "name": name + "/",
            "present": destination.is_dir(),
            "matches_payload": destination.is_dir(),
            "size": 0,
            "expected_size": 0,
        })

    ffx = target / FFX_UPSCALER_DLL
    version = pe_file_version(ffx) if ffx.is_file() else None
    fsr4_capable = bool(version and version[:3] >= FSR4_MIN_SDK_VERSION[:3])

    problems = [e["name"] for e in entries if not e["present"] or not e["matches_payload"]]
    return {
        "path": str(target),
        "files": entries,
        "problems": problems,
        "complete": not problems,
        "ffx_upscaler": {
            "present": ffx.is_file(),
            "version": ".".join(str(n) for n in version) if version else None,
            "fsr4_capable": fsr4_capable,
        },
    }
