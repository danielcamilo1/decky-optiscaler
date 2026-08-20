"""Unpacking of the bundled OptiScaler release archive.

The release ships as a 7z using the BCJ2 filter, which Python's stdlib (and
py7zr) cannot read, so extraction is delegated to whichever archiver the system
provides. SteamOS carries both p7zip and bsdtar.
"""

import hashlib
import shutil
import subprocess
from pathlib import Path

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


def sha256(path, chunk=1 << 20):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def available_extractor():
    for command, _ in EXTRACTORS:
        if shutil.which(command[0]):
            return command[0]
    if shutil.which(BSDTAR[0]):
        return BSDTAR[0]
    return None


class Payload:
    """Manages the extracted copy of the OptiScaler release."""

    def __init__(self, archive_path, extract_root):
        self.archive = Path(archive_path)
        self.root = Path(extract_root) / OPTISCALER_VERSION

    @property
    def ready(self):
        return (self.root / MARKER).is_file()

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
        actual = sha256(self.archive)
        if actual != PAYLOAD_SHA256:
            raise ValueError(
                f"archive checksum mismatch: expected {PAYLOAD_SHA256}, got {actual}"
            )

    def ensure(self, force=False, logger=None):
        """Extract the archive if needed; returns the extraction directory."""
        if self.ready and not force:
            return self.root

        self.verify_archive()
        if self.root.exists():
            shutil.rmtree(self.root, ignore_errors=True)
        self.root.mkdir(parents=True, exist_ok=True)

        errors = []
        for command, dest_flag in EXTRACTORS:
            if not shutil.which(command[0]):
                continue
            argv = command + [dest_flag.format(dest=str(self.root)), str(self.archive)]
            ok, message = self._run(argv, logger)
            if ok and self.ready:
                return self.root
            errors.append(f"{command[0]}: {message}")

        if shutil.which(BSDTAR[0]):
            argv = BSDTAR + [str(self.archive), "-C", str(self.root)]
            ok, message = self._run(argv, logger)
            if ok and self.ready:
                return self.root
            errors.append(f"bsdtar: {message}")

        detail = "; ".join(errors) if errors else (
            "no supported archiver found (need one of 7z, 7zz, 7za, 7zr or bsdtar)"
        )
        raise RuntimeError(f"could not extract OptiScaler payload: {detail}")

    @staticmethod
    def _run(argv, logger=None):
        if logger:
            logger.info("extracting payload with: %s", " ".join(argv))
        try:
            result = subprocess.run(
                argv, capture_output=True, text=True, timeout=600, check=False
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return False, str(exc)
        if result.returncode != 0:
            return False, (result.stderr or result.stdout or "").strip()[:400]
        return True, ""
