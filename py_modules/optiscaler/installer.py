"""Install, detect and remove OptiScaler inside a game directory.

Mirrors what the official setup_linux.sh does — copy the release next to the
game executable and rename OptiScaler.dll to a proxy filename the game already
loads — but records a manifest and stashes every displaced file in a visible
backup folder, so an uninstall can put the game back exactly as it was.
"""

import json
import os
import re
import shutil
import stat
import threading
import time
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from pathlib import PurePosixPath

from . import constants, fsr4build, live, schema
from .inifile import IniFile
from .constants import (
    OPTIPATCHER_NAME,
    OPTIPATCHER_SHA256,
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
RESTORE_DIR = ".decky_optiscaler_restore"
TRANSACTION_PREFIX = ".decky-optiscaler-tx-"
TRANSACTION_PREPARING_PREFIX = ".decky-optiscaler-tx-preparing-"
TRANSACTION_RETIRING_PREFIX = ".decky-optiscaler-tx-cleanup-"
TRANSACTION_COPY_PREFIX = ".decky-optiscaler-copy-"
RESTOREPOINT_STAGING_PREFIX = ".decky-restorepoint-"
TRANSACTION_RECORD = "journal.json"
TRANSACTION_LEGACY_VERSION = 1
TRANSACTION_VERSION = 2
TRANSACTION_FILE = "file"
TRANSACTION_SHARED_DIR = "shared_dir"
TRANSACTION_PRIVATE_TREE = "private_tree"
TRANSACTION_INTENT_STOPPED = "stopped"
TRANSACTION_INTENT_NORMAL = "normal"
TRANSACTION_INTENT_MANAGED_INI = "managed_ini"
TRANSACTION_INTENTS = {TRANSACTION_INTENT_NORMAL, TRANSACTION_INTENT_STOPPED,
                       TRANSACTION_INTENT_MANAGED_INI}

_TRANSACTIONS = threading.local()


def _allowed_file_names():
    nested = _payload_nested_names()
    return (set(PROXY_FILENAMES) | set(PAYLOAD_FILES) | set(FSR4_SUPPORT_FILES)
            | set(RUNTIME_ARTIFACTS) | {INI_NAME, LOG_NAME, REFRAMEWORK_DLL,
                                       "remove_optiscaler.sh",
                                       *live.CONTROL_FILES,
                                       f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}",
                                       f"{live.PLUGIN_SUBDIR}/{OPTIPATCHER_NAME}"}
            | set(nested))


def _allowed_dir_names():
    return set(PAYLOAD_DIRS) | {"DlssOverrides", live.PLUGIN_SUBDIR}


def _shared_dir_names():
    names = set(_allowed_dir_names())
    for name in _allowed_file_names():
        parts = PurePosixPath(name).parts
        names.update(PurePosixPath(*parts[:index]).as_posix()
                     for index in range(1, len(parts)))
    return names


def _transaction_kind(name):
    if name.casefold() in {BACKUP_DIR.casefold(), RESTORE_DIR.casefold()} or (
            "/" not in name and name.startswith(RESTOREPOINT_STAGING_PREFIX)):
        return TRANSACTION_PRIVATE_TREE
    if name.casefold() in {item.casefold() for item in _shared_dir_names()}:
        return TRANSACTION_SHARED_DIR
    return TRANSACTION_FILE


def _payload_nested_names(payload_root=None):
    from . import payload as runtime_payload

    inventory = runtime_payload.required_inventory()
    return sorted(name for name in inventory["files"] if "/" in name)


def _relative_name(name):
    """Normalize a manifest or transaction path without accepting traversal."""
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise ValueError(f"invalid managed path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"invalid managed path: {name!r}")
    normalized = path.as_posix()
    if normalized != name:
        raise ValueError(f"invalid managed path: {name!r}")
    return normalized


def _validate_owned_name(name, directory=False):
    normalized = _relative_name(name)
    allowed = _allowed_dir_names() if directory else _allowed_file_names()
    allowed_casefold = {item.casefold() for item in allowed}
    if normalized not in allowed and normalized.casefold() not in allowed_casefold:
        raise ValueError(f"unsupported managed {'directory' if directory else 'file'}: {name}")
    return normalized


def _legacy_backup_target(name):
    """Return the supported root-level destination for a v0.1 .bak file."""
    if not isinstance(name, str) or "/" in name or "\\" in name:
        return None
    suffix = LEGACY_BACKUP_SUFFIX
    if not name.casefold().endswith(suffix.casefold()):
        return None
    destination = name[:-len(suffix)]
    try:
        return _validate_owned_name(destination)
    except ValueError:
        return None


def _safe_path(target, name):
    """Return a target-contained path, refusing symlinked parent components."""
    normalized = _relative_name(name)
    root = Path(target).resolve()
    path = root
    for part in PurePosixPath(normalized).parts[:-1]:
        path = path / part
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode):
            raise ValueError(f"managed path crosses a symlink: {normalized}")
        if not stat.S_ISDIR(mode):
            raise ValueError(f"managed path parent is not a directory: {normalized}")
    result = root.joinpath(*PurePosixPath(normalized).parts)
    try:
        result.resolve(strict=False).relative_to(root)
    except ValueError as exc:
        raise ValueError(f"managed path leaves install target: {normalized}") from exc
    return result


def _install_relative_path(target_dir, destination):
    """Map a lexical destination onto the resolved install root without hiding links."""
    target_lexical = Path(os.path.abspath(os.fspath(target_dir)))
    target_resolved = target_lexical.resolve()
    destination = Path(destination)
    if ".." in destination.parts:
        raise ValueError(f"destination contains parent traversal: {destination}")
    if destination.is_absolute():
        destination_lexical = Path(os.path.abspath(os.fspath(destination)))
        try:
            relative = destination_lexical.relative_to(target_lexical)
        except ValueError:
            # Some callers already hold a path returned by _safe_path, which
            # uses the resolved spelling of a symlinked root (e.g. /private/var).
            try:
                relative = destination_lexical.relative_to(target_resolved)
            except ValueError as exc:
                raise ValueError(f"destination leaves install target: {destination}") from exc
    else:
        relative = destination
    return target_resolved, _relative_name(relative.as_posix())


def _remove_path(path):
    """Remove a path itself without following a final symlink."""
    path = Path(path)
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
        path.unlink()
    else:
        shutil.rmtree(path)
    return True


def _existing_mode(path):
    try:
        return Path(path).lstat().st_mode
    except FileNotFoundError:
        return None


def _require_path_type(path, directory=False, allow_missing=True):
    mode = _existing_mode(path)
    if mode is None:
        if allow_missing:
            return False
        raise FileNotFoundError(path)
    expected = stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)
    if not expected:
        kind = "directory" if directory else "regular file"
        raise ValueError(f"expected {kind} at {path}")
    return True


def _assert_plain_tree(root):
    root = Path(root)
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise ValueError(f"expected directory at {root}")
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(base) / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise ValueError(f"directory tree contains an unsafe object: {path}")


def _merge_directory_tree(source, destination, target_dir, replace_files=None):
    """Restore pinned originals and missing legacy files without clobbering additions."""
    source, destination = Path(source), Path(destination)
    game_target = Path(target_dir).resolve()
    replace_files = set(replace_files or ())
    restore_files = set()
    deferred_files = set()
    needed_dirs = {"."}

    _assert_plain_tree(source)
    _require_path_type(destination, directory=True)
    # Whole-directory backups are from old manifests that could have stashed
    # user files alongside the bundled licenses. Return each missing file, but
    # leave a later file at the same path untouched unless it is a known
    # bundled path whose original is explicitly being restored.
    for base, dirs, files in os.walk(source, followlinks=False):
        relative = Path(base).relative_to(source)
        relative_text = "." if not relative.parts else relative.as_posix()
        needed_dirs.add(relative_text)
        destination_dir = destination if relative_text == "." else destination / relative
        relative_dir = destination_dir.relative_to(game_target).as_posix()
        _safe_path(game_target, relative_dir)
        mode = _existing_mode(destination_dir)
        if mode is not None and not stat.S_ISDIR(mode):
            raise ValueError(f"directory backup collides with a non-directory: {destination_dir}")
        for name in files:
            relative_file = (relative / name).as_posix()
            item = destination / relative / name
            if game_target is not None:
                relative_item = item.relative_to(game_target).as_posix()
                item = _safe_path(game_target, relative_item)
            current = _existing_mode(item)
            if current is not None and not stat.S_ISREG(current):
                raise ValueError(f"file backup collides with a non-file: {item}")
            if relative_file in replace_files or current is None:
                restore_files.add(relative_file)
                parts = PurePosixPath(relative_file).parts
                needed_dirs.update(PurePosixPath(*parts[:index]).as_posix()
                                   for index in range(1, len(parts)))
            else:
                # Two valid regular files exist for this unknown legacy path.
                # Keep the current target and retain the backup until the user
                # resolves the ambiguity; silently deleting either would lose data.
                deferred_files.add(relative_file)

    def make_merge_directory_writable(path):
        mode = _existing_mode(path)
        if mode is not None and stat.S_ISDIR(mode):
            permissions = stat.S_IMODE(mode)
            writable = permissions | stat.S_IWUSR | stat.S_IXUSR
            if writable != permissions:
                os.chmod(path, writable)

    directory_pairs = []
    for base, dirs, files in os.walk(source, followlinks=False):
        relative = Path(base).relative_to(source)
        relative_text = "." if not relative.parts else relative.as_posix()
        if relative_text not in needed_dirs:
            dirs[:] = []
            continue
        target_base = destination / relative
        mode = _existing_mode(target_base)
        if mode is not None and not stat.S_ISDIR(mode):
            raise ValueError(f"directory backup collides with a non-directory: {target_base}")
        target_base.mkdir(parents=True, exist_ok=True)
        make_merge_directory_writable(target_base)
        directory_pairs.append((Path(base), target_base))
        for name in dirs:
            source_dir = Path(base) / name
            source_relative = source_dir.relative_to(source).as_posix()
            if source_relative not in needed_dirs:
                continue
            item = target_base / name
            mode = _existing_mode(item)
            if mode is not None and not stat.S_ISDIR(mode):
                raise ValueError(f"directory backup collides with a non-directory: {item}")
            item.mkdir(parents=True, exist_ok=True)
            make_merge_directory_writable(item)
        for name in files:
            original = Path(base) / name
            item = target_base / name
            relative_file = (relative / name).as_posix()
            if relative_file not in restore_files:
                continue
            mode = _existing_mode(item)
            if mode is not None and not stat.S_ISREG(mode):
                raise ValueError(f"file backup collides with a non-file: {item}")
            # atomic_copy records its same-filesystem stage in the active game
            # transaction, so a hard exit leaves a recoverable journal.
            atomic_copy(original, item, target_dir=game_target)
    for source_dir, dest_dir in sorted(
            directory_pairs,
            key=lambda pair: len(pair[0].relative_to(source).parts), reverse=True):
        require_stopped_target(game_target)
        if dest_dir.exists():
            shutil.copystat(source_dir, dest_dir, follow_symlinks=False)
    return sorted(deferred_files)


def _copy_path(source, destination):
    """Copy a regular file/tree or preserve a symlink as a symlink."""
    source, destination = Path(source), Path(destination)
    mode = source.lstat().st_mode
    if stat.S_ISLNK(mode):
        os.symlink(os.readlink(source), destination)
    elif stat.S_ISDIR(mode):
        shutil.copytree(source, destination, symlinks=True, copy_function=shutil.copy2)
    elif stat.S_ISREG(mode):
        shutil.copy2(source, destination, follow_symlinks=False)
    else:
        raise ValueError(f"unsupported filesystem object in install target: {source}")


def _atomic_json(path, data):
    path = Path(path)
    target = path.parent.resolve()
    if path.name == MANIFEST_NAME and target.is_dir():
        active = getattr(_TRANSACTIONS, "targets", {})
        state = active.get(str(target))
        if state is None:
            with target_transaction(target, extra_names=(MANIFEST_NAME,), require_stopped=True):
                return _atomic_json(path, data)
        try:
            current_mode = path.lstat().st_mode
        except FileNotFoundError:
            current_mode = None
        if current_mode is not None and not stat.S_ISREG(current_mode):
            raise ValueError(f"refusing to replace non-regular manifest: {path}")
        stage_root = Path(state["journal"]) / "metadata-staging"
        stage_root.mkdir(exist_ok=True)
        temporary = stage_root / f"manifest-{uuid.uuid4().hex}"
        temporary.write_text(json.dumps(data, indent=2), encoding="utf-8")
        if current_mode is not None:
            os.chmod(temporary, stat.S_IMODE(current_mode))
        os.replace(temporary, path)
        return

    fd, temporary = tempfile.mkstemp(prefix=".decky-optiscaler-manifest-", dir=path.parent)
    os.close(fd)
    try:
        Path(temporary).write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


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


def _path_exists(path):
    try:
        Path(path).lstat()
        return True
    except FileNotFoundError:
        return False


def read_manifest(target_dir):
    path = _safe_path(target_dir, MANIFEST_NAME)
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(mode):
        raise ValueError("OptiScaler manifest is not a regular file")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"OptiScaler manifest is invalid: {exc}") from exc
    return validate_manifest(manifest)


