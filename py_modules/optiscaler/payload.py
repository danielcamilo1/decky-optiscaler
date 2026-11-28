"""Unpacking of the bundled OptiScaler release archive.

The release ships as a 7z using the BCJ2 filter, which Python's stdlib (and
py7zr) cannot read, so extraction is delegated to whichever archiver the system
provides. SteamOS carries both p7zip and bsdtar.
"""

import json
import os
import stat
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from . import fsutil
from .constants import OPTISCALER_VERSION, PAYLOAD_SHA256

EXTRACTORS = [
    (["7z", "x", "-y"], "-o{dest}"),
    (["7zz", "x", "-y"], "-o{dest}"),
    (["7za", "x", "-y"], "-o{dest}"),
    (["7zr", "x", "-y"], "-o{dest}"),
]
# bsdtar (libarchive) handles BCJ2 and is present wherever pacman is.
BSDTAR = ["bsdtar", "-xf"]

MARKER = "OptiScaler.dll"
COMMIT_MARKER = ".decky-optiscaler-payload.json"
_PINNED_FILES = None
REQUIRED_NESTED_FILES = (
    "D3D12_Optiscaler/D3D12Core.dll",
)


def subtree_matches(root, dirs=None, files=None, allow_extra=False):
    """Check pinned subtrees exactly, or as a required subset for game files."""
    root = Path(root)
    if dirs is None or files is None:
        inventory = required_inventory()
        dirs, files = inventory["dirs"], inventory["files"]
    expected_by_dir = {name: set() for name in dirs}
    for name in files:
        for directory in dirs:
            prefix = directory + "/"
            if name.startswith(prefix):
                expected_by_dir[directory].add(name[len(prefix):])
    for directory, expected_files in expected_by_dir.items():
        subtree = root / directory
        try:
            mode = subtree.lstat().st_mode
        except OSError:
            return False
        if not stat.S_ISDIR(mode):
            return False
        actual_files, actual_dirs = set(), set()
        for base, child_dirs, names in os.walk(subtree, followlinks=False):
            for name in child_dirs + names:
                path = Path(base) / name
                try:
                    mode = path.lstat().st_mode
                except OSError:
                    return False
                if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                    return False
            relative = Path(base).relative_to(subtree)
            actual_dirs.update((relative / name).as_posix() for name in child_dirs)
            actual_files.update((relative / name).as_posix() for name in names)
        expected_dirs = {
            parent.as_posix()
            for name in expected_files
            for parent in Path(name).parents
            if parent.as_posix() != "."
        }
        if allow_extra:
            if not expected_files.issubset(actual_files) or not expected_dirs.issubset(actual_dirs):
                return False
        elif actual_files != expected_files or actual_dirs != expected_dirs:
            return False
    return True


def required_inventory():
    """Return the complete set of files and directories an install consumes."""
    global _PINNED_FILES
    from .constants import INI_NAME, PAYLOAD_DIRS, PAYLOAD_FILES

    if _PINNED_FILES is None:
        manifest_path = Path(__file__).resolve().parents[2] / "defaults" / "runtime-manifest.json"
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            pinned = manifest["files"]
        except (OSError, KeyError, ValueError, TypeError) as exc:
            raise RuntimeError(f"pinned runtime inventory is unavailable: {manifest_path}") from exc
        if not isinstance(pinned, dict) or not pinned:
            raise RuntimeError(f"pinned runtime inventory is empty or invalid: {manifest_path}")
        _PINNED_FILES = pinned

    required = {MARKER, INI_NAME, *PAYLOAD_FILES, *REQUIRED_NESTED_FILES}
    files = {}
    for name in sorted(required):
        record = _PINNED_FILES.get(name)
        if (not isinstance(record, dict) or not isinstance(record.get("sha256"), str)
                or len(record["sha256"]) != 64
                or any(ch not in "0123456789abcdef" for ch in record["sha256"].lower())
                or isinstance(record.get("bytes"), bool)
                or not isinstance(record.get("bytes"), int) or record["bytes"] <= 0):
            raise RuntimeError(f"pinned runtime inventory has no checksum for {name}")
        files[name] = {"bytes": record["bytes"], "sha256": record["sha256"]}
    return {
        "files": files,
        "dirs": sorted(set(PAYLOAD_DIRS)),
    }


