"""The FSR 4 upscaler builds that are not the one OptiScaler ships.

The FidelityFX library inside the OptiScaler release is AMD's own 4.1.1 SDK
build, and on a Deck it is enough: OptiScaler reaches RDNA 2 through the forced
INT8 model, which that build supports. What it is not is *modelled* for those
parts. The community builds that are come from ``the3rdparty1917/fsr4xyz`` —
"FSR4 INT8 fixes for RDNA2", whose 4.1.1b release describes itself as
"modified for fixing RDNA2 ghosting issues" — and the OptiScaler-Extras mirror
carries the same files for the OptiScaler Client's FSR 4 Swap. Both were
downloaded here and compared: the DLL is byte-identical from either host, so the
table pins the *file* and only the download differs (3.5 MB against 20 MB).

Three things about these packages shape this module.

Each one holds exactly one file, ``amd_fidelityfx_upscaler_dx12.dll`` — the name
the release's own SDK carries — so installing a build *replaces* that file
inside the game folder rather than adding to it. The mod's own instruction is
the same sentence: "just drop inside the game folder and replace existing
``amd_fidelityfx_upscaler_dx12.dll``".

**A version number cannot say which build is installed.** The modelled 4.1.1b
reports 4.1.1.2740, exactly what the released SDK reports; reading the version
would call the two the same. `identify()` hashes the file instead, and what the
UI reports is that hash and the release it came from — never a version string
two builds share.

The version does decide something else: which setting gets FSR 4 running.
OptiScaler offers its FSR 3.X/4 entry on the back of `Fsr4ForceEnableInt8` only
when the local upscaler is 4.1.1 or newer (menu_common.cpp), so a 4.0.2 build is
reached through `Fsr4Update` — the FSR 3 → FSR 4 upgrade path. Each entry carries
the one that applies to it, because guessing wrong here means a game that offers
neither.

Nothing in here downloads anything on its own. The plugin works offline, and a
build is fetched only when somebody picks one — which is also the point at which
the panel says what these are: modified game DLLs, redistributed by hand, best
kept away from anything with anti-cheat.
"""

import shutil
from pathlib import Path

from . import payload, wiki
from .constants import (
    FFX_UPSCALER_DLL,
    FSR4_BUILDS,
    FSR4_BUILD_MIRROR,
    FSR4_BUNDLED_BUILD_ID,
    FSR4_BUNDLED_FILE_SHA256,
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


def release_page(build):
    repo = build.get("repo") or FSR4_BUILD_MIRROR
    return f"https://github.com/{repo}/releases/tag/{build['tag']}"


def url_for(build):
    repo = build.get("repo") or FSR4_BUILD_MIRROR
    return f"https://github.com/{repo}/releases/download/{build['tag']}/{build['asset']}"


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
        _digests.clear()
        _digests[key] = found
    return found


def identify(path):
    """Which known FSR 4 build the file at `path` is.

    None when there is no file there. Otherwise a dict that always carries the
    file's own hash and byte count, with the build's identity only when the hash
    matched one — a build that is not in the table has to be reportable as *a*
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

    found = {b["file_sha256"]: b for b in builds()}.get(digest(path))
    if found is None:
        return {
            "known": False, "id": None, "label": "Unrecognised FSR 4 build",
            "note": "Not a build this plugin ships or pins. There is nothing here "
                    "to say what it is beyond its hash and the version it reports.",
            "reaches_fsr4_by": None, "sha256": digest(path), "bytes": size,
        }
    return {"known": True, "sha256": digest(path), "bytes": size, **found}


def _matches(path, build):
    """Whether `path` really is that build: the size first, then the bytes."""
    path = Path(path)
    try:
        if not path.is_file() or path.stat().st_size != build["file_bytes"]:
            return False
    except OSError:
        return False
    return digest(path) == build["file_sha256"]


def catalog(cache_dir):
    """The downloadable builds, with what each costs and whether it is here yet."""
    items = []
    for build in FSR4_BUILDS:
        items.append({
            "id": build["id"],
            "label": build["label"],
            "note": build["note"],
            "reaches_fsr4_by": build["reaches_fsr4_by"],
            "mb": round(build["archive_bytes"] / 1e6, 1),
            "cached": _matches(cached_path(cache_dir, build), build),
            "source": build.get("repo") or FSR4_BUILD_MIRROR,
            "page": release_page(build),
        })
    return items


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
    archive = cache / build["asset"]
    if not (archive.is_file() and digest(archive) == build["archive_sha256"]):
        archive.unlink(missing_ok=True)
        url = url_for(build)
        if logger:
            logger.info("downloading FSR 4 %s from %s", build["id"], url)
        wiki.download(url, archive, timeout=300)
        actual = digest(archive)
        if actual != build["archive_sha256"]:
            archive.unlink(missing_ok=True)
            raise ValueError(
                f"{build['asset']} did not match the hash this build pins "
                f"(got {actual})"
            )

    target = unpacked.parent
    payload.extract_archive(archive, target, logger)
    produced = next((p for p in target.rglob(build["file"]) if p.is_file()), None)
    if produced is None:
        raise ValueError(f"{build['asset']} did not contain {build['file']}")
    if produced != unpacked:
        target.mkdir(parents=True, exist_ok=True)
        shutil.move(str(produced), str(unpacked))

    actual = digest(unpacked)
    if actual != build["file_sha256"]:
        unpacked.unlink(missing_ok=True)
        raise ValueError(
            f"{build['file']} from {build['asset']} did not match the hash this "
            f"build pins (got {actual})"
        )
    if logger:
        logger.info("FSR 4 %s ready at %s", build["id"], unpacked)
    return unpacked


def reaches_fsr4_by(ffx_version):
    """Which setting gets FSR 4 running with this upscaler version in place.

    `4.1.1 or newer` is the condition OptiScaler's own menu puts on the INT8
    override, so below that the FSR upgrade path is what is left.
    """
    if not ffx_version:
        return None
    enough = tuple(ffx_version[:3]) >= tuple(FSR4_INT8_MIN_SDK_VERSION[:3])
    return "int8" if enough else "upgrade"