def validate_manifest(manifest):
    """Reject malformed or unsafe ownership records before they drive mutations."""
    if not isinstance(manifest, dict) or manifest.get("plugin") != "decky-optiscaler":
        raise ValueError("OptiScaler manifest has an unexpected plugin identifier")

    filename = manifest.get("filename")
    if filename is not None and filename not in PROXY_FILENAMES:
        raise ValueError(f"OptiScaler manifest has an unsupported proxy filename: {filename!r}")
    if "backup_dir" in manifest and manifest["backup_dir"] != BACKUP_DIR:
        raise ValueError("OptiScaler manifest has an unsupported backup directory")

    for field, directory in (("files", False), ("dirs", True)):
        items = manifest.get(field, [])
        if not isinstance(items, list):
            raise ValueError(f"OptiScaler manifest {field} must be a list")
        seen = set()
        for item in items:
            name = _validate_owned_name(item, directory)
            identity = name.casefold()
            if identity in seen:
                raise ValueError(f"OptiScaler manifest repeats {field} entry: {name}")
            seen.add(identity)

    backups = manifest.get("backups", {})
    if not isinstance(backups, dict):
        raise ValueError("OptiScaler manifest backups must be an object")
    seen_backups = set()
    for name, stored_name in backups.items():
        normalized = _relative_name(name)
        if normalized.casefold() not in {
                item.casefold() for item in (_allowed_file_names() | _allowed_dir_names())}:
            raise ValueError(f"OptiScaler manifest has an unsupported backup path: {name}")
        if normalized.casefold() in seen_backups:
            raise ValueError(f"OptiScaler manifest repeats backup path: {name}")
        seen_backups.add(normalized.casefold())
        if not isinstance(stored_name, str):
            raise ValueError(f"OptiScaler manifest backup record is invalid: {name}")
        stored = _relative_name(stored_name)
        if stored not in (normalized, PurePosixPath(normalized).name):
            raise ValueError(f"OptiScaler manifest backup path does not match: {name}")
    runtime_owned = manifest.get("runtime_artifacts_owned", [])
    if not isinstance(runtime_owned, list):
        raise ValueError("OptiScaler manifest runtime_artifacts_owned must be a list")
    for name in runtime_owned:
        if name not in RUNTIME_ARTIFACTS:
            raise ValueError(f"OptiScaler manifest has an unsupported runtime artifact: {name}")
    created_dirs = manifest.get("created_directories", [])
    if not isinstance(created_dirs, list):
        raise ValueError("OptiScaler manifest created_directories must be a list")
    for name in created_dirs:
        if name not in set(PAYLOAD_DIRS) | {live.PLUGIN_SUBDIR}:
            raise ValueError(f"OptiScaler manifest has an unsupported created directory: {name}")
    original_dirs = manifest.get("original_directories", {})
    if not isinstance(original_dirs, dict):
        raise ValueError("OptiScaler manifest original_directories must be an object")
    for name, record in original_dirs.items():
        if name not in PAYLOAD_DIRS:
            raise ValueError(f"OptiScaler manifest has an unsupported original directory: {name}")
        if not isinstance(record, dict) or set(record) != {"exists", "mode"} \
                or not isinstance(record.get("exists"), bool):
            raise ValueError(f"OptiScaler manifest original directory record is invalid: {name}")
        mode = record.get("mode")
        if record["exists"]:
            if isinstance(mode, bool) or not isinstance(mode, int) or not 0 <= mode <= 0o7777:
                raise ValueError(f"OptiScaler manifest original directory mode is invalid: {name}")
        elif mode is not None:
            raise ValueError(f"OptiScaler manifest absent directory has a mode: {name}")
    return manifest


def backup_dir(target_dir):
    return Path(target_dir) / BACKUP_DIR


def _transaction_paths(target, extra_names=(), include_known=True):
    """Known writable assets plus paths listed by the current safe manifest."""
    names = {MANIFEST_NAME, INI_NAME}
    if include_known:
        names.update({LAUNCH_RECORD_NAME, BACKUP_DIR, LOG_NAME,
                      "remove_optiscaler.sh", *PROXY_FILENAMES, *PAYLOAD_FILES,
                      *PAYLOAD_DIRS, *FSR4_SUPPORT_FILES, *RUNTIME_ARTIFACTS,
                      *_payload_nested_names(), REFRAMEWORK_DLL,
                      "DlssOverrides", f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}",
                      f"{live.PLUGIN_SUBDIR}/{OPTIPATCHER_NAME}",
                      *live.CONTROL_FILES})
    manifest = read_manifest(target)
    if manifest and include_known:
        names.update(manifest.get("files", []))
        names.update(manifest.get("dirs", []))
    if manifest and include_known:
        names.update(manifest.get("backups", {}).keys())
    if isinstance(extra_names, str):
        extra_names = (extra_names,)
    for name in extra_names or ():
        names.add(_relative_name(name))

    # Wine treats root-level managed names without case sensitivity. Snapshot
    # an existing Linux spelling alongside the canonical name so a migration
    # can stash and later restore that original byte-for-byte.
    root_names = {name for name in names if "/" not in name}
    if root_names:
        try:
            children = list(Path(target).iterdir())
        except OSError as exc:
            raise ValueError(f"Cannot inspect managed root paths: {exc}") from exc
        for name in root_names:
            matches = [item.name for item in children if item.name.casefold() == name.casefold()]
            if len(matches) > 1:
                raise ValueError(f"Multiple Wine-equivalent paths exist for managed name {name}.")
            if matches:
                names.add(matches[0])

    # Record parent directories separately. Shared directories are restored by
    # mode only; their files are tracked by exact managed path.
    for name in list(names):
        parts = PurePosixPath(_relative_name(name)).parts
        for index in range(1, len(parts)):
            names.add(PurePosixPath(*parts[:index]).as_posix())
    return sorted({_relative_name(name) for name in names})


def _snapshot_into(target, journal, names, records, extra_dirs=()):
    entries = journal / "entries"
    entries.mkdir(parents=True, exist_ok=True)
    already = {record["name"] for record in records}
    private_trees = {record["name"] for record in records
                     if record.get("kind") == TRANSACTION_PRIVATE_TREE}
    for name in names:
        name = _relative_name(name)
        if name in already:
            continue
        if any(name.startswith(existing + "/") for existing in private_trees):
            continue
        source = _safe_path(target, name)
        kind = (TRANSACTION_SHARED_DIR if name in extra_dirs
                else _transaction_kind(name))
        record = {"name": name, "kind": kind, "exists": False}
        if kind == TRANSACTION_SHARED_DIR:
            record["mode"] = None
        else:
            record["stored"] = None
        try:
            mode = source.lstat().st_mode
        except FileNotFoundError:
            records.append(record)
            already.add(name)
            if kind == TRANSACTION_PRIVATE_TREE:
                private_trees.add(name)
            continue
        if kind == TRANSACTION_SHARED_DIR:
            if not stat.S_ISDIR(mode):
                raise ValueError(f"managed shared directory has an unexpected type: {source}")
            record["mode"] = stat.S_IMODE(mode)
            record["exists"] = True
            records.append(record)
            already.add(name)
            continue
        if kind == TRANSACTION_PRIVATE_TREE:
            if not stat.S_ISDIR(mode):
                raise ValueError(f"managed private tree has an unexpected type: {source}")
            _assert_plain_tree(source)
        elif not stat.S_ISREG(mode):
            raise ValueError(f"managed transaction file has an unexpected type: {source}")
        record["exists"] = True
        record["stored"] = f"{len(records):06d}"
        _copy_path(source, entries / record["stored"])
        records.append(record)
        already.add(name)
        if kind == TRANSACTION_PRIVATE_TREE:
            private_trees.add(name)


def _transaction_record(state, target, status="active"):
    return {
        "version": TRANSACTION_VERSION,
        "target": str(target),
        "status": status,
        "require_stopped": bool(state.get("require_stopped")),
        "intent": state.get("intent", TRANSACTION_INTENT_NORMAL),
        "records": state["records"],
    }


def _persist_transaction(state, target, status="active"):
    _atomic_json(state["journal"] / TRANSACTION_RECORD,
                 _transaction_record(state, target, status))


def _validate_casefold_transaction_aliases(records, canonical_names):
    """Accept a single existing spelling, or two equivalent absent records."""
    canonical = {name for name in canonical_names if "/" not in name}
    groups = {}
    for record in records:
        name = _relative_name(record["name"])
        groups.setdefault(name.casefold(), []).append(record)
    for group in groups.values():
        if len(group) == 1:
            continue
        if len(group) != 2 or any("/" in item["name"] for item in group):
            raise ValueError("transaction repeats a Wine-equivalent path")
        canonical_record = next(
            (item for item in group if item["name"] in canonical), None
        )
        alias_record = next(
            (item for item in group if item is not canonical_record), None
        )
        if (canonical_record is None or alias_record is None
                or canonical_record["name"] == alias_record["name"]
                or sum(item.get("exists") is True for item in group) > 1):
            raise ValueError("transaction has conflicting Wine-equivalent paths")


def _validate_managed_ini_records(target, journal, records, version=TRANSACTION_VERSION):
    """Validate the whole running-config recovery plan before its first write."""
    target = Path(target).resolve()
    allowed_names = {INI_NAME, MANIFEST_NAME}
    by_folded = {}
    for record in records:
        name = _relative_name(record["name"])
        if version == TRANSACTION_VERSION and record.get("kind") != TRANSACTION_FILE:
            raise ValueError(f"managed INI recovery contains a non-file record: {name}")
        if "/" in name:
            raise ValueError(f"managed INI recovery path is not at the game root: {name}")
        folded = name.casefold()
        copy_stage = folded.startswith(TRANSACTION_COPY_PREFIX.casefold())
        if folded not in {item.casefold() for item in allowed_names} and not copy_stage:
            raise ValueError(f"managed INI recovery contains an out-of-scope path: {name}")
        if copy_stage and not re.fullmatch(
                re.escape(TRANSACTION_COPY_PREFIX) + r"[0-9a-f]{32}", name,
                flags=re.IGNORECASE):
            raise ValueError(f"managed INI recovery has an invalid staging name: {name}")
        by_folded.setdefault(folded, []).append(record)

        destination = _safe_path(target, name)
        current = _existing_mode(destination)
        if current is not None and not stat.S_ISREG(current):
            raise ValueError(f"managed INI recovery target is not a regular file: {destination}")
        if copy_stage and record.get("exists"):
            raise ValueError(f"managed INI staging was not absent at transaction start: {name}")
        if record.get("exists"):
            saved = Path(journal) / "entries" / str(record.get("stored"))
            try:
                saved_mode = saved.lstat().st_mode
            except OSError as exc:
                raise ValueError(f"managed INI recovery content is missing: {name}") from exc
            if not stat.S_ISREG(saved_mode):
                raise ValueError(f"managed INI recovery content is not a regular file: {name}")
        elif record.get("stored") is not None:
            raise ValueError(f"managed INI absent record has content: {name}")

    _validate_casefold_transaction_aliases(records, allowed_names)
    ini_record = next((item for item in by_folded.get(INI_NAME.casefold(), [])
                       if item.get("exists")), None)
    manifest_record = next((item for item in by_folded.get(MANIFEST_NAME.casefold(), [])
                            if item.get("exists")), None)
    if not ini_record or not ini_record.get("exists"):
        raise ValueError("managed INI recovery has no original OptiScaler.ini")
    if not manifest_record or not manifest_record.get("exists"):
        raise ValueError("managed INI recovery has no original install manifest")


