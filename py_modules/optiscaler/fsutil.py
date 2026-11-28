"""Low-level filesystem utilities shared across OptiScaler backend modules.

Centralizes stat-fingerprint LRU-cached SHA-256 hashing, path traversal guards,
and atomic file/JSON helpers so higher-level modules do not reimplement them.
"""

from collections import OrderedDict
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import threading

_HASH_CACHE_MAX = 256
_HASH_CACHE_LOCK = threading.Lock()
_HASH_CACHE = OrderedDict()


def clear_hash_cache():
    """Drop all cached file digests."""
    with _HASH_CACHE_LOCK:
        _HASH_CACHE.clear()


def _stat_key(st):
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def compute_sha256(path, chunk=1 << 20):
    """Compute an uncached SHA-256 hex digest for ``path``."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def sha256_file(path, chunk=1 << 20, *, hasher=None):
    """Return a SHA-256 hex digest, LRU-cached by file stat fingerprint."""
    target = Path(path)
    st = target.stat()
    key = _stat_key(st)
    with _HASH_CACHE_LOCK:
        cached = _HASH_CACHE.get(key)
        if cached is not None:
            _HASH_CACHE.move_to_end(key)
            return cached

    digest = hasher(target) if hasher is not None else compute_sha256(target, chunk=chunk)
    try:
        key_after = _stat_key(target.stat())
    except OSError:
        key_after = None
    if key_after == key:
        with _HASH_CACHE_LOCK:
            _HASH_CACHE[key] = digest
            _HASH_CACHE.move_to_end(key)
            while len(_HASH_CACHE) > _HASH_CACHE_MAX:
                _HASH_CACHE.popitem(last=False)
    return digest


def relative_name(name, label="managed path"):
    """Normalize a relative POSIX path without accepting traversal."""
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise ValueError(f"invalid {label}: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"invalid {label}: {name!r}")
    normalized = path.as_posix()
    if normalized != name:
        raise ValueError(f"invalid {label}: {name!r}")
    return normalized


def safe_path(target, name, label="managed path"):
    """Return a target-contained path, refusing symlinked parent components."""
    normalized = relative_name(name, label=label)
    root = Path(target).resolve()
    path = root
    for part in PurePosixPath(normalized).parts[:-1]:
        path = path / part
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode):
            raise ValueError(f"{label} crosses a symlink: {normalized}")
        if not stat.S_ISDIR(mode):
            raise ValueError(f"{label} parent is not a directory: {normalized}")
    result = root.joinpath(*PurePosixPath(normalized).parts)
    try:
        result.resolve(strict=False).relative_to(root)
    except ValueError as exc:
        raise ValueError(f"{label} leaves install target: {normalized}") from exc
    return result


def existing_mode(path):
    """Return ``lstat().st_mode`` for ``path``, or ``None`` if absent."""
    try:
        return Path(path).lstat().st_mode
    except FileNotFoundError:
        return None


def remove_path(path):
    """Remove a file, symlink, or directory tree without following a final symlink."""
    target = Path(path)
    try:
        mode = target.lstat().st_mode
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
        target.unlink()
    else:
        shutil.rmtree(target)
    return True


def atomic_json(path, data, *, indent=2, ensure_ascii=True, sort_keys=False,
                prefix=".decky-optiscaler-json-"):
    """Write ``data`` as JSON via same-directory temp file, fsync, and replace."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=indent, ensure_ascii=ensure_ascii, sort_keys=sort_keys)
    fd, temporary = tempfile.mkstemp(prefix=prefix, dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def atomic_copy(source, destination, *, prefix=".decky-optiscaler-"):
    """Copy a regular file atomically via a same-directory temporary file."""
    source = Path(source)
    destination = Path(destination)
    try:
        mode = destination.lstat().st_mode
    except FileNotFoundError:
        mode = None
    if mode is not None and not stat.S_ISREG(mode):
        raise ValueError(f"refusing to replace non-regular file: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=prefix, dir=destination.parent)
    os.close(fd)
    try:
        if source.is_symlink() or not source.is_file():
            raise FileNotFoundError(f"copy source is not a regular file: {source}")
        shutil.copy2(source, name)
        os.replace(name, destination)
    finally:
        Path(name).unlink(missing_ok=True)