def _inventory_state(root):
    """Validate required paths and return a cheap, stable inventory record."""
    root = Path(root)
    inventory = required_inventory()
    try:
        if not os.path.isdir(root) or root.is_symlink():
            return None
    except OSError:
        return None
    files = {}
    for name, expected in inventory["files"].items():
        path = root / name
        if path.is_symlink() or not path.is_file():
            return None
        try:
            stat_result = path.stat()
            size = stat_result.st_size
        except OSError:
            return None
        if size <= 0 or size != expected["bytes"]:
            return None
        try:
            digest = fsutil.sha256_file(path)
        except OSError:
            return None
        if digest != expected["sha256"]:
            return None
        files[name] = {"bytes": size, "sha256": digest}

    for name in inventory["dirs"]:
        path = root / name
        if path.is_symlink() or not path.is_dir():
            return None

    # Every file copied from a managed subtree must have an exact pin. A
    # syntactically valid extra file can still replace game/runtime behavior.
    for base, dirs, names in os.walk(root, followlinks=False):
        for name in dirs + names:
            path = Path(base) / name
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                return None
    if not subtree_matches(root, inventory["dirs"], _PINNED_FILES):
        return None

    return {"files": files, "dirs": inventory["dirs"]}


def _valid_commit_marker(root):
    root = Path(root)
    marker = root / COMMIT_MARKER
    if marker.is_symlink() or not marker.is_file():
        return False
    try:
        record = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if (not isinstance(record, dict) or record.get("version") != OPTISCALER_VERSION
            or record.get("archive_sha256") != PAYLOAD_SHA256):
        return False
    recorded = record.get("inventory")
    if (not isinstance(recorded, dict) or not isinstance(recorded.get("files"), dict)
            or not recorded["files"] or not isinstance(recorded.get("dirs"), list)
            or not recorded["dirs"]):
        return False
    actual = _inventory_state(root)
    return actual is not None and recorded == actual


def matches_file(path, expected):
    """Match a pinned byte record, reusing hashes while stat identity is stable."""
    path = Path(path)
    if (not isinstance(expected, dict) or isinstance(expected.get("bytes"), bool)
            or not isinstance(expected.get("bytes"), int)
            or not isinstance(expected.get("sha256"), str)):
        return False
    try:
        if path.is_symlink() or not path.is_file():
            return False
        st = path.stat()
    except OSError:
        return False
    if st.st_size != expected["bytes"]:
        return False
    try:
        digest = fsutil.sha256_file(path)
    except OSError:
        return False
    return digest == expected["sha256"]


def _remove_path(path):
    fsutil.remove_path(path)


def sha256(path, chunk=1 << 20):
    return fsutil.compute_sha256(path, chunk=chunk)


def available_extractor():
    for command, _ in EXTRACTORS:
        if shutil.which(command[0]):
            return command[0]
    if shutil.which(BSDTAR[0]):
        return BSDTAR[0]
    return None


def extract_archive(archive, dest, logger=None):
    """Unpack an archive with whichever archiver the system has.

    The payload is unpacked through this too, because the reason it cannot be
    unpacked in Python is not specific to it: a 7z that uses the BCJ2 filter is
    beyond the stdlib and py7zr alike, and the FSR 4 build packages on the mirror
    are 7z as well. SteamOS has p7zip and bsdtar; a desktop usually has one of
    the two.

    Unpacking is not the same as trusting: callers here check the bytes that
    came out against a pinned hash before any of it goes near a game folder.
    """
    archive, dest = Path(archive), Path(dest)
    dest.mkdir(parents=True, exist_ok=True)

    errors = []
    for command, dest_flag in EXTRACTORS:
        if not shutil.which(command[0]):
            continue
        ok, message = _run(command + [dest_flag.format(dest=str(dest)), str(archive)], logger)
        if ok:
            return dest
        errors.append(f"{command[0]}: {message}")

    if shutil.which(BSDTAR[0]):
        ok, message = _run(BSDTAR + [str(archive), "-C", str(dest)], logger)
        if ok:
            return dest
        errors.append(f"bsdtar: {message}")

    detail = "; ".join(errors) if errors else (
        "no supported archiver found (need one of 7z, 7zz, 7za, 7zr or bsdtar)"
    )
    raise RuntimeError(f"could not extract {archive.name}: {detail}")