def _restore_snapshot(target, journal, records, require_stopped, intent=None):
    intent = intent or TRANSACTION_INTENT_STOPPED
    if intent == TRANSACTION_INTENT_MANAGED_INI:
        _validate_managed_ini_records(target, journal, records)
    _validate_transaction_records(target, journal, records, intent,
                                  version=TRANSACTION_VERSION)
    if require_stopped:
        require_stopped_target(target)
    staging_root = journal / "restore-staging"
    staging_root.mkdir(exist_ok=True)
    # Restore parent metadata before exact files. Private trees are deliberately
    # the only records whose whole contents are replaced.
    def restore_order(item):
        depth = len(PurePosixPath(item["name"]).parts)
        kind = item.get("kind")
        if kind == TRANSACTION_SHARED_DIR and item["exists"]:
            return 0, depth
        if kind == TRANSACTION_SHARED_DIR:
            return 2, -depth
        return 1, depth

    ordered = sorted(records, key=restore_order)
    for index, record in enumerate(ordered):
        if require_stopped:
            require_stopped_target(target)
        destination = _safe_path(target, record["name"])
        kind = record["kind"]
        current_mode = _existing_mode(destination)
        if kind == TRANSACTION_SHARED_DIR:
            if current_mode is not None and not stat.S_ISDIR(current_mode):
                raise ValueError(f"shared directory changed type during recovery: {destination}")
            if not record["exists"]:
                if current_mode is not None:
                    try:
                        empty = not any(destination.iterdir())
                    except OSError:
                        empty = False
                    if empty:
                        destination.rmdir()
                continue
            if current_mode is None:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.mkdir(mode=record["mode"] | 0o300)
            else:
                writable_mode = stat.S_IMODE(current_mode) | 0o300
                if writable_mode != stat.S_IMODE(current_mode):
                    os.chmod(destination, writable_mode)
            continue

        if kind == TRANSACTION_PRIVATE_TREE:
            if current_mode is not None and not stat.S_ISDIR(current_mode):
                raise ValueError(f"private recovery tree changed type: {destination}")
            if not record["exists"]:
                if current_mode is not None:
                    _remove_path(destination)
                continue
            saved = journal / "entries" / record["stored"]
            staged = staging_root / f"new-{index:06d}"
            old = staging_root / f"old-{index:06d}"
            if _path_exists(staged):
                _remove_path(staged)
            if _path_exists(old):
                _remove_path(old)
            _copy_path(saved, staged)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if current_mode is not None:
                os.replace(destination, old)
            try:
                os.replace(staged, destination)
            except Exception:
                if current_mode is not None and _path_exists(old):
                    os.replace(old, destination)
                raise
            if _path_exists(old):
                _remove_path(old)
            continue

        if not record["exists"]:
            if current_mode is not None:
                if not stat.S_ISREG(current_mode):
                    raise ValueError(f"managed file changed type during recovery: {destination}")
                destination.unlink()
            continue
        saved = journal / "entries" / record["stored"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        while True:
            staged = destination.with_name(f"{TRANSACTION_COPY_PREFIX}{uuid.uuid4().hex}")
            relative_stage = staged.relative_to(target).as_posix()
            _safe_path(target, relative_stage)
            if not _path_exists(staged):
                break
        _snapshot_into(target, journal, (relative_stage,), records)
        _persist_transaction({"journal": journal, "records": records,
                              "require_stopped": require_stopped,
                              "intent": intent}, target)
        descriptor = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        try:
            _copy_path(saved, staged)
            if require_stopped:
                require_stopped_target(target)
            current = _existing_mode(destination)
            if current is not None and not stat.S_ISREG(current):
                raise ValueError(f"refusing to replace a non-file during recovery: {destination}")
            if require_stopped:
                require_stopped_target(target)
            os.replace(staged, destination)
        finally:
            staged.unlink(missing_ok=True)

    for record in sorted(
            (item for item in ordered
             if item.get("kind") == TRANSACTION_SHARED_DIR and item["exists"]),
            key=lambda item: len(PurePosixPath(item["name"]).parts), reverse=True):
        destination = _safe_path(target, record["name"])
        current = _existing_mode(destination)
        if current is not None:
            if not stat.S_ISDIR(current):
                raise ValueError(f"shared directory changed type during recovery: {destination}")
            os.chmod(destination, record["mode"])


def _validate_transaction_records(target, journal, records, intent=None,
                                  version=TRANSACTION_VERSION):
    if not isinstance(records, list):
        raise ValueError("transaction journal records are invalid")
    entries = Path(journal) / "entries"
    if entries.is_symlink() or not entries.is_dir():
        raise ValueError("transaction journal entries are missing or unsafe")
    allowed = (_allowed_file_names() | _shared_dir_names() | {
        MANIFEST_NAME, LAUNCH_RECORD_NAME, BACKUP_DIR, RESTORE_DIR,
    })
    allowed_casefold = {name.casefold() for name in allowed}
    stored_ids = set()
    for item in records:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ValueError("transaction journal contains an invalid path record")
        name = _relative_name(item["name"])
        leaf = PurePosixPath(name).name
        copy_stage = leaf.casefold().startswith(TRANSACTION_COPY_PREFIX.casefold())
        restorepoint_stage = ("/" not in name and
                              name.casefold().startswith(RESTOREPOINT_STAGING_PREFIX.casefold()))
        payload_tree_path = any(name.casefold().startswith(directory.casefold() + "/")
                                for directory in PAYLOAD_DIRS)
        if (name.casefold() not in allowed_casefold
                and _legacy_backup_target(name) is None
                and not copy_stage and not restorepoint_stage
                and not payload_tree_path):
            raise ValueError(f"transaction journal contains an unsupported path: {name}")
        if restorepoint_stage and "/" in name:
            raise ValueError("restorepoint staging must be a root-level path")
        if not isinstance(item.get("exists"), bool):
            raise ValueError(f"transaction journal has an invalid existence record: {name}")
        if (copy_stage or restorepoint_stage) and item["exists"]:
            raise ValueError(f"transaction staging path was not absent at start: {name}")
        if version == TRANSACTION_LEGACY_VERSION:
            kind = _transaction_kind(name)
            if kind == TRANSACTION_SHARED_DIR:
                raise ValueError(
                    f"active version-1 shared directory snapshot is ambiguous: {name}"
                )
        elif version == TRANSACTION_VERSION:
            kind = item.get("kind")
            if kind not in (TRANSACTION_FILE, TRANSACTION_SHARED_DIR,
                            TRANSACTION_PRIVATE_TREE):
                raise ValueError(f"transaction journal has an invalid record kind: {name}")
            if kind != _transaction_kind(name) and not (
                    payload_tree_path and _transaction_kind(name) == TRANSACTION_FILE
                    and kind == TRANSACTION_SHARED_DIR):
                raise ValueError(f"transaction journal record kind does not match its path: {name}")
        else:
            raise ValueError("transaction journal has an unsupported version")

        if kind == TRANSACTION_SHARED_DIR:
            if item.get("stored") is not None:
                raise ValueError(f"shared directory record contains a tree snapshot: {name}")
            directory_mode = item.get("mode")
            if item["exists"]:
                if isinstance(directory_mode, bool) or not isinstance(directory_mode, int) \
                        or not 0 <= directory_mode <= 0o7777:
                    raise ValueError(f"shared directory mode is invalid: {name}")
            elif directory_mode is not None:
                raise ValueError(f"absent shared directory has a mode: {name}")
            current = _existing_mode(_safe_path(target, name))
            if current is not None and not stat.S_ISDIR(current):
                raise ValueError(f"shared directory changed type: {name}")
            continue

        if not item["exists"]:
            if item.get("stored") is not None:
                raise ValueError(f"transaction journal has invalid absent record: {name}")
            if version == TRANSACTION_VERSION and kind != TRANSACTION_SHARED_DIR \
                    and item.get("mode") is not None:
                raise ValueError(f"absent transaction path has directory metadata: {name}")
            current = _existing_mode(_safe_path(target, name))
            if current is not None and (
                    (kind == TRANSACTION_FILE and not stat.S_ISREG(current))
                    or (kind == TRANSACTION_PRIVATE_TREE and not stat.S_ISDIR(current))):
                raise ValueError(f"transaction target changed type: {name}")
            continue

        stored = item.get("stored")
        if not isinstance(stored, str) or not stored.isdigit() or stored in stored_ids:
            raise ValueError(f"transaction journal has invalid content mapping: {name}")
        stored_ids.add(stored)
        saved = entries / stored
        saved_mode = _existing_mode(saved)
        if saved_mode is None or stat.S_ISLNK(saved_mode):
            raise ValueError(f"transaction journal content is missing or unsafe: {name}")
        if kind == TRANSACTION_PRIVATE_TREE:
            if not stat.S_ISDIR(saved_mode):
                raise ValueError(f"private tree snapshot is not a directory: {name}")
            _assert_plain_tree(saved)
            if version == TRANSACTION_VERSION and item.get("mode") is not None:
                raise ValueError(f"private tree record contains directory metadata: {name}")
        elif not stat.S_ISREG(saved_mode):
            raise ValueError(f"transaction file snapshot is not a regular file: {name}")
        current = _existing_mode(_safe_path(target, name))
        if current is not None and (
                (kind == TRANSACTION_FILE and not stat.S_ISREG(current))
                or (kind == TRANSACTION_PRIVATE_TREE and not stat.S_ISDIR(current))):
            raise ValueError(f"transaction target changed type: {name}")
        if version == TRANSACTION_VERSION and kind != TRANSACTION_PRIVATE_TREE \
                and item.get("mode") is not None:
            raise ValueError(f"transaction file record contains directory metadata: {name}")
    _validate_casefold_transaction_aliases(
        records, allowed | {MANIFEST_NAME, LAUNCH_RECORD_NAME, BACKUP_DIR, RESTORE_DIR}
    )
    if intent == TRANSACTION_INTENT_MANAGED_INI:
        _validate_managed_ini_records(target, journal, records, version)


def _preflight_live_asi_identity(target, live_asi=None, plugin_root=None,
                                 allow_plugin_alias=False):
    """Check only the ASI namespace; config and mailbox aliases are journaled separately."""
    target = Path(target).resolve()
    plugin_dir = _casefold_root_child(
        target, live.PLUGIN_SUBDIR, "plugins directory", allow_alias=allow_plugin_alias
    )
    if _path_exists(plugin_dir):
        _require_path_type(plugin_dir, directory=True, allow_missing=False)
    if live_asi is not None:
        live.validate_live_source(live_asi, plugin_root)
    if not _path_exists(plugin_dir):
        return False
    if plugin_dir.is_symlink() or not plugin_dir.is_dir():
        raise ValueError("Cannot safely inspect the default OptiScaler plugins directory.")

    expected = {
        getattr(constants, "LEGACY_LIVE_ASI_SHA256", ""),
        *getattr(constants, "UPGRADE_LIVE_ASI_SHA256", ()),
        live.known_asi_sha256(plugin_root),
    }
    if live_asi is not None:
        try:
            expected.add(_sha256_file(live_asi))
        except OSError as exc:
            raise ValueError(f"Cannot inspect packaged live ASI: {exc}") from exc
    expected.discard(None)
    expected.discard("")
    found_legacy = False
    for entry in plugin_dir.iterdir():
        if entry.suffix.casefold() != ".asi":
            continue
        mode = entry.lstat().st_mode
        if not stat.S_ISREG(mode):
            raise ValueError(f"Cannot safely inspect ASI plugin: {entry}")
        try:
            actual_hash = _sha256_file(entry)
        except OSError as exc:
            raise ValueError(f"Cannot inspect ASI plugin {entry}: {exc}") from exc
        canonical = entry.name.casefold() == live.ASI_NAME.casefold()
        if canonical:
            if entry.name != live.ASI_NAME:
                raise ValueError(
                    f"Cannot safely upgrade through noncanonical live ASI name: {entry.name}."
                )
            if actual_hash not in expected:
                raise ValueError(
                    f"Cannot safely upgrade because {entry.name} has unknown bytes."
                )
            found_legacy = found_legacy or actual_hash in {
                getattr(constants, "LEGACY_LIVE_ASI_SHA256", ""),
                *getattr(constants, "UPGRADE_LIVE_ASI_SHA256", ()),
            }
        elif actual_hash in expected:
            raise ValueError(
                f"Cannot safely upgrade because a renamed live ASI may load: {entry.name}."
            )
    return found_legacy


def _preflight_recovery_live_asi(target):
    """Refuse an unknown live ASI before recovery or transaction writes begin."""
    _preflight_live_asi_identity(target, allow_plugin_alias=True)


def _upgrade_v1_transaction_records(records):
    upgraded = []
    for record in records:
        item = dict(record)
        item["kind"] = _transaction_kind(_relative_name(item["name"]))
        upgraded.append(item)
    return upgraded


def recover_target_transactions(target_dir):
    """Retry any interrupted target operation before allowing a new mutation."""
    target = Path(target_dir).resolve()
    if not target.is_dir():
        return []
    _preflight_recovery_live_asi(target)
    active = getattr(_TRANSACTIONS, "targets", {})
    if str(target) in active:
        return []

    recovered = []
    for path in sorted(target.iterdir()):
        if path.name.startswith(TRANSACTION_RETIRING_PREFIX):
            if path.is_symlink() or not path.is_dir():
                raise RuntimeError(f"unsafe retired transaction cleanup path: {path}")
            shutil.rmtree(path)
            recovered.append({"path": path.name, "action": "cleaned"})
            continue
        if path.name.startswith(TRANSACTION_PREPARING_PREFIX):
            if path.is_symlink() or not path.is_dir():
                raise RuntimeError(f"unsafe incomplete transaction staging path: {path}")
            shutil.rmtree(path)
            continue
        if not path.name.startswith(TRANSACTION_PREFIX):
            continue
        if path.is_symlink() or not path.is_dir():
            raise RuntimeError(f"unsafe transaction journal path: {path}")
        record_path = path / TRANSACTION_RECORD
        if record_path.is_symlink() or not record_path.is_file():
            # New journals are atomically published only after their complete
            # snapshot and mapping exist. An older or damaged journal is not
            # safe to guess at, so block mutations and keep its bytes in place.
            raise RuntimeError(f"transaction journal is incomplete or unreadable: {path}")
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"transaction journal is invalid: {path}: {exc}") from exc
        version = record.get("version") if isinstance(record, dict) else None
        if (not isinstance(record, dict) or version not in (
                    TRANSACTION_LEGACY_VERSION, TRANSACTION_VERSION)
                or record.get("target") != str(target)
                or record.get("status") not in ("active", "committed")
                or not isinstance(record.get("require_stopped"), bool)
                or not isinstance(record.get("records"), list)):
            raise RuntimeError(f"transaction journal has an unsupported format: {path}")
        intent = record.get("intent")
        if intent is None:
            # Version-1 journals written before intent existed retain the
            # original stop-game guard. This is the only legacy interpretation.
            intent = (TRANSACTION_INTENT_STOPPED if record["require_stopped"]
                      else TRANSACTION_INTENT_NORMAL)
        if intent not in TRANSACTION_INTENTS or (
                intent == TRANSACTION_INTENT_MANAGED_INI and record["require_stopped"]):
            raise RuntimeError(f"transaction journal has an unsupported intent: {path}")
        # Running-game recovery is limited to the explicitly scoped managed
        # INI transaction. Version-1 journals without an intent, and any
        # ordinary journal that claims require_stopped=false, must not use that
        # disk bit to authorize recovery of binaries, directories or controls.
        recovery_requires_stopped = intent != TRANSACTION_INTENT_MANAGED_INI
        if record["status"] == "committed":
            _retire_transaction(path, target)
            recovered.append({"path": path.name, "action": "cleaned"})
            continue
        try:
            _validate_transaction_records(target, path, record["records"], intent,
                                          version=version)
        except ValueError as exc:
            raise RuntimeError(f"transaction journal has unsafe mappings: {path}: {exc}") from exc
        records = (_upgrade_v1_transaction_records(record["records"])
                   if version == TRANSACTION_LEGACY_VERSION else record["records"])
        state = {"journal": path, "records": records,
                 "require_stopped": recovery_requires_stopped,
                 "intent": intent}
        if version == TRANSACTION_LEGACY_VERSION:
            # Publish the typed, already-validated map before restoring target
            # paths. A later crash resumes with the same narrow semantics.
            _persist_transaction(state, target)
        _restore_snapshot(target, path, records, recovery_requires_stopped, intent)
        _persist_transaction({"journal": path, "records": records,
                              "require_stopped": recovery_requires_stopped,
                              "intent": intent},
                             target, status="committed")
        _retire_transaction(path, target)
        recovered.append({"path": path.name, "action": "rolled_back"})

    # Restorepoint staging lives next to the game's committed snapshot. Older
    # interrupted versions did not journal it; it cannot be a usable snapshot.
    for path in sorted(target.iterdir()):
        if path.name.startswith(RESTOREPOINT_STAGING_PREFIX):
            if path.is_symlink() or not path.is_dir():
                raise RuntimeError(f"unsafe restore point staging path: {path}")
            shutil.rmtree(path)
    return recovered


def _retire_transaction(journal, target):
    """Rename a finished journal before cleanup so partial deletion is retryable."""
    journal, target = Path(journal), Path(target)
    retiring = target / f"{TRANSACTION_RETIRING_PREFIX}{uuid.uuid4().hex}"
    os.replace(journal, retiring)
    shutil.rmtree(retiring)


