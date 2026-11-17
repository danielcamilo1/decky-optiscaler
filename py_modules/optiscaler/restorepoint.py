"""Immutable, per-game restore points for OptiScaler runtime experiments."""

import hashlib
import json
import os
import shutil
import stat
import time
import uuid
from pathlib import Path, PurePosixPath

from . import constants, live

RESTORE_DIR = ".decky_optiscaler_restore"
SNAPSHOT_FILE = "snapshot.json"
SNAPSHOT_LEGACY_VERSION = 1
SNAPSHOT_VERSION = 2
# These SDK files were first adopted by the complete 0.9.5 release payload.
_RELEASE_095_ADDITIONS = {"amd_fidelityfx_upscaler_vk.dll",
                          "amd_fidelityfx_framegeneration_vk.dll"}
_DIGEST_CACHE = {}


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _stat_fingerprint(path):
    path = Path(path)
    root_mode = path.lstat().st_mode
    if stat.S_ISLNK(root_mode):
        raise ValueError(f"restore point cannot contain a symlink: {path}")
    if stat.S_ISREG(root_mode):
        st = path.stat()
        return ("file", st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
    if not stat.S_ISDIR(root_mode):
        raise ValueError(f"restore point cannot contain a special file: {path}")
    root_stat = path.stat()
    values = []
    for base, dirs, files in os.walk(path, followlinks=False):
        dirs.sort()
        files.sort()
        for name in dirs + files:
            child = Path(base) / name
            mode = child.lstat().st_mode
            if stat.S_ISLNK(mode):
                raise ValueError(f"restore point cannot contain a symlink: {child}")
            st = child.stat()
            if stat.S_ISDIR(mode):
                kind = "dir"
            elif stat.S_ISREG(mode):
                kind = "file"
            else:
                raise ValueError(f"restore point cannot contain a special file: {child}")
            values.append((child.relative_to(path).as_posix(), kind, st.st_dev,
                           st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns))
    return ("dir", root_stat.st_dev, root_stat.st_ino, root_stat.st_mtime_ns,
            root_stat.st_ctime_ns, tuple(values))


def _relative(name):
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise ValueError(f"invalid restore path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"invalid restore path: {name!r}")
    normalized = path.as_posix()
    if normalized != name:
        raise ValueError(f"invalid restore path: {name!r}")
    return normalized


def _lstat(path):
    try:
        return Path(path).lstat()
    except FileNotFoundError:
        return None


def _safe_path(target, name):
    from . import installer

    return installer._safe_path(target, _relative(name))


def _copy_tree(source, destination):
    source, destination = Path(source), Path(destination)
    for base, dirs, files in os.walk(source, followlinks=False):
        for name in dirs + files:
            path = Path(base) / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise ValueError(f"restore point cannot contain a symlink or special file: {path}")
    shutil.copytree(source, destination, copy_function=shutil.copy2)


def _object_digest(path):
    path = Path(path)
    mode = path.lstat().st_mode
    if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
        raise ValueError(f"restore point cannot contain a symlink or special file: {path}")
    key = (str(path), _stat_fingerprint(path))
    cached = _DIGEST_CACHE.get(key)
    if cached is not None:
        return cached
    if stat.S_ISREG(mode):
        result = {"type": "file", "size": path.stat().st_size, "sha256": _sha256(path)}
    else:
        digest = hashlib.sha256()
        size = 0
        for base, dirs, files in os.walk(path, followlinks=False):
            dirs.sort()
            files.sort()
            for name in dirs + files:
                child = Path(base) / name
                rel = child.relative_to(path).as_posix()
                mode = child.lstat().st_mode
                if stat.S_ISLNK(mode):
                    raise ValueError(f"restore point cannot contain a symlink: {child}")
                if stat.S_ISDIR(mode):
                    digest.update(b"D\0" + rel.encode("utf-8") + b"\0")
                elif stat.S_ISREG(mode):
                    child_hash = _sha256(child)
                    child_size = child.stat().st_size
                    size += child_size
                    digest.update(b"F\0" + rel.encode("utf-8") + b"\0")
                    digest.update(str(child_size).encode("ascii") + b"\0")
                    digest.update(child_hash.encode("ascii") + b"\0")
                else:
                    raise ValueError(f"restore point cannot contain a special file: {child}")
        result = {"type": "dir", "size": size, "sha256": digest.hexdigest()}
    if len(_DIGEST_CACHE) > 512:
        _DIGEST_CACHE.clear()
    _DIGEST_CACHE[key] = result
    return result


def _owned_paths(target, manifest):
    from . import installer

    files = set(manifest.get("files", []))
    dirs = set(manifest.get("dirs", []))
    if manifest.get("filename"):
        files.add(manifest["filename"])
    plugin_patcher = f"{live.PLUGIN_SUBDIR}/{constants.OPTIPATCHER_NAME}"
    if manifest.get("live_asi"):
        files.add(f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}")
    if manifest.get("optipatcher"):
        files.add(plugin_patcher)
    files.update(manifest.get("runtime_artifacts_owned", []))
    files.update({constants.INI_NAME, constants.LAUNCH_RECORD_NAME,
                  constants.MANIFEST_NAME})
    dirs.add(constants.BACKUP_DIR)
    dirs.update(manifest.get("created_directories", []))

    metadata_files = {constants.INI_NAME, constants.LAUNCH_RECORD_NAME,
                      constants.MANIFEST_NAME}
    for name in files:
        if name not in metadata_files:
            installer._validate_owned_name(name)
        installer._safe_path(target, name)
    for name in dirs:
        _relative(name)
        installer._safe_path(target, name)
    return sorted(files), sorted(dirs)


def _candidate_paths(target, legacy_live_inventory=False):
    """All paths install components may adopt, including initially absent ones."""
    from . import installer

    names = (installer._allowed_file_names() | installer._shared_dir_names()
             | {constants.MANIFEST_NAME, constants.LAUNCH_RECORD_NAME,
                constants.BACKUP_DIR, constants.INI_NAME})
    if legacy_live_inventory:
        names.difference_update({live.CMD_TEMP_FILE, live.STATUS_TEMP_FILE,
                                 live.LOG_TEMP_FILE})
    return sorted({_relative(name) for name in names})


def _legacy_candidate_paths(target, legacy_live_inventory=False):
    normalized = _candidate_paths(target, legacy_live_inventory)
    roots = set(normalized)
    for name in normalized:
        parts = PurePosixPath(name).parts
        if any(PurePosixPath(*parts[:index]).as_posix() in roots
               for index in range(1, len(parts))):
            roots.discard(name)
    return sorted(roots)


def _candidate_kind(name):
    from . import installer

    if name == constants.BACKUP_DIR:
        return installer.TRANSACTION_PRIVATE_TREE
    if name in installer._shared_dir_names():
        return installer.TRANSACTION_SHARED_DIR
    return installer.TRANSACTION_FILE


def _candidate_covers(record, name):
    """Whether a snapshot entry stores this path directly or in an ancestor."""
    candidates = set(record.get("candidate_paths", []))
    parts = PurePosixPath(_relative(name)).parts
    for end in range(len(parts), 0, -1):
        if PurePosixPath(*parts[:end]).as_posix() in candidates:
            return True
    return False


def validate_metadata(metadata):
    """Require service-level game and launch recovery data for an experiment."""
    required = {"game_path", "game_settings", "launch_options"}
    if not isinstance(metadata, dict) or not required.issubset(metadata):
        raise ValueError("Restore point needs game_path, game_settings and launch_options metadata.")
    if not isinstance(metadata["game_path"], str) or not metadata["game_path"].strip():
        raise ValueError("Restore point needs a non-empty game identity.")
    settings = metadata["game_settings"]
    if not isinstance(settings, dict) or not {"target", "auto", "experiment"}.issubset(settings):
        raise ValueError("Restore point is missing complete game preference fields.")
    if settings["target"] is not None and not isinstance(settings["target"], str):
        raise ValueError("Restore point target preference is invalid.")
    if settings["auto"] is not None and not isinstance(settings["auto"], bool):
        raise ValueError("Restore point auto preference is invalid.")
    if settings["experiment"] is not None and not isinstance(settings["experiment"], bool):
        raise ValueError("Restore point experiment preference is invalid.")
    if metadata["launch_options"] is not None and not isinstance(metadata["launch_options"], str):
        raise ValueError("Restore point launch options are invalid.")
    return metadata


def _validate_entry_inventory(target, record, content_root, accept_legacy=True):
    """Verify every candidate and every stored object appears exactly once."""
    from . import installer

    current = _candidate_paths(target)
    schema_version = record.get("schema_version")
    if schema_version == SNAPSHOT_VERSION:
        accepted = [current]
        if accept_legacy:
            accepted.append(sorted(set(current) - _RELEASE_095_ADDITIONS))
    elif schema_version == SNAPSHOT_LEGACY_VERSION and accept_legacy:
        accepted = [_legacy_candidate_paths(target),
                    _legacy_candidate_paths(target, legacy_live_inventory=True)]
        accepted += [sorted(set(paths) - _RELEASE_095_ADDITIONS) for paths in accepted]
    else:
        raise ValueError("restore point uses an unsupported candidate inventory")
    expected = record.get("candidate_paths")
    if expected not in accepted:
        raise ValueError("restore point candidate inventory is incomplete")
    entries = record.get("entries")
    if not isinstance(entries, list):
        raise ValueError("restore point entries are invalid")
    seen, stored_ids = set(), set()
    for item in entries:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("restore point contains an invalid path entry")
        name = _relative(item["path"])
        if name not in expected:
            raise ValueError(f"restore point contains an unsupported path: {name}")
        if name in seen:
            raise ValueError(f"restore point repeats path: {name}")
        seen.add(name)
        if not isinstance(item.get("exists"), bool):
            raise ValueError(f"restore point has invalid existence record for {name}")
        kind = _candidate_kind(name) if schema_version == SNAPSHOT_VERSION else None
        if kind is not None and item.get("kind") != kind:
            raise ValueError(f"restore point has an invalid path kind for {name}")
        if not item["exists"]:
            if item.get("stored") is not None or item.get("object") is not None:
                raise ValueError(f"restore point has invalid absent entry: {name}")
            if kind == installer.TRANSACTION_SHARED_DIR and item.get("mode") is not None:
                raise ValueError(f"absent restore point directory has a mode: {name}")
            if kind is not None and kind != installer.TRANSACTION_SHARED_DIR \
                    and item.get("mode") is not None:
                raise ValueError(f"absent restore point path has directory metadata: {name}")
            _safe_path(target, name)
            continue
        if kind == installer.TRANSACTION_SHARED_DIR:
            mode = item.get("mode")
            if (item.get("stored") is not None or item.get("object") is not None
                    or isinstance(mode, bool) or not isinstance(mode, int)
                    or not 0 <= mode <= 0o7777):
                raise ValueError(f"restore point directory metadata is invalid for {name}")
            _safe_path(target, name)
            continue
        stored = item.get("stored")
        if not isinstance(stored, str) or not stored.isdigit() or stored in stored_ids:
            raise ValueError(f"restore point content mapping is invalid for {name}")
        stored_ids.add(stored)
        saved = Path(content_root) / stored
        mode = _lstat(saved)
        if mode is None or stat.S_ISLNK(mode.st_mode) or not (
                stat.S_ISREG(mode.st_mode) or stat.S_ISDIR(mode.st_mode)):
            raise ValueError(f"restore point content is missing or unsafe for {name}")
        if kind == installer.TRANSACTION_FILE and not stat.S_ISREG(mode.st_mode):
            raise ValueError(f"restore point file content is not a file for {name}")
        if kind == installer.TRANSACTION_PRIVATE_TREE and not stat.S_ISDIR(mode.st_mode):
            raise ValueError(f"restore point private tree is not a directory for {name}")
        if _object_digest(saved) != item.get("object"):
            raise ValueError(f"restore point content failed verification for {name}")
        _safe_path(target, name)
    if seen != set(expected):
        raise ValueError("restore point entry inventory is incomplete")
    try:
        actual_stored = {item.name for item in Path(content_root).iterdir()}
    except OSError as exc:
        raise ValueError(f"restore point content is unreadable: {exc}") from exc
    if actual_stored != stored_ids:
        raise ValueError("restore point stored-object inventory is incomplete")


def _snapshot_path(target):
    return _safe_path(target, RESTORE_DIR)


def _load(target):
    from . import installer

    path = _snapshot_path(target)
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(mode):
        raise ValueError("restore point path is not a regular directory")
    metadata_path = path / SNAPSHOT_FILE
    if metadata_path.is_symlink() or not metadata_path.is_file():
        raise ValueError("restore point metadata is missing or unsafe")
    try:
        record = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"restore point metadata is invalid: {exc}") from exc
    if (not isinstance(record, dict) or record.get("schema_version") not in (
                SNAPSHOT_LEGACY_VERSION, SNAPSHOT_VERSION)
            or record.get("state") != "committed" or not isinstance(record.get("entries"), list)
            or not isinstance(record.get("candidate_paths"), list)):
        raise ValueError("restore point has an unsupported format")
    content_root = path / "entries"
    if content_root.is_symlink() or not content_root.is_dir():
        raise ValueError("restore point content is missing or unsafe")
    _validate_entry_inventory(target, record, content_root)
    owned = record.get("owned")
    if not isinstance(owned, dict) or not isinstance(owned.get("files"), list) or not isinstance(
            owned.get("dirs"), list):
        raise ValueError("restore point ownership inventory is invalid")
    for name in owned["files"]:
        if _relative(name) not in (installer._allowed_file_names() | {
                constants.MANIFEST_NAME, constants.INI_NAME, constants.LAUNCH_RECORD_NAME}
                | set(live.CONTROL_FILES)):
            raise ValueError(f"restore point ownership path is unsupported: {name}")
        if not _candidate_covers(record, name):
            raise ValueError(f"restore point ownership path is outside its captured inventory: {name}")
    for name in owned["dirs"]:
        if _relative(name) not in (installer._allowed_dir_names() | {constants.BACKUP_DIR}):
            raise ValueError(f"restore point ownership path is unsupported: {name}")
        if not _candidate_covers(record, name):
            raise ValueError(f"restore point owned directory is outside its captured inventory: {name}")
    if not isinstance(record.get("metadata"), dict):
        raise ValueError("restore point metadata payload is invalid")
    validate_metadata(record["metadata"])
    return path, record


def info(target_dir):
    target = Path(target_dir).resolve()
    if not target.is_dir():
        return {"available": False, "version": None, "metadata": {}}
    loaded = _load(target)
    if not loaded:
        return {"available": False, "version": None, "metadata": {}}
    _, record = loaded
    return {"available": True, "version": record.get("runtime_version"),
            "metadata": record["metadata"]}


def create(target_dir, metadata):
    """Create the first immutable restore point for a managed install."""
    from . import installer

    target = Path(target_dir).resolve()
    if not target.is_dir():
        raise NotADirectoryError(f"path does not exist: {target}")
    installer.recover_target_transactions(target)
    installer.require_stopped_target(target)
    manifest = installer.read_manifest(target)
    if not manifest:
        return {"available": False, "version": None,
                "metadata": metadata if isinstance(metadata, dict) else {}}
    if not isinstance(metadata, dict):
        raise TypeError("restore point metadata must be a JSON object")
    # Validate serializability before writing any content.
    metadata = json.loads(json.dumps(metadata, ensure_ascii=False))
    validate_metadata(metadata)
    manifest_game_path = manifest.get("game_path")
    if (isinstance(manifest_game_path, str) and manifest_game_path.strip()
            and manifest_game_path != metadata["game_path"]):
        raise ValueError("Restore point belongs to a different game.")
    installer._backup_items(target, manifest)
    root = _snapshot_path(target)
    if _lstat(root):
        return info(target)

    files, dirs = _owned_paths(target, manifest)
    candidates = _candidate_paths(target)
    staging_name = f"{installer.RESTOREPOINT_STAGING_PREFIX}{uuid.uuid4().hex}"
    staging = target / staging_name
    with installer.target_transaction(target, extra_names=(RESTORE_DIR, staging_name),
                                      require_stopped=True):
        if _lstat(root):
            return info(target)
        staging.mkdir()
        content_root = staging / "entries"
        content_root.mkdir()
        entries = []
        for index, name in enumerate(candidates):
            source = _safe_path(target, name)
            source_stat = _lstat(source)
            kind = _candidate_kind(name)
            item = {"path": name, "kind": kind, "exists": source_stat is not None}
            if kind == installer.TRANSACTION_SHARED_DIR:
                item["mode"] = (stat.S_IMODE(source_stat.st_mode)
                                if source_stat is not None else None)
                if source_stat is not None and not stat.S_ISDIR(source_stat.st_mode):
                    raise ValueError(f"restore point shared path is not a directory: {name}")
            else:
                item.update(stored=None, object=None)
                if source_stat is not None:
                    if stat.S_ISLNK(source_stat.st_mode):
                        raise ValueError(f"restore point cannot preserve unsafe path: {name}")
                    if kind == installer.TRANSACTION_PRIVATE_TREE:
                        if not stat.S_ISDIR(source_stat.st_mode):
                            raise ValueError(f"restore point private path is not a directory: {name}")
                    elif not stat.S_ISREG(source_stat.st_mode):
                        raise ValueError(f"restore point file path is not a regular file: {name}")
                    stored = f"{index:06d}"
                    destination = content_root / stored
                    if kind == installer.TRANSACTION_PRIVATE_TREE:
                        _copy_tree(source, destination)
                    else:
                        shutil.copy2(source, destination)
                    item["stored"] = stored
                    item["object"] = _object_digest(destination)
            entries.append(item)

        record = {
            "schema_version": SNAPSHOT_VERSION,
            "snapshot_id": uuid.uuid4().hex,
            "state": "committed",
            "created_at": time.time(),
            "runtime_version": manifest.get("optiscaler_version"),
            "old_runtime_paths": [manifest["filename"]] if manifest.get("filename") else [],
            "owned": {"files": [name for name in files if name not in dirs],
                      "dirs": dirs},
            "candidate_paths": candidates,
            "entries": entries,
            "metadata": metadata,
        }
        (staging / SNAPSHOT_FILE).write_text(
            json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        # Validate every stored byte before the single commit rename.
        if _load_staged(staging) is None:
            raise ValueError("restore point failed pre-commit verification")
        installer.require_stopped_target(target)
        os.replace(staging, root)
    return info(target)


def _load_staged(root):
    metadata_path = Path(root) / SNAPSHOT_FILE
    try:
        record = json.loads(metadata_path.read_text(encoding="utf-8"))
        if (not isinstance(record, dict) or record.get("schema_version") != SNAPSHOT_VERSION
                or record.get("state") != "committed"
                or not isinstance(record.get("candidate_paths"), list)
                or not isinstance(record.get("entries"), list)):
            return None
        validate_metadata(record.get("metadata"))
        content_root = Path(root) / "entries"
        if content_root.is_symlink() or not content_root.is_dir():
            return None
        _validate_entry_inventory(Path(root).parent, record, content_root,
                                  accept_legacy=False)
        return record
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _candidate_source(snapshot, record, name):
    """Resolve a candidate path inside its captured ancestor directory tree."""
    entries = {item["path"]: item for item in record["entries"]}
    item = entries.get(name)
    relative = PurePosixPath()
    if item is None:
        parts = PurePosixPath(name).parts
        for index in range(len(parts) - 1, 0, -1):
            ancestor = PurePosixPath(*parts[:index]).as_posix()
            candidate = entries.get(ancestor)
            if candidate is not None:
                item = candidate
                relative = PurePosixPath(*parts[index:])
                break
    if item is None:
        raise ValueError(f"restore point does not contain the candidate path: {name}")
    if not item["exists"]:
        return False, None
    if item.get("kind") == "shared_dir":
        if relative.parts:
            return False, None
        return True, item
    source = snapshot / "entries" / item["stored"] / relative
    try:
        mode = source.lstat().st_mode
    except FileNotFoundError:
        return False, None
    if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
        raise ValueError(f"restore point candidate has an unsafe object: {name}")
    return True, source


def _restore_candidate_path(target, snapshot, record, name, backup_dir=False,
                            directory_path=False):
    from . import installer

    exists, source = _candidate_source(snapshot, record, name)
    destination = _safe_path(target, name)
    current = _lstat(destination)
    if current is not None and (stat.S_ISLNK(current.st_mode)
                                or not (stat.S_ISREG(current.st_mode) or stat.S_ISDIR(current.st_mode))):
        raise ValueError(f"refusing to replace an unsafe current path: {destination}")

    if not exists:
        if current is None:
            return False
        if backup_dir:
            if not stat.S_ISDIR(current.st_mode):
                raise ValueError(f"backup path has an unexpected type: {destination}")
            shutil.rmtree(destination)
            return True
        if directory_path and stat.S_ISDIR(current.st_mode):
            if not any(destination.iterdir()):
                destination.rmdir()
                return True
            return False
        if directory_path:
            # A file created at a path that used to be a directory is a later
            # game/user change, not an owned directory to remove.
            return False
        if not stat.S_ISREG(current.st_mode):
            raise ValueError(f"owned file path was replaced by a directory: {destination}")
        destination.unlink()
        return True

    if isinstance(source, dict) and source.get("kind") == "shared_dir":
        if not directory_path:
            raise ValueError(f"shared directory snapshot used for a file path: {name}")
        if current is not None and not stat.S_ISDIR(current.st_mode):
            raise ValueError(f"shared directory path changed type: {destination}")
        if current is None:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.mkdir()
        os.chmod(destination, source["mode"])
        return True

    source_mode = source.lstat().st_mode
    if stat.S_ISDIR(source_mode):
        if backup_dir:
            if current is not None and stat.S_ISREG(current.st_mode):
                destination.unlink()
            installer.replace_directory_from(source, destination, target)
            return True
        if not directory_path:
            raise ValueError(f"file ownership path became a directory in its snapshot: {name}")
        if current is not None and stat.S_ISREG(current.st_mode):
            raise ValueError(f"directory path was replaced by a file: {destination}")
        if current is None:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.mkdir()
        installer.require_stopped_target(target)
        shutil.copystat(source, destination, follow_symlinks=False)
        return True

    if current is not None and stat.S_ISDIR(current.st_mode):
        if any(destination.iterdir()):
            raise ValueError(f"refusing to replace a non-empty directory at managed file path: {destination}")
        destination.rmdir()
    installer.atomic_copy(source, destination, target_dir=target)
    return True


def restore(target_dir):
    """Restore the original owned game state; keep the snapshot for retries."""
    from . import installer

    target = Path(target_dir).resolve()
    if not target.is_dir():
        raise NotADirectoryError(f"path does not exist: {target}")
    # A restore point may replace a live ASI the user has changed since
    # installation. Use the same known-build and renamed-copy checks as Remove
    # before recovery or any other target mutation; an unknown canonical ASI
    # blocks the complete rollback without changing its bytes.
    installer.require_stopped_target(target)
    installer._preflight_recovery_live_asi(target)
    installer.recover_target_transactions(target)
    installer.require_stopped_target(target)
    installer._preflight_live_control(target, check_ini_paths=False)
    loaded = _load(target)
    if not loaded:
        return {"available": False, "restored": [], "metadata": {}}
    snapshot, record = loaded
    current_manifest = installer.read_manifest(target)
    if not current_manifest:
        return {"available": False, "restored": [], "metadata": {}}
    installer._backup_items(target, current_manifest)
    prior_manifest_exists, prior_manifest_path = _candidate_source(
        snapshot, record, constants.MANIFEST_NAME
    )
    if not prior_manifest_exists or prior_manifest_path is None:
        raise ValueError("Restore point does not contain the original ownership manifest.")
    prior_manifest = installer.validate_manifest(
        json.loads(prior_manifest_path.read_text(encoding="utf-8"))
    )
    prior_backups = set(prior_manifest.get("backups", {}))
    current_files = set(current_manifest.get("files", []))
    current_dirs = set(current_manifest.get("dirs", []))
    if current_manifest.get("filename"):
        current_files.add(current_manifest["filename"])
    if current_manifest.get("live_asi"):
        current_files.add(f"{live.PLUGIN_SUBDIR}/{live.ASI_NAME}")
    if current_manifest.get("optipatcher"):
        current_files.add(f"{live.PLUGIN_SUBDIR}/{constants.OPTIPATCHER_NAME}")
    current_files.update(current_manifest.get("runtime_artifacts_owned", []))
    current_files.update({constants.MANIFEST_NAME, constants.INI_NAME,
                          constants.LAUNCH_RECORD_NAME})
    current_dirs.update(current_manifest.get("created_directories") or [])
    current_dirs.add(constants.BACKUP_DIR)
    current_backup_files, current_backup_dirs = set(), set()
    for name in current_manifest.get("backups", {}):
        if name in installer._allowed_dir_names():
            current_backup_dirs.add(name)
        else:
            current_backup_files.add(name)
    current_files.update(current_backup_files)
    current_dirs.update(current_backup_dirs)
    old_files = set(record["owned"]["files"])
    old_dirs = set(record["owned"]["dirs"])
    restore_files = current_files | old_files
    restore_dirs = current_dirs | old_dirs
    new_owned_paths = {
        name for name in current_files if not _candidate_covers(record, name)
    }
    snapshot_files = {name for name in restore_files if _candidate_covers(record, name)}
    old_runtime_paths = set(record.get("old_runtime_paths", []))
    restored = []
    with installer.target_transaction(target, require_stopped=True):
        # Restore every path owned on either side of the experiment. In
        # particular, restore newly adopted originals before replacing the old
        # backup tree, so no incremental original is lost with that tree.
        ordered_files = sorted(snapshot_files, key=lambda name: (
            0 if name in old_runtime_paths else
            2 if name == constants.MANIFEST_NAME else
            1 if name.startswith(live.PLUGIN_SUBDIR + "/") else 0,
            name,
        ))
        for name in ordered_files:
            installer.require_stopped_target(target)
            if _restore_candidate_path(target, snapshot, record, name):
                restored.append(name)

        # A game update can add a file after the restore point was captured and
        # before a later install adopts it. Return that newly adopted original
        # before the old private backup tree replaces the current one. The
        # legacy f9283 snapshot does not list the three newer control temp
        # names or the two 0.9.5 Vulkan SDK files, so their current manifest
        # backup/ownership is the only
        # permitted incremental evidence for those paths.
        for name in sorted(current_manifest.get("backups", {})):
            if name in prior_backups or name in installer._allowed_dir_names():
                continue
            if _candidate_covers(record, name):
                existed, _ = _candidate_source(snapshot, record, name)
                if existed:
                    continue
            stashed = _safe_path(target, f"{constants.BACKUP_DIR}/{name}")
            installer._require_path_type(stashed, directory=False, allow_missing=False)
            destination = _safe_path(target, name)
            installer.require_stopped_target(target)
            installer.atomic_copy(stashed, destination, target_dir=target)
            restored.append(name)

        # New files with explicit manifest ownership and no backup did not
        # exist before this install. Remove only the exact regular file; an
        # unexpected directory or symlink is left untouched and blocks restore.
        for name in sorted(new_owned_paths):
            if name in current_manifest.get("backups", {}):
                continue
            destination = _safe_path(target, name)
            current = _lstat(destination)
            if current is None:
                continue
            if not stat.S_ISREG(current.st_mode):
                raise ValueError(f"refusing to remove an unverified new owned path: {destination}")
            installer.require_stopped_target(target)
            destination.unlink()
            restored.append(name)

        for name in sorted(restore_dirs - {constants.BACKUP_DIR},
                           key=lambda value: len(PurePosixPath(value).parts), reverse=True):
            installer.require_stopped_target(target)
            if _restore_candidate_path(target, snapshot, record, name, directory_path=True):
                restored.append(name + "/")

        installer.require_stopped_target(target)
        if _restore_candidate_path(target, snapshot, record, constants.BACKUP_DIR,
                                   backup_dir=True, directory_path=True):
            restored.append(constants.BACKUP_DIR + "/")

        # Preserve the user's original empty plugins directory. If the install
        # created it, remove it only after owned ASIs have been rolled back and
        # only while it remains empty.
        plugin_dir = _safe_path(target, live.PLUGIN_SUBDIR)
        prior_plugins, prior_plugins_path = _candidate_source(snapshot, record, live.PLUGIN_SUBDIR)
        if prior_plugins and isinstance(prior_plugins_path, dict):
            plugin_mode = _lstat(plugin_dir)
            if plugin_mode is None:
                plugin_dir.mkdir(parents=True, exist_ok=True)
            elif not stat.S_ISDIR(plugin_mode.st_mode):
                raise ValueError(f"shared directory path changed type: {plugin_dir}")
            os.chmod(plugin_dir, prior_plugins_path["mode"])
        elif prior_plugins and stat.S_ISDIR(prior_plugins_path.lstat().st_mode):
            if not _lstat(plugin_dir):
                plugin_dir.mkdir(parents=True, exist_ok=True)
            shutil.copystat(prior_plugins_path, plugin_dir)
        elif live.PLUGIN_SUBDIR in current_manifest.get("created_directories", []):
            if _lstat(plugin_dir) and stat.S_ISDIR(plugin_dir.lstat().st_mode) \
                    and not any(plugin_dir.iterdir()):
                plugin_dir.rmdir()

    return {"available": True, "restored": restored,
            "metadata": record["metadata"], "version": record.get("runtime_version")}


def remove(target_dir):
    """Delete the restore point after a successful full removal."""
    from . import installer

    target = Path(target_dir).resolve()
    if not target.is_dir():
        return {"removed": False}
    if str(target) not in getattr(installer._TRANSACTIONS, "targets", {}):
        with installer.target_transaction(target, extra_names=(RESTORE_DIR,), require_stopped=True):
            return remove(target)
    path = _snapshot_path(target)
    if not _lstat(path):
        return {"removed": False}
    mode = path.lstat().st_mode
    if not stat.S_ISDIR(mode):
        raise ValueError("restore point path is not a regular directory")
    shutil.rmtree(path)
    return {"removed": True}