def _run(argv, logger=None):
    """Run one archiver invocation; returns (ok, message)."""
    if logger:
        logger.info("extracting with: %s", " ".join(argv))
    try:
        result = subprocess.run(
            argv, capture_output=True, text=True, timeout=600, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)
    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "").strip()[:400]
    return True, ""


class Payload:
    """Manages the extracted copy of the OptiScaler release."""

    def __init__(self, archive_path, extract_root):
        self.archive = Path(archive_path)
        self.root = Path(extract_root) / OPTISCALER_VERSION

    @property
    def ready(self):
        return _valid_commit_marker(self.root)

    def status(self):
        return {
            "version": OPTISCALER_VERSION,
            "archive_present": self.archive.is_file(),
            "archive_path": str(self.archive),
            "extracted": self.ready,
            "extract_path": str(self.root),
            "extractor": available_extractor(),
        }

    def verify_archive(self):
        if not self.archive.is_file():
            raise FileNotFoundError(f"bundled archive missing: {self.archive}")
        actual = fsutil.sha256_file(self.archive)
        if actual != PAYLOAD_SHA256:
            raise ValueError(
                f"archive checksum mismatch: expected {PAYLOAD_SHA256}, got {actual}"
            )

    def ensure(self, force=False, logger=None):
        """Extract the archive if needed; returns the extraction directory."""
        if self.ready and not force:
            return self.root

        self.verify_archive()
        self.root.parent.mkdir(parents=True, exist_ok=True)
        errors = []
        attempts = [(command, dest_flag) for command, dest_flag in EXTRACTORS
                    if shutil.which(command[0])]
        if shutil.which(BSDTAR[0]):
            attempts.append((BSDTAR, None))

        with tempfile.TemporaryDirectory(prefix=".optiscaler-payload-",
                                         dir=self.root.parent) as temporary:
            temporary = Path(temporary)
            for index, (command, dest_flag) in enumerate(attempts):
                staged = temporary / f"extract-{index}"
                staged.mkdir()
                if dest_flag is None:
                    argv = command + [str(self.archive), "-C", str(staged)]
                else:
                    argv = command + [dest_flag.format(dest=str(staged)), str(self.archive)]
                ok, message = self._run(argv, logger)
                state = _inventory_state(staged) if ok else None
                if ok and state is not None:
                    marker = {
                        "version": OPTISCALER_VERSION,
                        "archive_sha256": PAYLOAD_SHA256,
                        "inventory": state,
                        "committed_at": time.time(),
                    }
                    fsutil.atomic_json(
                        staged / COMMIT_MARKER, marker, indent=None, sort_keys=True,
                        prefix=".decky-optiscaler-marker-",
                    )
                    if not _valid_commit_marker(staged):
                        errors.append(f"{command[0]}: extracted payload failed inventory validation")
                        continue
                    self._commit_staged(staged)
                    return self.root
                if ok:
                    message = "extracted payload is missing required files or directories"
                errors.append(f"{command[0]}: {message}")

        detail = "; ".join(errors) if errors else (
            "no supported archiver found (need one of 7z, 7zz, 7za, 7zr or bsdtar)"
        )
        raise RuntimeError(f"could not extract OptiScaler payload: {detail}")

    def _commit_staged(self, staged):
        """Publish a complete staged cache while retaining a working cache on error."""
        staged = Path(staged)
        old = self.root.with_name(f".{self.root.name}.previous-{os.getpid()}")
        if old.exists() or old.is_symlink():
            _remove_path(old)
        had_old = self.root.exists() or self.root.is_symlink()
        if had_old:
            os.replace(self.root, old)
        try:
            os.replace(staged, self.root)
        except Exception:
            if had_old and (old.exists() or old.is_symlink()):
                os.replace(old, self.root)
            raise
        if had_old:
            _remove_path(old)

    @staticmethod
    def _run(argv, logger=None):
        # The payload has always unpacked through this name; it is the same call
        # `extract_archive` above makes.
        return _run(argv, logger)