@contextmanager
def target_transaction(target_dir, extra_names=(), require_stopped=False,
                       include_known=True, intent=None, extra_dirs=()):
    """Journal known target assets and restore them if a mutation raises.

    Nested calls on the same thread share the outer journal. Callers that may
    change runtime binaries set ``require_stopped=True`` so rollback receives
    the same process guard as the original write.
    """
    target = Path(target_dir).resolve()
    if not target.is_dir():
        raise NotADirectoryError(f"install target does not exist: {target}")
    extra_names = ((extra_names,) if isinstance(extra_names, str)
                   else tuple(extra_names or ()))
    extra_dirs = ((extra_dirs,) if isinstance(extra_dirs, str)
                  else tuple(extra_dirs or ()))
    if intent is None:
        intent = TRANSACTION_INTENT_STOPPED if require_stopped else TRANSACTION_INTENT_NORMAL
    if intent not in TRANSACTION_INTENTS:
        raise ValueError(f"unsupported transaction intent: {intent}")
    if intent == TRANSACTION_INTENT_MANAGED_INI and require_stopped:
        raise ValueError("managed INI transactions cannot weaken a stopped-game guard")
    if intent == TRANSACTION_INTENT_MANAGED_INI and include_known:
        raise ValueError("managed INI transactions must use the restricted path inventory")
    if intent == TRANSACTION_INTENT_MANAGED_INI:
        if any(_relative_name(name) not in (INI_NAME, MANIFEST_NAME)
               for name in extra_names):
            raise ValueError("managed INI transaction includes an out-of-scope path")
        if extra_dirs:
            raise ValueError("managed INI transaction cannot include directory paths")
    explicit_dirs = {_relative_name(name) for name in (extra_dirs or ())}
    for name in extra_names or ():
        parts = PurePosixPath(_relative_name(name)).parts
        explicit_dirs.update(PurePosixPath(*parts[:index]).as_posix()
                             for index in range(1, len(parts)))
    _preflight_recovery_live_asi(target)
    active = getattr(_TRANSACTIONS, "targets", None)
    if active is None:
        active = _TRANSACTIONS.targets = {}
    key = str(target)
    state = active.get(key)
    if state:
        if state.get("intent") == TRANSACTION_INTENT_MANAGED_INI and intent not in (
                TRANSACTION_INTENT_MANAGED_INI, TRANSACTION_INTENT_STOPPED):
            raise ValueError("nested transaction cannot widen a managed INI transaction")
        names = sorted(set(_transaction_paths(target, extra_names, include_known))
                       | explicit_dirs)
        state.setdefault("extra_dirs", set()).update(explicit_dirs)
        if require_stopped:
            require_stopped_target(target)
        _snapshot_into(target, state["journal"], names, state["records"],
                       state["extra_dirs"])
        state["require_stopped"] = state["require_stopped"] or require_stopped
        if (state.get("intent") == TRANSACTION_INTENT_STOPPED
                or state["require_stopped"] or intent == TRANSACTION_INTENT_STOPPED):
            state["intent"] = TRANSACTION_INTENT_STOPPED
        elif (state.get("intent") == TRANSACTION_INTENT_NORMAL
              or intent == TRANSACTION_INTENT_NORMAL):
            # A scoped config transaction nested under an ordinary owner must
            # not relabel the outer journal. Its existing broader inventory
            # still needs stopped-game recovery after a hard exit.
            state["intent"] = TRANSACTION_INTENT_NORMAL
        elif (state.get("intent") == TRANSACTION_INTENT_MANAGED_INI
              or intent == TRANSACTION_INTENT_MANAGED_INI):
            state["intent"] = TRANSACTION_INTENT_MANAGED_INI
        else:
            state["intent"] = TRANSACTION_INTENT_NORMAL
        _persist_transaction(state, target)
        state["depth"] += 1
        try:
            yield
        finally:
            state["depth"] -= 1
        return

    recover_target_transactions(target)
    names = sorted(set(_transaction_paths(target, extra_names, include_known))
                   | explicit_dirs)
    if require_stopped:
        require_stopped_target(target)
    preparing = Path(tempfile.mkdtemp(prefix=TRANSACTION_PREPARING_PREFIX, dir=target))
    journal = target / f"{TRANSACTION_PREFIX}{uuid.uuid4().hex}"
    state = {"journal": preparing, "records": [], "depth": 1,
             "extra_dirs": explicit_dirs,
             "require_stopped": bool(require_stopped), "intent": intent}
    # Snapshot failures occur before the body can mutate anything. Remove only
    # the preparation directory and do not run rollback against a partial map.
    try:
        _snapshot_into(target, preparing, names, state["records"],
                       state["extra_dirs"])
        _persist_transaction(state, target)
        os.replace(preparing, journal)
        state["journal"] = journal
    except BaseException:
        if preparing.exists():
            shutil.rmtree(preparing)
        raise
    active[key] = state
    try:
        yield
    except BaseException as operation_error:
        try:
            _restore_snapshot(target, journal, state["records"],
                              state["require_stopped"], state.get("intent"))
        except Exception as rollback_error:
            raise RuntimeError(
                f"operation failed and rollback could not finish; recovery journal remains at {journal}: "
                f"{rollback_error}"
            ) from (rollback_error if isinstance(rollback_error, GameRunningError) else operation_error)
        try:
            _persist_transaction(state, target, status="committed")
        except Exception as commit_error:
            raise RuntimeError(
                f"operation rolled back but its journal could not be marked complete at {journal}: "
                f"{commit_error}"
            ) from operation_error
        try:
            _retire_transaction(journal, target)
        except OSError:
            # The rollback is complete and recorded. A later operation only
            # needs to remove this committed journal.
            pass
        raise
    else:
        try:
            _persist_transaction(state, target, status="committed")
        except Exception as commit_error:
            try:
                _restore_snapshot(target, journal, state["records"],
                                  state["require_stopped"], state.get("intent"))
            except Exception as rollback_error:
                raise RuntimeError(
                    f"transaction commit marker failed and rollback could not finish; "
                    f"recovery journal remains at {journal}: {rollback_error}"
                ) from (rollback_error if isinstance(rollback_error, GameRunningError) else commit_error)
            try:
                _persist_transaction(state, target, status="committed")
            except Exception as rollback_mark_error:
                raise RuntimeError(
                    f"transaction commit marker failed; changes were rolled back but the "
                    f"journal needs recovery at {journal}: {rollback_mark_error}"
                ) from commit_error
            try:
                _retire_transaction(journal, target)
            except OSError:
                pass
            raise RuntimeError("transaction commit marker failed; changes were rolled back") from commit_error
        try:
            _retire_transaction(journal, target)
        except OSError:
            # The mutation is committed. Leave the marker for a later
            # cleanup-only recovery, and let the caller report the saved data.
            pass
    finally:
        active.pop(key, None)


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
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return {"recorded": False, "value": ""}
    if not stat.S_ISREG(mode):
        raise ValueError("OptiScaler launch-options record is not a regular file")
    try:
        return {"recorded": True, "value": path.read_text(encoding="utf-8")}
    except (OSError, UnicodeError) as exc:
        raise ValueError(f"OptiScaler launch-options record is unreadable: {exc}") from exc


def record_launch_options(target_dir, options, logger=None):
    """Keep the pre-install launch options, once.

    Write-once for the same reason ``_stash`` keeps the oldest backup: the value
    worth putting back is the one from before this plugin first touched the
    game, and a reinstall — or turning the launch-options step off and on again
    — must not overwrite it with the override we ourselves wrote.
    """
    target = Path(target_dir).resolve()
    recover_target_transactions(target)
    active = getattr(_TRANSACTIONS, "targets", {})
    state = active.get(str(target))
    if state is None:
        with target_transaction(target, extra_names=(LAUNCH_RECORD_NAME,), require_stopped=True):
            return record_launch_options(target, options, logger)
    path = launch_record_path(target)
    existing = read_launch_record(target)
    if existing["recorded"]:
        return {**existing, "written": False}
    text = options or ""
    stage_root = Path(state["journal"]) / "launch-staging"
    stage_root.mkdir(exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="record-", dir=stage_root)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            # Link publishes the complete file without overwriting a record
            # created concurrently by another Decky action.
            os.link(temporary, path)
            written = True
        except FileExistsError:
            existing = read_launch_record(target)
            if not existing["recorded"]:
                raise ValueError("OptiScaler launch-options record changed while it was being saved")
            return {**existing, "written": False}
    finally:
        Path(temporary).unlink(missing_ok=True)
    if logger:
        logger.info("recorded previous launch options for %s", target_dir)
    return {"recorded": True, "value": text, "written": written}


def forget_launch_options(target_dir):
    """Drop the record. Called by uninstall: it belongs to one install."""
    path = launch_record_path(target_dir)
    record = read_launch_record(target_dir)
    existed = record["recorded"]
    path.unlink(missing_ok=True)
    return existed


def _assert_known_live_asi(path):
    path = Path(path)
    if not _path_exists(path):
        return
    if path.is_symlink() or not path.is_file():
        raise ValueError("Cannot safely remove the existing live-control ASI: its file type is unknown.")
    digest = _sha256_file(path)
    expected = {
        getattr(constants, "LEGACY_LIVE_ASI_SHA256", ""),
        *getattr(constants, "UPGRADE_LIVE_ASI_SHA256", ()),
        live.known_asi_sha256(),
    }
    expected.discard(None)
    expected.discard("")
    if digest not in expected:
        raise ValueError(
            "Cannot safely remove plugins/decky_optiscaler_live.asi because its bytes are unknown."
        )


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


def _reject_case_variant_proxies(target):
    """Wine treats DLL names case-insensitively; do not create shadow entries."""
    known = {name.casefold(): name for name in PROXY_FILENAMES}
    for entry in Path(target).iterdir():
        canonical = known.get(entry.name.casefold())
        if canonical and entry.name != canonical:
            raise ValueError(
                f"Cannot safely install beside case-variant proxy {entry.name}; "
                f"rename it to {canonical} or remove it first."
            )


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
        # The tuple as well, because callers compare it against the floor FSR 4
        # starts at and against the 4.1.1 the INT8 override needs — and parsing
        # the string back into numbers in each of them is a chance for them to
        # disagree.
        "version_tuple": list(version) if version else None,
        # OptiScaler treats an SDK at or above 4.0.2 as providing FSR 4.
        "fsr4_capable": bool(version and version[:3] >= FSR4_MIN_SDK_VERSION[:3]),
    }


