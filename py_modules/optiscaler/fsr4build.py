"""Fetch and identify the pinned community RDNA2 upscaler.

Both archive and DLL hashes are verified. The DLL's version resource alone
cannot distinguish community 4.1.1b from the bundled SDK.
"""

import shutil
from pathlib import Path

from . import payload, wiki
from .constants import (
    FFX_UPSCALER_DLL,
    FSR4_BUILDS,
    FSR4_BUNDLED_BUILD_ID,
    FSR4_BUNDLED_FILE_SHA256,
    FSR4_BUNDLED_FILE_BYTES,
    FSR4_INT8_MIN_SDK_VERSION,
)

#: What the release itself carries, described the same way the downloadable
#: builds are so that one code path can report either.
BUNDLED_BUILD = {
    "id": FSR4_BUNDLED_BUILD_ID,
    "label": "Bundled (FidelityFX SDK 4.1.1)",
    "note": "The build the OptiScaler release ships. Reaches FSR 4 through the "
            "INT8 override on RDNA 2.",
    "file": FFX_UPSCALER_DLL,
    "file_sha256": FSR4_BUNDLED_FILE_SHA256,
    "file_bytes": FSR4_BUNDLED_FILE_BYTES,
    "reaches_fsr4_by": "int8",
}

# (path, size, mtime) -> digest, so re-reading the panel does not hash 30-40 MB
# again for an answer that has not changed. Same trick live.py uses for the ASI.
_digests = {}


def builds():
    """Every build this plugin knows about, the release's own included."""
    return [BUNDLED_BUILD, *FSR4_BUILDS]


def find(build_id):
    for build in builds():
        if build["id"] == build_id:
            return build
    return None


def cached_path(cache_dir, build):
    return Path(cache_dir) / build["id"] / "unpacked" / build["file"]


def url_for(source):
    return f"https://github.com/{source['repo']}/releases/download/{source['tag']}/{source['asset']}"


def digest(path):
    """SHA-256 of a file, remembered by size and mtime."""
    path = Path(path)
    try:
        stat = path.stat()
    except OSError:
        return None
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    found = _digests.get(key)
    if found is None:
        found = payload.sha256(path)
        if len(_digests) >= 8:
            _digests.pop(next(iter(_digests)))
        _digests[key] = found
    return found


def identify(path):
    """Which known FSR 4 build the file at `path` is.

    None when there is no file there. Otherwise a dict that always carries the
    byte count and, for a known size, its hash. The build's identity is included
    only when the hash matched one — a build that is not in the table has to be reportable as *a*
    build rather than passing as the released one by default. The digest is
    remembered by size and mtime, so a panel that re-reads costs a stat.
    """
    path = Path(path)
    if not path.is_file():
        return None
    try:
        size = path.stat().st_size
    except OSError:
        return None

    candidates = [b for b in builds() if b["file_bytes"] == size]
    actual = digest(path) if candidates else None
    found = next((b for b in candidates if b["file_sha256"] == actual), None)
    if found is None:
        return {
            "known": False, "id": None, "label": "Unrecognised FSR 4 build",
            "note": "Not a build this plugin ships or pins. There is nothing here "
                    "to say what it is beyond its size and the version it reports.",
            "reaches_fsr4_by": None, "sha256": actual, "bytes": size,
        }
    return {"known": True, "sha256": actual, "bytes": size, **found}


def _matches(path, build):
    """Whether `path` really is that build: the size first, then the bytes."""
    path = Path(path)
    try:
        if not path.is_file() or path.stat().st_size != build["file_bytes"]:
            return False
    except OSError:
        return False
    return digest(path) == build["file_sha256"]


def fetch(build, cache_dir, logger=None):
    """Download one build and return the path of its verified DLL.

    The archive stays in the cache, so setting up a second game is a copy rather
    than a second download, and the unpacked file is re-checked on the way out
    because a cache that has been edited is not a cache this can trust.

    Unpacking happens in the cache, never in a game folder: the archiver runs
    over a file that arrived from the network, and only the one name this table
    pins is taken out of what it produced.
    """
    if not build:
        raise ValueError("unknown FSR 4 build")
    if build["id"] == FSR4_BUNDLED_BUILD_ID:
        raise ValueError("the bundled build comes from the release, not from the mirror")

    unpacked = cached_path(cache_dir, build)
    if _matches(unpacked, build):
        return unpacked

    cache = Path(cache_dir) / build["id"]
    errors = []
    for source in build["sources"]:
        archive = cache / source["asset"]
        try:
            if not (archive.is_file() and digest(archive) == source["archive_sha256"]):
                archive.unlink(missing_ok=True)
                url = url_for(source)
                if logger:
                    logger.info("downloading FSR 4 %s from %s", build["id"], url)
                wiki.download(url, archive, timeout=300)
                if digest(archive) != source["archive_sha256"]:
                    archive.unlink(missing_ok=True)
                    raise ValueError(f"{source['asset']} archive checksum mismatch")

            # Never let files from an earlier extraction satisfy this attempt.
            target = unpacked.parent
            if target.exists():
                shutil.rmtree(target)
            payload.extract_archive(archive, target, logger)
            produced = next((p for p in target.rglob(build["file"]) if p.is_file()), None)
            if produced is None:
                raise ValueError(f"{source['asset']} did not contain {build['file']}")
            if not _matches(produced, build):
                raise ValueError(f"{build['file']} DLL checksum mismatch")
            if produced != unpacked:
                shutil.move(str(produced), str(unpacked))
            if logger:
                logger.info("FSR 4 %s ready at %s", build["id"], unpacked)
            return unpacked
        except Exception as exc:
            unpacked.unlink(missing_ok=True)
            errors.append(f"{source['repo']}: {exc}")
            if logger:
                logger.warning("FSR 4 source failed: %s", errors[-1])
    raise RuntimeError("Could not fetch verified FSR 4 build: " + "; ".join(errors))


def reaches_fsr4_by(ffx_version):
    """Which setting gets FSR 4 running with this upscaler version in place.

    `4.1.1 or newer` is the condition OptiScaler's own menu puts on the INT8
    override, so below that the FSR upgrade path is what is left.
    """
    if not ffx_version:
        return None
    enough = tuple(ffx_version[:3]) >= tuple(FSR4_INT8_MIN_SDK_VERSION[:3])
    return "int8" if enough else "upgrade"