def fsr4_status(target_dir):
    """Which FSR4 support DLLs are present next to the game executable."""
    target = Path(target_dir)
    present = {name: (target / name).is_file() for name in FSR4_SUPPORT_FILES}
    ffx = ffx_upscaler_info(target_dir)
    return {
        "files": present,
        "ready": present.get("amdxcffx64.dll", False),
        "required": FSR4_SUPPORT_FILES,
        "ffx": ffx,
        # Which upscaler build this actually is. Read out of the bytes rather
        # than the manifest, so a game that had a build dropped into it by hand
        # — or by another tool — is reported the same way one installed from
        # here is, and reported as *unknown* rather than as the released one when
        # the hash matches nothing (see fsr4build.identify).
        "build": fsr4build.identify(target / FFX_UPSCALER_DLL),
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
    target = Path(target_dir).resolve()
    source = Path(source_dir)
    if not target.is_dir():
        raise NotADirectoryError(f"install target does not exist: {target}")
    try:
        source_mode = source.lstat().st_mode
    except OSError as exc:
        raise NotADirectoryError(f"source folder does not exist or cannot be inspected: {source}") from exc
    if stat.S_ISLNK(source_mode) or not stat.S_ISDIR(source_mode):
        raise NotADirectoryError(f"source folder does not exist: {source}")
    names = []
    for name in FSR4_SUPPORT_FILES:
        candidate = source / name
        try:
            mode = candidate.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
            raise FileNotFoundError(f"FSR4 support source is not a regular file: {candidate}")
        names.append(name)
    if not names:
        raise FileNotFoundError(
            f"no FSR4 support files ({', '.join(FSR4_SUPPORT_FILES)}) in {source}"
        )

    # Validate every requested source before an old target journal can be
    # recovered. Invalid input must never cause writes to the game directory.
    recover_target_transactions(target)
    require_stopped_target(target)
    with target_transaction(target, require_stopped=True):
        manifest = read_manifest(target)
        if not manifest:
            raise ValueError("Install OptiScaler with this plugin before importing support files.")
        _backup_items(target, manifest)
        backups = dict(manifest.get("backups") or {})
        files = list(manifest.get("files") or [])

        for name in names:
            require_stopped_target(target)
            destination = _safe_path(target, name)
            if _path_exists(destination) and name not in backups and name not in files:
                backups[name] = _stash(target, destination, logger)
            atomic_copy(source / name, destination, target_dir=target)
            if name not in files:
                files.append(name)
            if logger:
                logger.info("installed FSR4 support file %s", name)

        manifest["files"] = files
        manifest["backups"] = backups
        _atomic_json(_safe_path(target, MANIFEST_NAME), manifest)

    return {"path": str(target), "imported": names, "source": str(source)}


class GameRunningError(RuntimeError):
    pass


def require_stopped_target(target_dir):
    """Reject runtime mutation while a game has the target mapped or attached."""
    target = Path(target_dir).resolve()
    status = live.status(target)
    if status.get("attached") or status.get("legacy_running"):
        raise GameRunningError("Close the game before changing files in this game directory.")

    prefix = str(target) + "/"
    translations = (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"),
                    ("\\134", "\\"))
    for maps in Path("/proc").glob("[0-9]*/maps"):
        try:
            lines = maps.read_text(errors="replace").splitlines()
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        for line in lines:
            fields = line.split(maxsplit=5)
            if len(fields) != 6:
                continue
            mapped = fields[5]
            for encoded, decoded in translations:
                mapped = mapped.replace(encoded, decoded)
            if mapped.endswith(" (deleted)"):
                mapped = mapped[:-10]
            if mapped == str(target) or mapped.startswith(prefix):
                raise GameRunningError("Close the game before changing files in this game directory.")
    return True


def require_stopped_install(target_dir):
    """Require a managed install and reject DLL replacement while it is in use."""
    target = Path(target_dir).resolve()
    require_stopped_target(target)
    manifest = read_manifest(target)
    if not manifest:
        raise ValueError("Install OptiScaler with this plugin first.")
    return manifest


def atomic_copy(source, destination, target_dir=None):
    """Stage beside the destination so replacement is atomic on its filesystem."""
    source = Path(source)
    destination = Path(destination)
    if target_dir is None:
        if destination.parent.name == live.PLUGIN_SUBDIR and destination.name in (
                live.ASI_NAME, OPTIPATCHER_NAME):
            target_dir = destination.parent.parent
        elif destination.name in (set(PROXY_FILENAMES) | set(PAYLOAD_FILES)
                                  | set(FSR4_SUPPORT_FILES) | {REFRAMEWORK_DLL, INI_NAME,
                                                                LOG_NAME}):
            target_dir = destination.parent
    if target_dir is not None:
        target, relative = _install_relative_path(target_dir, destination)
        destination = _safe_path(target, relative)
        active = getattr(_TRANSACTIONS, "targets", {})
        if str(target) not in active:
            with target_transaction(target, extra_names=(relative,), require_stopped=True):
                return atomic_copy(source, destination, target_dir=target)
        state = active[str(target)]
        if state.get("intent") == TRANSACTION_INTENT_MANAGED_INI:
            if relative != INI_NAME:
                raise ValueError("managed INI transaction cannot replace another game file")
        else:
            require_stopped_target(target)
    try:
        mode = destination.lstat().st_mode
    except FileNotFoundError:
        mode = None
    if mode is not None and not stat.S_ISREG(mode):
        raise ValueError(f"refusing to replace non-regular file: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if target_dir is not None:
        target = Path(target_dir).resolve()
        state = getattr(_TRANSACTIONS, "targets", {}).get(str(target))
        if state is None:
            raise RuntimeError("target copy is not protected by an active transaction")
        while True:
            staged = destination.with_name(f"{TRANSACTION_COPY_PREFIX}{uuid.uuid4().hex}")
            relative_stage = staged.relative_to(target).as_posix()
            _safe_path(target, relative_stage)
            if not _path_exists(staged):
                break
        _snapshot_into(target, state["journal"], (relative_stage,), state["records"])
        _persist_transaction(state, target)
        descriptor = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        name = str(staged)
    else:
        fd, name = tempfile.mkstemp(prefix=".decky-optiscaler-", dir=destination.parent)
        os.close(fd)
    try:
        if source.is_symlink() or not source.is_file():
            raise FileNotFoundError(f"copy source is not a regular file: {source}")
        shutil.copy2(source, name)
        if target_dir is not None and active[str(target)].get("intent") != TRANSACTION_INTENT_MANAGED_INI:
            require_stopped_target(target_dir)
        os.replace(name, destination)
    finally:
        Path(name).unlink(missing_ok=True)


def replace_directory_from(source, destination, target_dir):
    """Atomically publish an exact, prevalidated directory from a target transaction."""
    source = Path(source)
    target, relative = _install_relative_path(target_dir, destination)
    destination = _safe_path(target, relative)
    active = getattr(_TRANSACTIONS, "targets", {})
    if str(target) not in active:
        with target_transaction(target, extra_names=(relative,), require_stopped=True):
            return replace_directory_from(source, destination, target)
    _assert_plain_tree(source)
    mode = _existing_mode(destination)
    if mode is not None and not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
        raise ValueError(f"directory destination has an unsafe filesystem type: {destination}")
    if mode is not None and stat.S_ISDIR(mode):
        _assert_plain_tree(destination)

    journal = active[str(target)]["journal"]
    stage_parent = journal / "directory-staging"
    stage_parent.mkdir(exist_ok=True)
    stage = stage_parent / f"new-{uuid.uuid4().hex}"
    old = stage_parent / f"old-{uuid.uuid4().hex}"
    try:
        shutil.copytree(source, stage, symlinks=False, copy_function=shutil.copy2)
        require_stopped_target(target)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if mode is not None:
            os.replace(destination, old)
        try:
            os.replace(stage, destination)
        except Exception:
            if mode is not None and _path_exists(old):
                os.replace(old, destination)
            raise
        if _path_exists(old):
            _remove_path(old)
    finally:
        if _path_exists(stage):
            _remove_path(stage)
        if _path_exists(old) and not _path_exists(destination):
            os.replace(old, destination)


def pending_target_transaction(target_dir):
    target = Path(target_dir).resolve()
    if str(target) in getattr(_TRANSACTIONS, "targets", {}):
        return False
    if not target.is_dir():
        return False
    for path in target.iterdir():
        if (not path.name.startswith(TRANSACTION_PREFIX)
                or path.name.startswith((TRANSACTION_PREPARING_PREFIX, TRANSACTION_RETIRING_PREFIX))):
            continue
        try:
            record = json.loads((path / TRANSACTION_RECORD).read_text(encoding="utf-8"))
        except FileNotFoundError:
            if not path.exists():  # Atomically retired by another worker.
                continue
            return True
        except (OSError, ValueError):
            return True  # An unreadable published journal requires manual recovery.
        if not isinstance(record, dict):
            return True
        if record.get("status") == "committed":
            continue
        if (record.get("intent") == TRANSACTION_INTENT_MANAGED_INI
                and record.get("require_stopped") is False):
            continue
        return True
    return False


def runtime_current(target_dir):
    """Whether the installed proxy bytes match this plugin's pinned runtime."""
    if pending_target_transaction(target_dir):
        return False
    manifest = read_manifest(target_dir)
    filename = manifest.get("filename") if manifest else None
    if filename not in PROXY_FILENAMES:
        filename = detect(target_dir).get("filename")
    if not filename:
        return False
    path = _safe_path(target_dir, filename)
    if path.is_symlink() or not path.is_file():
        return False
    expected = getattr(constants, "RUNTIME_DLL_SHA256", "")
    if not expected:
        return False
    import hashlib

    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
    except OSError:
        return False
    return digest.hexdigest() == expected


def _replace_fsr4(target, source, recorded, enable_int8=False, fsr4_update="auto"):
    target = Path(target).resolve()
    recover_target_transactions(target)
    require_stopped_install(target)
    if not runtime_current(target):
        raise ValueError("Upgrade OptiScaler to the supported runtime before changing FSR 4 settings.")
    with target_transaction(target, require_stopped=True):
        manifest = read_manifest(target)
        _backup_items(target, manifest)
        if not manifest or FFX_UPSCALER_DLL not in manifest.get("files", []):
            raise ValueError("Reinstall OptiScaler before changing its upscaler build.")
        atomic_copy(source, _safe_path(target, FFX_UPSCALER_DLL), target_dir=target)
        if enable_int8:
            ini_path = _safe_path(target, INI_NAME)
            if not ini_path.is_file():
                raise FileNotFoundError("OptiScaler.ini not found")
            with tempfile.TemporaryDirectory(prefix=".decky-fsr4-") as staging:
                edited_ini = Path(staging) / INI_NAME
                shutil.copy2(ini_path, edited_ini)
                ini = IniFile(edited_ini)
                changes = {
                    "Upscalers": {"Dx12Upscaler": "fsr31", "Dx11Upscaler": "fsr31_12",
                                  "VulkanUpscaler": "fsr31_12"},
                    "FSR": {"Fsr4Update": fsr4_update, "Fsr4ForceEnableInt8": "1",
                            "UpscalerIndex": "0", "Fsr4Preset": "auto"},
                }
                for section, values in changes.items():
                    for key, value in values.items():
                        meta = schema.option(section, key)
                        if meta is None or not schema.valid(meta, value):
                            raise ValueError(f"Invalid FSR 4 preset setting: {section}.{key}={value}")
                ini.update(changes)
                ini.save()
                atomic_copy(edited_ini, ini_path, target_dir=target)
        manifest["fsr4_build"] = recorded
        _atomic_json(_safe_path(target, MANIFEST_NAME), manifest)


def install_fsr4_build(target_dir, dll_path, build, logger=None, enable_int8=False):
    """Install a verified community DLL, optionally enabling the Deck preset."""
    if fsr4build.digest(dll_path) != build["file_sha256"]:
        raise ValueError("FSR 4 DLL checksum mismatch")
    recorded = {"id": build["id"], "label": build["label"],
                "file": FFX_UPSCALER_DLL, "sha256": build["file_sha256"],
                "reaches_fsr4_by": build["reaches_fsr4_by"]}
    _replace_fsr4(target_dir, dll_path, recorded, enable_int8, build.get("fsr4_update", "auto"))
    return {"path": str(target_dir), "file": FFX_UPSCALER_DLL, "build": recorded}


def restore_fsr4_build(target_dir, payload_root, logger=None):
    """Restore the bundled DLL; upscaler and frame-generation settings stay intact."""
    source = Path(payload_root) / FFX_UPSCALER_DLL
    if fsr4build.digest(source) != fsr4build.BUNDLED_BUILD["file_sha256"]:
        raise ValueError("Bundled FSR 4 DLL checksum mismatch")
    _replace_fsr4(target_dir, source, {})
    return {"path": str(target_dir), "restored": FFX_UPSCALER_DLL,
            "build": fsr4build.identify(Path(target_dir) / FFX_UPSCALER_DLL)}


def add_files(target_dir, sources, logger=None, reframework_revision=None):
    """Copy extra files into an existing install and register them for removal.

    The same contract as everything else this plugin puts in a game folder:
    anything displaced is stashed, everything added is written into the
    manifest, and uninstall reverses both. Used to add REFramework to a game
    that is already set up, or to retry a download that failed the first time.

    A game with no manifest — OptiScaler installed by hand, or by another tool —
    is refused because there is no durable ownership record for removal.
    """
    target = Path(target_dir).resolve()
    if not target.is_dir():
        raise NotADirectoryError(f"install target does not exist: {target}")
    recover_target_transactions(target)

    require_stopped_target(target)
    with target_transaction(target, require_stopped=True):
        manifest = read_manifest(target)
        if not manifest:
            raise ValueError("Install OptiScaler with this plugin before adding managed files.")
        _backup_items(target, manifest)
        backups = dict(manifest.get("backups") or {})
        files = list(manifest.get("files") or [])
        added = []

        for source in sources:
            source = Path(source)
            if not source.is_file():
                raise FileNotFoundError(f"missing {source}")
            name = _validate_owned_name(source.name)
            destination = _safe_path(target, name)
            require_stopped_target(target)
            if _path_exists(destination) and name not in backups and name not in files:
                backups[name] = _stash(target, destination, logger)
            atomic_copy(source, destination, target_dir=target)
            if name not in files:
                files.append(name)
            added.append(name)
            if logger:
                logger.info("installed %s", name)

        manifest["files"] = files
        manifest["backups"] = backups
        if REFRAMEWORK_DLL in added:
            manifest["reframework"] = True
            manifest["reframework_revision"] = reframework_revision
        _atomic_json(_safe_path(target, MANIFEST_NAME), manifest)

    return {"ok": True, "path": str(target), "files": added, "tracked": True}


def install_plugin_file(target_dir, source, relative="plugins/OptiPatcher.asi", logger=None):
    """Install and register the optional ASI without touching other plugin files."""
    target = Path(target_dir).resolve()
    if not target.is_dir():
        raise NotADirectoryError(f"install target does not exist: {target}")
    relative = _validate_owned_name(relative)
    if relative != f"{live.PLUGIN_SUBDIR}/{OPTIPATCHER_NAME}":
        raise ValueError(f"unsupported optional plugin path: {relative}")
    source = Path(source)
    if source.is_symlink() or not source.is_file():
        raise FileNotFoundError(f"missing {source}")

    recover_target_transactions(target)
    _preflight_live_control(target)
    require_stopped_target(target)
    _preflight_canonical_install_paths(target, (relative,))
    with target_transaction(target, require_stopped=True):
        manifest = read_manifest(target)
        if not manifest:
            raise ValueError("Install OptiScaler with this plugin before adding an owned ASI.")
        _backup_items(target, manifest)
        files = list(manifest.get("files") or [])
        backups = dict(manifest.get("backups") or {})
        created_directories = list(manifest.get("created_directories") or [])
        destination = _safe_path(target, relative)
        plugins_dir = destination.parent
        plugins_existed = _path_exists(plugins_dir)
        require_stopped_target(target)
        if _path_exists(destination) and relative not in backups and relative not in files:
            backups[relative] = _stash(target, destination, logger)
        atomic_copy(source, destination, target_dir=target)
        if relative not in files:
            files.append(relative)
        if not plugins_existed and live.PLUGIN_SUBDIR not in created_directories:
            created_directories.append(live.PLUGIN_SUBDIR)
        manifest["files"] = files
        manifest["backups"] = backups
        manifest["created_directories"] = created_directories
        manifest["optipatcher"] = True
        _atomic_json(_safe_path(target, MANIFEST_NAME), manifest)
        if logger:
            logger.info("installed optional plugin %s", relative)
    return {"ok": True, "path": str(_safe_path(target, relative)), "files": [relative],
            "tracked": True}


def remove_files(target_dir, names, logger=None):
    """Take specific files back out, restoring anything they displaced.

    The counterpart to `add_files`, and the reason it exists is Monster Hunter
    Wilds: REFramework is a 23 MB third-party DLL that hooks the engine, and
    when a game stops booting after an install there is no way to find out
    whether that was OptiScaler or REF unless one of them can be taken out on
    its own. Bundling them into a single all-or-nothing install left the user
    with a game that would not start and no way to bisect it.
    """
    target = Path(target_dir).resolve()
    if not target.is_dir():
        raise NotADirectoryError(f"path does not exist: {target}")

    recover_target_transactions(target)
    require_stopped_target(target)
    with target_transaction(target, require_stopped=True):
        manifest = read_manifest(target) or {}
        _backup_items(target, manifest)
        files = list(manifest.get("files") or [])
        backups = dict(manifest.get("backups") or {})
        created_directories = list(manifest.get("created_directories") or [])
        removed = []
        restored = []

        for name in names:
            name = _validate_owned_name(name)
            if name not in files and name not in backups:
                continue
            path = _safe_path(target, name)
            require_stopped_target(target)
            if name in backups:
                stashed = _safe_path(target, f"{BACKUP_DIR}/{name}")
                if not _path_exists(stashed):
                    raise FileNotFoundError(f"recorded original backup is missing: {stashed}")
                _require_path_type(stashed, directory=name in _allowed_dir_names(), allow_missing=False)
            if _path_exists(path):
                _require_path_type(path, directory=False, allow_missing=False)
                path.unlink()
                removed.append(name)
            if name in files:
                files.remove(name)
            # Whatever this displaced goes back, exactly as a full uninstall does.
            if name in backups:
                stashed = _safe_path(target, f"{BACKUP_DIR}/{name}")
                path.parent.mkdir(parents=True, exist_ok=True)
                atomic_copy(stashed, path, target_dir=target)
                stashed.unlink()
                restored.append(name)
                if logger:
                    logger.info("restored original %s", name)
                backups.pop(name, None)

        if manifest:
            manifest["files"] = files
            manifest["backups"] = backups
            manifest["created_directories"] = created_directories
            if REFRAMEWORK_DLL in removed:
                manifest["reframework"] = False
                manifest["reframework_revision"] = None
            if f"{live.PLUGIN_SUBDIR}/{OPTIPATCHER_NAME}" in removed:
                manifest["optipatcher"] = False
            _atomic_json(_safe_path(target, MANIFEST_NAME), manifest)

        plugin_dir = target / live.PLUGIN_SUBDIR
        if (f"{live.PLUGIN_SUBDIR}/{OPTIPATCHER_NAME}" in removed
                and live.PLUGIN_SUBDIR in created_directories
                and plugin_dir.is_dir() and not plugin_dir.is_symlink()
                and not any(plugin_dir.iterdir())):
            plugin_dir.rmdir()
            created_directories.remove(live.PLUGIN_SUBDIR)
            if manifest:
                manifest["created_directories"] = created_directories
                _atomic_json(_safe_path(target, MANIFEST_NAME), manifest)

    return {"ok": True, "removed": removed, "restored": restored}


def _stash(target, path, logger=None):
    """Move a displaced path into its original-relative backup location."""
    target = Path(target).resolve()
    path = Path(path)
    relative = path.relative_to(target).as_posix()
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        raise FileNotFoundError(f"cannot preserve missing original path: {path}")
    if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
        raise ValueError(f"cannot preserve unsafe original path: {path}")
    is_directory = stat.S_ISDIR(mode)
    if is_directory:
        _assert_plain_tree(path)
    _validate_owned_name(relative, directory=is_directory)
    stash = _safe_path(target, BACKUP_DIR)
    if _path_exists(stash) and (stash.is_symlink() or not stash.is_dir()):
        raise ValueError(f"backup path is not a regular directory: {stash}")
    stash.mkdir(parents=True, exist_ok=True)
    destination = _safe_path(target, f"{BACKUP_DIR}/{relative}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if _path_exists(destination):
        raise FileExistsError(f"an unclaimed backup already exists: {destination}")
    shutil.move(str(path), str(destination))
    if logger:
        logger.info("backed up %s to %s/", relative, BACKUP_DIR)
    return relative


def _sha256_file(path):
    import hashlib

    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _casefold_root_child(target, name, description, allow_alias=False):
    """Resolve a root child while rejecting Linux names that alias under Wine."""
    target = Path(target)
    try:
        matches = [item for item in target.iterdir() if item.name.casefold() == name.casefold()]
    except OSError as exc:
        raise ValueError(f"Cannot safely inspect {description}: {exc}") from exc
    if len(matches) > 1:
        raise ValueError(f"Cannot safely inspect multiple Wine-equivalent {description} paths.")
    if matches and matches[0].name != name and not allow_alias:
        raise ValueError(f"Cannot safely inspect noncanonical {description} path: {matches[0].name}.")
    return matches[0] if matches else target / name


def _preflight_canonical_install_paths(target, names):
    """Reject case-fold aliases along paths this install will write."""
    target = Path(target).resolve()
    for name in sorted({_relative_name(item) for item in names}):
        current = target
        parts = PurePosixPath(name).parts
        for index, part in enumerate(parts):
            if not _path_exists(current):
                break
            child = _casefold_root_child(current, part, f"install destination {name}")
            mode = _existing_mode(child)
            if index < len(parts) - 1:
                if mode is not None:
                    if stat.S_ISLNK(mode):
                        raise ValueError(f"managed path crosses a symlink: {name}")
                    if not stat.S_ISDIR(mode):
                        raise ValueError(f"managed path parent is not a directory: {name}")
            current = child
        _safe_path(target, name)


def _preflight_install_destinations(target, filename, reframework_files=None,
                                    live_asi=None, optipatcher=None,
                                    selected_build=False):
    names = [filename, *PAYLOAD_DIRS, *RUNTIME_ARTIFACTS,
             *(name for name in PAYLOAD_FILES
               if not (selected_build and name == FFX_UPSCALER_DLL)),
             *_payload_nested_names()]
    names.extend(Path(source).name for source in reframework_files or ())
    if live_asi is not None:
        names.append(f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}")
    if optipatcher is not None:
        names.append(f"{live.PLUGIN_SUBDIR}/{OPTIPATCHER_NAME}")
    _preflight_canonical_install_paths(target, names)


def _simple_ini_values(path):
    """Read relevant INI keys using SimpleIni's case-insensitive lookup rules."""
    text = Path(path).read_text(encoding="utf-8-sig")
    values = {}
    guarded = {("plugins", "path"), ("libraries", "optidllpath")}
    section = None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith((";", "#")):
            continue
        if stripped.startswith("[") and "]" in stripped:
            section = stripped[1:stripped.index("]")].strip().casefold()
            continue
        if section is not None and "=" in stripped:
            key, value = stripped.split("=", 1)
            identity = (section, key.strip().casefold())
            if identity in guarded and identity in values:
                raise ValueError(f"OptiScaler.ini repeats a load-path setting: {identity[0]}.{identity[1]}")
            values[identity] = value.strip()
    return values


def _preflight_live_control(target, ini_path=None, live_asi=None,
                            plugin_root=None, check_ini_paths=True,
                            reject_command_alias=False):
    """Validate live paths and refuse unknown or renamed versions of our ASI.

    ``ini_path`` can be a caller's staged final INI. A known older ASI is
    upgradeable while the game is stopped; anything else under our canonical
    name, or a renamed copy of either known build, is refused.
    """
    target = Path(target).resolve()
    installed_ini = _casefold_root_child(target, INI_NAME, "OptiScaler INI")
    plugin_dir = _casefold_root_child(target, live.PLUGIN_SUBDIR, "plugins directory")
    if _path_exists(installed_ini):
        _require_path_type(installed_ini, directory=False, allow_missing=False)
    if _path_exists(plugin_dir):
        _require_path_type(plugin_dir, directory=True, allow_missing=False)

    if check_ini_paths:
        effective_ini = Path(ini_path) if ini_path is not None else installed_ini
        if _path_exists(effective_ini):
            _require_path_type(effective_ini, directory=False, allow_missing=False)
        settings = _simple_ini_values(effective_ini) if _path_exists(effective_ini) else {}
        plugin_path = (settings.get(("plugins", "path"), "") or "").strip().strip('"').casefold()
        dll_path = (settings.get(("libraries", "optidllpath"), "") or "").strip().strip('"').casefold()
        if plugin_path not in ("", "auto"):
            raise ValueError(
                "Cannot upgrade OptiScaler while Plugins.Path is custom; restore the default plugin path first."
            )
        if dll_path not in ("", "auto"):
            raise ValueError(
                "Cannot upgrade OptiScaler while Libraries.OptiDllPath is custom; restore it to auto first."
            )

    for name in live.CONTROL_FILES:
        path = _casefold_root_child(
            target, name, f"live-control file {name}",
            allow_alias=not (reject_command_alias and name in (
                live.CMD_FILE, live.CMD_TEMP_FILE,
            )),
        )
        mode = _existing_mode(path)
        if mode is not None and not stat.S_ISREG(mode):
            raise ValueError(f"Cannot safely inspect live-control path: {path}")

    return _preflight_live_asi_identity(
        target, live_asi, plugin_root, allow_plugin_alias=False
    )


def _prepare_live_control_paths(target, backups, old_files, logger=None):
    """Preserve initial control files and clear stale owned runtime state."""
    target = Path(target).resolve()
    old_folded = {str(name).casefold() for name in old_files}
    backup_folded = {str(name).casefold() for name in backups}
    for name in live.CONTROL_FILES:
        path = _casefold_root_child(target, name, f"live-control file {name}", allow_alias=True)
        if not _path_exists(path):
            continue
        mode = path.lstat().st_mode
        if not stat.S_ISREG(mode):
            raise ValueError(f"Cannot safely preserve live-control path: {path}")
        relative = path.relative_to(target).as_posix()
        if relative.casefold() not in old_folded and relative.casefold() not in backup_folded:
            backups[relative] = _stash(target, path, logger)
            backup_folded.add(relative.casefold())
            continue
        require_stopped_target(target)
        path.unlink()


def install_live_component(target_dir, source, logger=None, plugin_root=None):
    """Install or upgrade only the verified live-control ASI."""
    target = Path(target_dir).resolve()
    source = Path(source)
    if not target.is_dir():
        raise NotADirectoryError(f"install target does not exist: {target}")
    info = live.validate_live_source(source, plugin_root)
    recover_target_transactions(target)
    manifest = read_manifest(target)
    if not manifest:
        raise ValueError("Install OptiScaler with this plugin before adding live control.")
    if not runtime_current(target):
        raise ValueError("Upgrade this game's OptiScaler core before installing live control.")
    live_rel = f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}"
    _preflight_canonical_install_paths(target, (live_rel,))
    _backup_items(target, manifest)
    _preflight_live_control(target, live_asi=source, plugin_root=plugin_root)

    with target_transaction(target, extra_names=live.CONTROL_FILES, require_stopped=True):
        require_stopped_target(target)
        manifest = read_manifest(target)
        if not manifest:
            raise ValueError("Install OptiScaler with this plugin before adding live control.")
        if not runtime_current(target):
            raise ValueError("Upgrade this game's OptiScaler core before installing live control.")
        _preflight_live_control(target, live_asi=source, plugin_root=plugin_root)
        files = list(manifest.get("files") or [])
        backups = dict(manifest.get("backups") or {})
        dirs = list(manifest.get("dirs") or [])
        created_dirs = list(manifest.get("created_directories") or [])
        asi = _safe_path(target, live_rel)
        plugins = _safe_path(target, live.PLUGIN_SUBDIR)
        plugins_existed = _path_exists(plugins)
        if plugins_existed and not stat.S_ISDIR(plugins.lstat().st_mode):
            raise ValueError(f"plugins path is not a regular directory: {plugins}")
        if not plugins_existed and live.PLUGIN_SUBDIR not in created_dirs:
            created_dirs.append(live.PLUGIN_SUBDIR)
        if _path_exists(asi) and live_rel not in files and live_rel not in backups:
            backups[live_rel] = _stash(target, asi, logger)
        _prepare_live_control_paths(target, backups, set(files), logger)
        atomic_copy(source, asi, target_dir=target)

        # The load option is part of the install and shares its original INI
        # backup with the rest of OptiScaler. Preserve comments and line endings.
        ini_path = _safe_path(target, INI_NAME)
        if not _path_exists(ini_path) or not stat.S_ISREG(ini_path.lstat().st_mode):
            raise ValueError("OptiScaler.ini is missing or unsafe; live control was not installed.")
        if INI_NAME not in files and INI_NAME not in backups:
            backups[INI_NAME] = _stash(target, ini_path, logger)
            atomic_copy(_safe_path(target, f"{BACKUP_DIR}/{INI_NAME}"), ini_path,
                        target_dir=target)
        transaction_state = getattr(_TRANSACTIONS, "targets", {}).get(str(target))
        if not transaction_state:
            raise RuntimeError("live-control INI update is outside its target transaction")
        stage_root = Path(transaction_state["journal"]) / "live-ini-staging"
        stage_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="change-", dir=stage_root) as stage:
            staged_ini = Path(stage) / INI_NAME
            shutil.copy2(ini_path, staged_ini)
            ini = IniFile(staged_ini)
            for requirement in live.ini_requirements():
                ini.set(requirement["section"], requirement["key"], requirement["value"])
            ini.save()
            _preflight_live_control(target, ini_path=staged_ini, live_asi=source,
                                    plugin_root=plugin_root)
            atomic_copy(staged_ini, ini_path, target_dir=target)
        if not any(stage_root.iterdir()):
            stage_root.rmdir()

        for name in (live_rel, *live.CONTROL_FILES, INI_NAME):
            if name not in files:
                files.append(name)
        if not plugins_existed and live.PLUGIN_SUBDIR not in dirs:
            dirs.append(live.PLUGIN_SUBDIR)
        manifest.update(
            live_asi=True,
            live_asi_sha256=info["sha256"],
            live_build_id=info["build_id"],
            live_profile_id=info["profile_id"],
            live_schema=info["schema"],
            live_core_sha256=constants.LIVE_CORE_SHA256,
            files=files,
            dirs=dirs,
            backups=backups,
            created_directories=created_dirs,
        )
        validate_manifest(manifest)
        _atomic_json(_safe_path(target, MANIFEST_NAME), manifest)
    if logger:
        logger.info("installed schema-%s live control at %s", info["schema"], asi)
    return {"ok": True, "installed": True, "path": str(asi),
            "build_id": info["build_id"], "profile_id": info["profile_id"],
            "schema": info["schema"], "sha256": info["sha256"]}


def _remove_disabled_live_control(target, backups, old_files, logger=None):
    if getattr(constants, "LIVE_CONTROL_SUPPORTED", False):
        return []
    removed = []
    for name in (f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}", live.CMD_FILE,
                 live.STATUS_FILE, live.LOG_FILE):
        path = _safe_path(target, name)
        if _path_exists(path):
            mode = path.lstat().st_mode
            if not stat.S_ISREG(mode):
                raise ValueError(f"Cannot safely preserve live-control file: {path}")
            if name == f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}":
                _assert_known_live_asi(path)
            require_stopped_target(target)
            if name not in backups and name not in old_files:
                backups[name] = _stash(target, path, logger)
                removed.append(name)
                if logger:
                    logger.info("preserved pre-existing live-control path %s", name)
                continue
            _remove_path(path)
            removed.append(name)
            if logger:
                logger.info("removed disabled legacy live-control file %s", name)
    return removed


def _payload_inventory(payload_root):
    payload = Path(payload_root)
    from . import payload as runtime_payload

    state = runtime_payload._inventory_state(payload)
    if not isinstance(state, dict) or not isinstance(state.get("files"), dict) \
            or not state["files"] or not isinstance(state.get("dirs"), list) or not state["dirs"]:
        raise FileNotFoundError(f"payload is incomplete or failed its pinned inventory: {payload}")
    return state


def preflight_install_sources(payload_root, live_asi=None, reframework_files=None,
                             plugin_root=None, optipatcher=None):
    """Validate required external sources before target recovery can write."""
    _payload_inventory(payload_root)
    if live_asi is not None:
        live.validate_live_source(live_asi, plugin_root)
    for source in reframework_files or ():
        source = Path(source)
        if source.is_symlink() or not source.is_file():
            raise FileNotFoundError(f"required install source missing or unsafe: {source}")
    if optipatcher is not None:
        source = Path(optipatcher)
        if source.is_symlink() or not source.is_file():
            raise FileNotFoundError(f"required install source missing or unsafe: {source}")
        if plugin_root is not None and _sha256_file(source) != OPTIPATCHER_SHA256:
            raise ValueError("The bundled OptiPatcher checksum does not match.")


def _copy_payload_dir(source, destination):
    """Overlay only pinned payload files without replacing their shared tree."""
    source, destination = Path(source), Path(destination)
    target = destination.parent.resolve()
    active = getattr(_TRANSACTIONS, "targets", {})
    if str(target) not in active:
        with target_transaction(target, extra_names=(destination.name,), require_stopped=True):
            return _copy_payload_dir(source, destination)
    _assert_plain_tree(source)
    from . import payload as runtime_payload

    source_root = source.parent
    for name in runtime_payload.required_inventory()["files"]:
        if not name.startswith(destination.name + "/"):
            continue
        source_file = source_root / name
        destination_file = _safe_path(target, name)
        mode = _existing_mode(destination_file)
        if mode is not None and not stat.S_ISREG(mode):
            raise ValueError(f"managed payload file has an unexpected type: {destination_file}")
        atomic_copy(source_file, destination_file, target_dir=target)


def install(target_dir, payload_root, filename=DEFAULT_PROXY, preserve_ini=True,
            logger=None, live_asi=None, optipatcher=None, reframework_files=None,
            reframework_revision=None, plugin_root=None):
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

    target = Path(target_dir).resolve()
    payload = Path(payload_root)
    if not target.is_dir():
        raise NotADirectoryError(f"install target does not exist: {target}")
    if not os.access(target, os.W_OK):
        raise PermissionError(f"no write permission for {target}")
    preflight_install_sources(payload, live_asi, reframework_files, plugin_root, optipatcher)
    recover_target_transactions(target)
    require_stopped_target(target)
    _reject_case_variant_proxies(target)
    source_dll = payload / "OptiScaler.dll"

    old_manifest = read_manifest(target) or {}
    _preflight_install_destinations(
        target, filename, reframework_files, live_asi, optipatcher,
        selected_build=bool(old_manifest.get("fsr4_build")),
    )
    _backup_items(target, old_manifest)
    _preflight_live_control(target, live_asi=live_asi, plugin_root=plugin_root)
    if not live_asi and _path_exists(_safe_path(target, f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}")):
        raise ValueError("Cannot upgrade this live-control install without the packaged bridge ASI.")
    previous = detect(target)
    selected_build = old_manifest.get("fsr4_build") or {}
    if selected_build:
        build = fsr4build.find(selected_build.get("id"))
        current_ffx = _safe_path(target, FFX_UPSCALER_DLL)
        if not build or not current_ffx.is_file() or fsr4build.digest(
                current_ffx) != build["file_sha256"]:
            raise ValueError("Selected FSR 4 build is missing or changed. Enable it again or restore the bundled build first.")

    # An upgrade may be rolled back to this runtime later. Require the complete
    # service-prepared restore point before touching any owned asset.
    if old_manifest and not runtime_current(target):
        from . import restorepoint

        point = restorepoint.info(target)
        if not point.get("available"):
            raise ValueError("Create a complete restore point before upgrading this managed install.")
        restorepoint.validate_metadata(point.get("metadata"))

    with target_transaction(target, require_stopped=True):
        require_stopped_target(target)
        old_manifest = read_manifest(target) or {}
        old_files = set(old_manifest.get("files") or [])
        old_dirs = set(old_manifest.get("dirs") or [])
        backups = dict(old_manifest.get("backups") or {})
        runtime_artifacts_owned = set(old_manifest.get("runtime_artifacts_owned") or [])
        created_directories = set(old_manifest.get("created_directories") or [])
        original_directories = dict(old_manifest.get("original_directories") or {})
        for name in PAYLOAD_DIRS:
            _casefold_root_child(target, name, "managed payload directory")
            if name not in original_directories:
                if name in backups:
                    original = _safe_path(target, f"{BACKUP_DIR}/{name}")
                    mode = _existing_mode(original)
                    if mode is None or not stat.S_ISDIR(mode):
                        raise ValueError(f"recorded original directory is missing or unsafe: {original}")
                    original_directories[name] = {
                        "exists": True, "mode": stat.S_IMODE(mode),
                    }
                elif name in created_directories or name in old_dirs:
                    original_directories[name] = {"exists": False, "mode": None}
                else:
                    path = _safe_path(target, name)
                    mode = _existing_mode(path)
                    if mode is None:
                        original_directories[name] = {"exists": False, "mode": None}
                    elif stat.S_ISDIR(mode):
                        original_directories[name] = {
                            "exists": True, "mode": stat.S_IMODE(mode),
                        }
                    else:
                        raise ValueError(f"managed payload directory has an unexpected type: {path}")
            if original_directories[name]["exists"]:
                created_directories.discard(name)
            else:
                created_directories.add(name)
        patcher_rel = f"{live.PLUGIN_SUBDIR}/{OPTIPATCHER_NAME}"
        live_rel = f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}"
        plugins_dir = _safe_path(target, live.PLUGIN_SUBDIR)
        plugins_dir_existed_before = _path_exists(plugins_dir)

        # 0.9.4 did not register OptiPatcher in ``files`` even though it set the
        # flag. Carry forward this known prior ownership record on reinstall.
        if old_manifest.get("optipatcher") and _path_exists(_safe_path(target, patcher_rel)):
            old_files.add(patcher_rel)

        removed_live = _remove_disabled_live_control(target, backups, old_files, logger)
        for name in removed_live:
            old_files.discard(name)

        stale_removed = set()
        # Remove a previous proxy under another filename. Its oldest displaced
        # game DLL stays in BACKUP_DIR; a copy is returned to the old location.
        for stale in previous.get("candidates", []):
            if stale == filename:
                continue
            stale_path = _safe_path(target, stale)
            if not _looks_like_optiscaler(stale_path):
                continue
            require_stopped_target(target)
            was_managed = stale in old_files
            if not was_managed and stale not in backups:
                # A hand-installed OptiScaler is still the user's original
                # runtime. Preserve its exact bytes before removing a duplicate.
                backups[stale] = _stash(target, stale_path, logger)
                stale_removed.add(stale)
                continue
            _remove_path(stale_path)
            stale_removed.add(stale)
            if stale in backups:
                stashed = _safe_path(target, f"{BACKUP_DIR}/{stale}")
                if not _path_exists(stashed):
                    raise FileNotFoundError(f"recorded original proxy backup is missing: {stashed}")
                if not _looks_like_optiscaler(stashed):
                    atomic_copy(stashed, stale_path, target_dir=target)
                    if logger:
                        logger.info("restored native game proxy %s while moving proxy", stale)
                elif logger:
                    logger.info("kept prior OptiScaler proxy %s in backup until Remove", stale)
            elif logger:
                logger.info("removed previous OptiScaler proxy %s", stale)

        created = []
        created_dirs = []

        def place(source, relative_name):
            relative_name = _validate_owned_name(relative_name)
            source = Path(source)
            if not source.is_file() or source.is_symlink():
                raise FileNotFoundError(f"required install source missing: {source}")
            destination = _safe_path(target, relative_name)
            require_stopped_target(target)
            if _path_exists(destination) and not stat.S_ISREG(destination.lstat().st_mode):
                raise ValueError(f"managed file has an unexpected filesystem type: {destination}")
            if (_path_exists(destination) and relative_name not in backups
                    and relative_name not in old_files
                    ):
                backups[relative_name] = _stash(target, destination, logger)
            atomic_copy(source, destination, target_dir=target)
            if relative_name not in created:
                created.append(relative_name)

        place(source_dll, filename)

        ini_path = _safe_path(target, INI_NAME)
        ini_existed = _path_exists(ini_path)
        if ini_existed and INI_NAME not in backups and INI_NAME not in old_files:
            backups[INI_NAME] = _stash(target, ini_path, logger)
            if preserve_ini:
                original_ini = _safe_path(target, f"{BACKUP_DIR}/{INI_NAME}")
                atomic_copy(original_ini, ini_path, target_dir=target)
        if not (preserve_ini and ini_existed):
            atomic_copy(payload / INI_NAME, ini_path, target_dir=target)
        if INI_NAME not in created:
            created.append(INI_NAME)

        for name in PAYLOAD_FILES:
            if preserve_ini and name.lower().endswith(".ini"):
                existing_ini = _safe_path(target, name)
                if _path_exists(existing_ini):
                    _require_path_type(existing_ini, directory=False)
                    continue
            if name == FFX_UPSCALER_DLL and selected_build:
                if name not in created:
                    created.append(name)
                continue
            place(payload / name, name)

        nested_payload_files = _payload_nested_names(payload)
        for name in PAYLOAD_DIRS:
            source = payload / name
            destination = _safe_path(target, name)
            destination_mode = _existing_mode(destination)
            if destination_mode is not None and not stat.S_ISDIR(destination_mode):
                raise ValueError(f"managed payload directory has an unexpected type: {destination}")
            if destination_mode is not None and name not in backups:
                for relative in nested_payload_files:
                    if not relative.startswith(name + "/"):
                        continue
                    nested_path = _safe_path(target, relative)
                    nested_mode = _existing_mode(nested_path)
                    if nested_mode is None:
                        continue
                    if not stat.S_ISREG(nested_mode):
                        raise ValueError(f"managed payload file has an unexpected type: {nested_path}")
                    if relative not in backups and relative not in old_files and name not in old_dirs:
                        backups[relative] = _stash(target, nested_path, logger)
            require_stopped_target(target)
            _copy_payload_dir(source, destination)
            if name not in created_dirs:
                created_dirs.append(name)

        for name in nested_payload_files:
            if name not in old_files:
                old_files.add(name)

        # Existing output/config files are user data unless an earlier manifest
        # already proved that they are plugin-created. Keep their oldest bytes
        # before the new runtime is allowed to append or overwrite them.
        for name in RUNTIME_ARTIFACTS:
            path = _safe_path(target, name)
            if _path_exists(path):
                if not stat.S_ISREG(path.lstat().st_mode):
                    raise ValueError(f"runtime artifact has an unexpected filesystem type: {path}")
                if name not in runtime_artifacts_owned and name not in backups and name not in old_files:
                    backups[name] = _stash(target, path, logger)
                    original = _safe_path(target, f"{BACKUP_DIR}/{name}")
                    atomic_copy(original, path, target_dir=target)
            elif name not in backups and name not in old_files:
                runtime_artifacts_owned.add(name)
            elif name in backups:
                original = _safe_path(target, f"{BACKUP_DIR}/{name}")
                _require_path_type(original, directory=False, allow_missing=False)
                atomic_copy(original, path, target_dir=target)

        # REFramework files, if supplied, are placed and tracked in the same
        # transaction as the OptiScaler runtime.
        ref_result = {"installed": False, "files": [], "error": None,
                      "revision": reframework_revision}
        for source in reframework_files or []:
            source = Path(source)
            if not source.is_file():
                raise FileNotFoundError(f"missing {source}")
            place(source, source.name)
            ref_result["files"].append(source.name)
        ref_result["installed"] = REFRAMEWORK_DLL in ref_result["files"]
        if not ref_result["installed"] and old_manifest.get("reframework"):
            ref_result["installed"] = _path_exists(_safe_path(target, REFRAMEWORK_DLL))
            ref_result["revision"] = old_manifest.get("reframework_revision")

        live_result = {"installed": False, "error": None}
        live_info = None
        if live_asi:
            live_info = live.validate_live_source(live_asi, plugin_root)
            _prepare_live_control_paths(target, backups, old_files, logger)
            place(live_asi, live_rel)
            created.extend(name for name in live.CONTROL_FILES if name not in created)
            live_result.update(installed=True, build_id=live_info["build_id"],
                               profile_id=live_info["profile_id"],
                               schema=live_info["schema"], sha256=live_info["sha256"])
        else:
            live_result["error"] = "The packaged bridge ASI is unavailable."
        if logger and live_result.get("error"):
            logger.info("live control unavailable: %s", live_result["error"])

        # Optional OptiPatcher is installed through the same ownership and
        # backup path as every other managed file. Existing ownership survives
        # an ordinary reinstall when it is not selected again.
        patcher_result = {"installed": False, "error": None}
        if optipatcher:
            patcher_source = Path(optipatcher)
            if not patcher_source.is_file():
                patcher_result["error"] = f"{OPTIPATCHER_NAME} missing at {patcher_source}"
            else:
                place(patcher_source, patcher_rel)
                patcher_result["installed"] = True
        elif old_manifest.get("optipatcher") and _path_exists(_safe_path(target, patcher_rel)):
            patcher_result["installed"] = True

        will_create_plugins = bool(live_result["installed"] or patcher_result["installed"])
        if will_create_plugins:
            if plugins_dir_existed_before:
                mode = plugins_dir.lstat().st_mode
                if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                    raise ValueError(f"plugins path is not a regular directory: {plugins_dir}")
            else:
                created_directories.add(live.PLUGIN_SUBDIR)

        files = [name for name in old_files if name not in stale_removed]
        for name in created:
            if name not in files:
                files.append(name)
        for name in _payload_nested_names(payload):
            if name not in files:
                files.append(name)
        dirs = list(old_dirs)
        for name in created_dirs:
            if name not in dirs:
                dirs.append(name)
        manifest = {
            **old_manifest,
            "plugin": "decky-optiscaler",
            "live_asi": live_result["installed"],
            "optipatcher": patcher_result["installed"],
            "reframework": ref_result["installed"],
            "reframework_revision": ref_result["revision"],
            "fsr4_build": selected_build,
            "optiscaler_version": OPTISCALER_VERSION,
            "filename": filename,
            "installed_at": time.time(),
            "files": files,
            "dirs": dirs,
            "backups": backups,
            "runtime_artifacts_owned": sorted(runtime_artifacts_owned),
            "created_directories": sorted(created_directories),
            "original_directories": original_directories,
            "backup_dir": BACKUP_DIR,
        }
        if live_result["installed"]:
            manifest.update(
                live_asi_sha256=live_result.get("sha256"),
                live_build_id=live_result.get("build_id"),
                live_profile_id=live_result.get("profile_id"),
                live_schema=live_result.get("schema"),
                live_core_sha256=constants.LIVE_CORE_SHA256,
            )
        else:
            for key in ("live_asi_sha256", "live_build_id", "live_profile_id",
                        "live_schema", "live_core_sha256"):
                manifest.pop(key, None)
        validate_manifest(manifest)
        _atomic_json(_safe_path(target, MANIFEST_NAME), manifest)

    return {
        "path": str(target),
        "filename": filename,
        "version": OPTISCALER_VERSION,
        "ini_preserved": bool(preserve_ini and ini_existed),
        "optipatcher": patcher_result,
        "reframework": ref_result,
        "launch_option": launch_option(filename),
        "files": files,
        "dirs": dirs,
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
    target = Path(target_dir).resolve()
    if not target.is_dir():
        raise NotADirectoryError(f"path does not exist: {target}")
    recover_target_transactions(target)
    require_stopped_target(target)
    _preflight_live_control(target, check_ini_paths=False)
    manifest = read_manifest(target)
    _backup_items(target, manifest)
    legacy_names = [path.name[:-len(LEGACY_BACKUP_SUFFIX)]
                    for path in target.glob("*" + LEGACY_BACKUP_SUFFIX)]
    for name in legacy_names:
        _validate_owned_name(name)

    with target_transaction(target, extra_names=(RESTORE_DIR, *legacy_names),
                            require_stopped=True):
        manifest = read_manifest(target)
        removed = []
        restored = []

        if manifest:
            original_directories = manifest.get("original_directories", {})
            for name in manifest.get("files", []):
                if name == INI_NAME and not remove_ini and INI_NAME not in manifest.get("backups", {}):
                    continue
                path = _safe_path(target, name)
                require_stopped_target(target)
                if _require_path_type(path, directory=False):
                    path.unlink()
                    removed.append(name)
            for name in manifest.get("dirs", []):
                path = _safe_path(target, name)
                require_stopped_target(target)
                original = original_directories.get(name)
                if (original and original.get("exists")) or name in manifest.get("backups", {}):
                    continue
                if name not in manifest.get("created_directories", []):
                    continue
                if _require_path_type(path, directory=True):
                    # Only files listed by ownership are deleted. An empty
                    # managed directory can then be removed; user additions
                    # keep their parent in place.
                    if not any(path.iterdir()):
                        path.rmdir()
                        removed.append(name + "/")
            # Older manifests owned the bundled trees as a whole. Remove only
            # the pinned children from those trees; never recurse over extras.
            nested_paths = _payload_nested_names()
            for directory in PAYLOAD_DIRS:
                if directory not in manifest.get("dirs", []):
                    continue
                for name in nested_paths:
                    if not name.startswith(directory + "/") or name in manifest.get("files", []):
                        continue
                    path = _safe_path(target, name)
                    if _require_path_type(path, directory=False):
                        path.unlink()
                        removed.append(name)
                directory_path = _safe_path(target, directory)
                original = original_directories.get(directory)
                if (not (original and original.get("exists"))
                        and directory not in manifest.get("backups", {})
                        and _require_path_type(directory_path, directory=True)
                        and not any(directory_path.iterdir())):
                    directory_path.rmdir()
                    removed.append(directory + "/")
        else:
            # A marker identifies OptiScaler bytes, not who installed them.
            # Without ownership, keep them in place; explicit legacy backup
            # files below still provide enough evidence to restore their
            # original destinations safely.
            pass

        owned_live_asi = bool(manifest and (
            f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}" in manifest.get("files", [])
            or manifest.get("live_asi")
        ))
        for name in live.remove_asi(
                target, logger, allow_owned_asi=owned_live_asi,
                owned_paths=manifest.get("files", []) if manifest else ()).get("removed", []):
            if name not in removed:
                removed.append(name)

        runtime_owned = set(manifest.get("runtime_artifacts_owned", [])) if manifest else set()
        for name in runtime_owned:
            path = _safe_path(target, name)
            if _require_path_type(path, directory=False):
                require_stopped_target(target)
                path.unlink()
                removed.append(name)

        if manifest and forget_launch_options(target):
            removed.append(LAUNCH_RECORD_NAME)

        # Older manifests claimed this plugin without listing its path.
        if (manifest and manifest.get("optipatcher")
                and f"{live.PLUGIN_SUBDIR}/{OPTIPATCHER_NAME}" not in manifest.get("files", [])):
            patcher = _safe_path(target, f"{live.PLUGIN_SUBDIR}/{OPTIPATCHER_NAME}")
            if _require_path_type(patcher, directory=False):
                patcher.unlink()
                removed.append(f"{live.PLUGIN_SUBDIR}/{OPTIPATCHER_NAME}")

        restored.extend(restore_backups(target, logger))

        if manifest:
            for name, record in manifest.get("original_directories", {}).items():
                path = _safe_path(target, name)
                mode = _existing_mode(path)
                if record["exists"]:
                    if mode is None:
                        path.mkdir(parents=True, exist_ok=True)
                        mode = _existing_mode(path)
                    if mode is None or not stat.S_ISDIR(mode):
                        raise ValueError(f"original payload directory cannot be restored: {path}")
                    os.chmod(path, record["mode"])
                elif mode is not None and stat.S_ISDIR(mode) and not any(path.iterdir()):
                    path.rmdir()

        manifest_path = _safe_path(target, MANIFEST_NAME)
        if manifest and _require_path_type(manifest_path, directory=False):
            manifest_path.unlink()
            removed.append(MANIFEST_NAME)

        if manifest:
            from . import restorepoint

            restorepoint.remove(target)

        if manifest:
            for name in manifest.get("created_directories", []):
                original = manifest.get("original_directories", {}).get(name)
                if original and original.get("exists"):
                    continue
                path = _safe_path(target, name)
                if _require_path_type(path, directory=True) and not any(path.iterdir()):
                    path.rmdir()
                    removed.append(name + "/")

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
    """Restore validated originals and fail if any backup cannot be restored."""
    target = Path(target_dir).resolve()
    if not target.is_dir():
        raise NotADirectoryError(f"path does not exist: {target}")
    recover_target_transactions(target)
    require_stopped_target(target)
    manifest = read_manifest(target)
    items = _backup_items(target, manifest)
    legacy_paths = list(target.glob("*" + LEGACY_BACKUP_SUFFIX))
    extra = []
    extra_dirs = []
    for relative, source in items:
        if relative not in _allowed_dir_names():
            continue
        for base, dirs, files in os.walk(source, followlinks=False):
            relative_base = Path(base).relative_to(source)
            target_base = PurePosixPath(relative)
            if relative_base.parts:
                target_base = target_base / PurePosixPath(relative_base.as_posix())
            extra_dirs.append(target_base.as_posix())
            for name in files:
                extra.append((target_base / name).as_posix())
    for path in legacy_paths:
        relative = _legacy_backup_target(path.name)
        if relative is None:
            raise ValueError(f"unsupported legacy backup path: {path.name}")
        _require_path_type(path, directory=False, allow_missing=False)
        extra.extend((path.name, relative))

    restored = []
    deferred_backup_paths = []
    stash = _safe_path(target, BACKUP_DIR)
    known_parents = set()
    for _, source in items:
        relative_source = source.relative_to(stash)
        for parent in relative_source.parents:
            if parent != Path("."):
                known_parents.add(stash / parent)
    for name in _allowed_dir_names():
        directory = stash / name
        if _path_exists(directory):
            _assert_plain_tree(directory)
            known_parents.add(directory)
            known_parents.update(path for path in directory.rglob("*") if path.is_dir())
    with target_transaction(target, extra_names=extra, require_stopped=True,
                            extra_dirs=extra_dirs):
        for relative, source in items:
            destination = _safe_path(target, relative)
            require_stopped_target(target)
            is_directory = relative in _allowed_dir_names()
            deferred = []
            if is_directory:
                _require_path_type(destination, directory=True)
                prefix = relative + "/"
                replace_files = {name[len(prefix):] for name in _allowed_file_names()
                                 if name.startswith(prefix)}
                deferred = _merge_directory_tree(
                    source, destination, target_dir=target,
                    replace_files=replace_files,
                )
                if deferred:
                    deferred_backup_paths.extend(
                        f"{relative}/{name}" for name in deferred
                    )
            else:
                _require_path_type(destination, directory=False)
                atomic_copy(source, destination, target_dir=target)
            if not (is_directory and deferred):
                _remove_path(source)
            restored.append(relative)
            if logger:
                logger.info("restored %s from %s/", relative, BACKUP_DIR)

        for path in legacy_paths:
            relative = _legacy_backup_target(path.name)
            if relative is None:
                raise ValueError(f"unsupported legacy backup path: {path.name}")
            destination = _safe_path(target, relative)
            require_stopped_target(target)
            _require_path_type(path, directory=False, allow_missing=False)
            _require_path_type(destination, directory=False)
            atomic_copy(path, destination, target_dir=target)
            path.unlink()
            restored.append(relative)

        for parent in sorted(known_parents, key=lambda path: len(path.parts), reverse=True):
            if _path_exists(parent) and _require_path_type(parent, directory=True) and not any(parent.iterdir()):
                parent.rmdir()
        stash = _safe_path(target, BACKUP_DIR)
        if _path_exists(stash):
            _require_path_type(stash, directory=True, allow_missing=False)
            if any(stash.iterdir()):
                paths = ", ".join(sorted(deferred_backup_paths)) or "unknown backup items"
                raise ValueError(
                    f"Cannot safely clear original backups; retained {paths} in {stash}."
                )
            stash.rmdir()
    return restored


def _backup_items(target, manifest=None):
    """Preflight and inventory original backup paths without following links."""
    stash = _safe_path(target, BACKUP_DIR)
    if not _path_exists(stash):
        if manifest and manifest.get("backups"):
            raise FileNotFoundError(f"backup directory is missing: {stash}")
        return []
    if stash.is_symlink() or not stash.is_dir():
        raise ValueError(f"backup path is not a regular directory: {stash}")

    entries = []
    declared = manifest.get("backups", {}) if manifest else {}
    for relative in declared:
        is_directory = relative in _allowed_dir_names()
        source = _safe_path(target, f"{BACKUP_DIR}/{relative}")
        if not _path_exists(source):
            raise FileNotFoundError(f"original backup is missing: {source}")
        if is_directory:
            _assert_plain_tree(source)
        else:
            _require_path_type(source, directory=False, allow_missing=False)
        entries.append((relative, source))

    for item in sorted(stash.iterdir()):
        if item.name == live.PLUGIN_SUBDIR:
            if item.is_symlink() or not item.is_dir():
                raise ValueError(f"invalid nested plugin backup: {item}")
            # The plugins folder is normally only a namespace for individually
            # stashed ASIs. Do not merge that namespace back as a whole tree.
            if any(name == live.PLUGIN_SUBDIR for name, _ in entries):
                continue
            for child in sorted(item.iterdir()):
                relative = f"{item.name}/{child.name}"
                _validate_owned_name(relative)
                _require_path_type(child, directory=False, allow_missing=False)
                if not any(name == relative for name, _ in entries):
                    entries.append((relative, child))
        elif item.name in PAYLOAD_DIRS:
            if item.is_symlink() or not item.is_dir():
                raise ValueError(f"invalid nested payload backup: {item}")
            # A directory containing file-level backups is a namespace, while
            # an explicitly declared directory backup remains a legacy tree.
            if any(name == item.name for name, _ in entries):
                continue
            _assert_plain_tree(item)
            for base, _, files in os.walk(item, followlinks=False):
                for filename in files:
                    child = Path(base) / filename
                    relative = child.relative_to(stash).as_posix()
                    _validate_owned_name(relative)
                    _require_path_type(child, directory=False, allow_missing=False)
                    if not any(name == relative for name, _ in entries):
                        entries.append((relative, child))
        elif item.name in _allowed_dir_names():
            if not any(name == item.name for name, _ in entries):
                _validate_owned_name(item.name, directory=True)
                _assert_plain_tree(item)
                entries.append((item.name, item))
        else:
            _validate_owned_name(item.name)
            _require_path_type(item, directory=False, allow_missing=False)
            if not any(name == item.name for name, _ in entries):
                entries.append((item.name, item))

    plugin_root = stash / live.PLUGIN_SUBDIR
    if _path_exists(plugin_root):
        if plugin_root.is_symlink() or not plugin_root.is_dir():
            raise ValueError(f"invalid nested plugin backup: {plugin_root}")
        if not any(name == live.PLUGIN_SUBDIR for name, _ in entries):
            allowed = {name for name, _ in entries if name.startswith(live.PLUGIN_SUBDIR + "/")}
            for child in plugin_root.iterdir():
                if f"{live.PLUGIN_SUBDIR}/{child.name}" not in allowed:
                    raise ValueError(f"unrecognized backup item: {live.PLUGIN_SUBDIR}/{child.name}")
    return entries


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
    from . import payload as runtime_payload

    manifest = read_manifest(target)
    entries = []

    inventory = runtime_payload.required_inventory()
    nested = _payload_nested_names(payload)
    expected = list(PAYLOAD_FILES) + nested
    if manifest and manifest.get("filename"):
        expected.insert(0, manifest["filename"])

    for name in expected:
        source_name = ("OptiScaler.dll" if manifest and name == manifest.get("filename") else name)
        source = payload / source_name
        destination = _safe_path(target, name)
        expected_record = inventory["files"].get(source_name)
        record = {
            "name": name,
            "present": _path_exists(destination),
            "matches_payload": False,
            "size": destination.stat().st_size if destination.is_file() else 0,
            "expected_size": expected_record.get("bytes", 0) if expected_record else 0,
        }
        if record["present"] and expected_record:
            record["matches_payload"] = runtime_payload.matches_file(destination, expected_record)
        if name == FFX_UPSCALER_DLL:
            selected = (manifest or {}).get("fsr4_build") or {}
            build = fsr4build.find(selected.get("id", "bundled"))
            record["matches_payload"] = bool(
                record["present"] and build
                and fsr4build.digest(destination) == build["file_sha256"])
            if build and build.get("file_bytes"):
                record["expected_size"] = build["file_bytes"]
        entries.append(record)

    for name in PAYLOAD_DIRS:
        destination = target / name
        matches = runtime_payload.subtree_matches(
            target, [name], inventory["files"], allow_extra=True
        )
        entries.append({
            "name": name + "/",
            "present": destination.is_dir(),
            "matches_payload": matches,
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
