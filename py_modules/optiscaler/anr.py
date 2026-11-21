"""Fetch, verify, and inspect Apex Neural Rendering (ANR FG) packages.

ANR FG is a proprietary beta frame-generation provider distributed via
https://github.com/apex-compute/ANR/releases. Because its binaries are not
open-source, this plugin never bundles them — it downloads the pinned release
archive on demand, verifies the archive SHA-256 and the extracted binary
checksums, and caches the verified files under runtime_dir so enabling ANR FG
on a second game is a local copy rather than a second download.

ANR FG relies on OptiScaler's ``FGNvngxReplacement`` custom-provider hook,
which is not present in OptiScaler 0.9.5. The pinned ``anr-fg-*-full.zip``
release pairs the ANR provider files with Apex's upstream OptiScaler build
(commit ``d6b02459``), so enabling ANR FG swaps the game's proxy DLL to that
pinned build and pauses the 0.9.5 live-control bridge until ANR FG is disabled.
"""

import shutil
import zipfile
from pathlib import Path, PurePosixPath

from . import payload, wiki
from .constants import (
    ANR_ARCHIVE_BYTES,
    ANR_ARCHIVE_SHA256,
    ANR_ASSET,
    ANR_OPTISCALER_BYTES,
    ANR_OPTISCALER_COMMIT,
    ANR_OPTISCALER_SHA256,
    ANR_PROVIDER_DLL_BYTES,
    ANR_PROVIDER_DLL_REL,
    ANR_PROVIDER_DLL_SHA256,
    ANR_PROVIDER_NAME,
    ANR_PROVIDER_REL_DIR,
    ANR_REPO,
    ANR_VERSION,
    INI_NAME,
)
from .inifile import IniFile

ARCHIVE_PROXY_MEMBER = "game/dxgi.dll"
ARCHIVE_PROVIDER_PREFIX = f"game/{ANR_PROVIDER_REL_DIR}/"
NR_FG_INI_REL = f"{ANR_PROVIDER_REL_DIR}/dlssg/nr_fg.ini"

_digests = {}


def release_url():
    return f"https://github.com/{ANR_REPO}/releases/download/{ANR_VERSION}/{ANR_ASSET}"


def release_page():
    return f"https://github.com/{ANR_REPO}/releases/tag/{ANR_VERSION}"


def digest(path):
    """SHA-256 of a file, cached by (path, size, mtime_ns)."""
    path = Path(path)
    try:
        st = path.stat()
    except OSError:
        return None
    key = (str(path), st.st_size, st.st_mtime_ns)
    found = _digests.get(key)
    if found is None:
        found = payload.sha256(path)
        if len(_digests) >= 16:
            _digests.pop(next(iter(_digests)))
        _digests[key] = found
    return found


def _matches(path, expected_bytes, expected_sha256):
    path = Path(path)
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size != expected_bytes:
            return False
    except OSError:
        return False
    return digest(path) == expected_sha256


def _safe_relative_provider_path(member_name):
    """Validate and map a zip member under game/OptiScaler/custom/Apex Neural Rendering FG/."""
    if "\\" in member_name or "\x00" in member_name:
        raise ValueError(f"Unsafe ANR archive member path: {member_name!r}")
    if not member_name.startswith(ARCHIVE_PROVIDER_PREFIX):
        return None
    rel = member_name[len("game/"):]
    parsed = PurePosixPath(rel)
    if parsed.is_absolute() or any(part in ("", ".", "..") for part in parsed.parts):
        raise ValueError(f"Unsafe ANR archive member path: {member_name!r}")
    normalized = parsed.as_posix()
    if normalized != rel or not normalized.startswith(ANR_PROVIDER_REL_DIR + "/"):
        raise ValueError(f"Unsafe ANR archive member path: {member_name!r}")
    return normalized


def _cached_package(unpacked_root):
    """Return a verified cached package descriptor, or None."""
    root = Path(unpacked_root)
    proxy_dll = root / "dxgi.dll"
    provider_dll = root / ANR_PROVIDER_DLL_REL
    if not _matches(proxy_dll, ANR_OPTISCALER_BYTES, ANR_OPTISCALER_SHA256):
        return None
    if not _matches(provider_dll, ANR_PROVIDER_DLL_BYTES, ANR_PROVIDER_DLL_SHA256):
        return None
    provider_root = root / ANR_PROVIDER_REL_DIR
    if provider_root.is_symlink() or not provider_root.is_dir():
        return None
    files = []
    for item in sorted(provider_root.rglob("*")):
        if item.is_symlink():
            return None
        if item.is_file():
            files.append(item.relative_to(root).as_posix())
    if ANR_PROVIDER_DLL_REL not in files:
        return None
    return {
        "version": ANR_VERSION,
        "optiscaler_commit": ANR_OPTISCALER_COMMIT,
        "proxy_dll": proxy_dll,
        "proxy_sha256": ANR_OPTISCALER_SHA256,
        "provider_dll_sha256": ANR_PROVIDER_DLL_SHA256,
        "root": root,
        "files": files,
    }


def _extract_verified(archive, dest):
    """Extract only the pinned proxy DLL and ANR provider tree from the zip."""
    dest = Path(dest)
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    saw_proxy = False
    extracted_files = []
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            # Reject symlinks encoded in Unix zip attributes.
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError(f"ANR archive contains a symlink entry: {info.filename!r}")
            name = info.filename
            if name == ARCHIVE_PROXY_MEMBER:
                target = dest / "dxgi.dll"
                saw_proxy = True
            else:
                rel = _safe_relative_provider_path(name)
                if rel is None:
                    continue
                target = dest.joinpath(*PurePosixPath(rel).parts)
                extracted_files.append(rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, target.open("wb") as out:
                shutil.copyfileobj(src, out, length=1 << 20)
    if not saw_proxy:
        raise ValueError(f"{archive.name} did not contain {ARCHIVE_PROXY_MEMBER}")
    if not _matches(dest / "dxgi.dll", ANR_OPTISCALER_BYTES, ANR_OPTISCALER_SHA256):
        raise ValueError("ANR OptiScaler proxy DLL checksum mismatch")
    if ANR_PROVIDER_DLL_REL not in extracted_files:
        raise ValueError(f"{archive.name} did not contain {ANR_PROVIDER_DLL_REL}")
    if not _matches(dest / ANR_PROVIDER_DLL_REL, ANR_PROVIDER_DLL_BYTES, ANR_PROVIDER_DLL_SHA256):
        raise ValueError("ANR provider DLL checksum mismatch")
    return _cached_package(dest)


def fetch(cache_dir, logger=None):
    """Download, verify, and unpack the pinned ANR FG package into cache_dir."""
    cache = Path(cache_dir) / ANR_VERSION
    unpacked = cache / "unpacked"
    existing = _cached_package(unpacked)
    if existing is not None:
        return existing

    archive = cache / ANR_ASSET
    if not _matches(archive, ANR_ARCHIVE_BYTES, ANR_ARCHIVE_SHA256):
        archive.unlink(missing_ok=True)
        url = release_url()
        if logger:
            logger.info("downloading ANR FG %s from %s", ANR_VERSION, url)
        wiki.download(url, archive, timeout=300)
        if not _matches(archive, ANR_ARCHIVE_BYTES, ANR_ARCHIVE_SHA256):
            archive.unlink(missing_ok=True)
            raise ValueError(f"{ANR_ASSET} archive checksum mismatch")

    try:
        package = _extract_verified(archive, unpacked)
    except Exception:
        shutil.rmtree(unpacked, ignore_errors=True)
        raise
    if package is None:
        shutil.rmtree(unpacked, ignore_errors=True)
        raise ValueError("ANR FG extracted package failed verification")
    if logger:
        logger.info("ANR FG %s ready at %s", ANR_VERSION, unpacked)
    return package


def ini_changes():
    """OptiScaler.ini settings required for ANR FG frame generation."""
    return [
        {"section": "FrameGen", "key": "Enabled", "value": "auto"},
        {"section": "FrameGen", "key": "FGInput", "value": "nvngxfg"},
        {"section": "FrameGen", "key": "FGOutput", "value": "auto"},
        {"section": "FrameGen", "key": "FGNvngxReplacement", "value": ANR_PROVIDER_NAME},
        {"section": "FrameGen", "key": "DisableHudless", "value": "false"},
    ]


def is_ini_configured(ini_path):
    """Whether OptiScaler.ini points FrameGen at Apex Neural Rendering FG."""
    path = Path(ini_path)
    if not path.is_file():
        return False
    try:
        ini = IniFile(path)
    except OSError:
        return False
    fg_input = str(ini.get("FrameGen", "FGInput", "auto")).strip().lower()
    replacement = str(ini.get("FrameGen", "FGNvngxReplacement", "auto")).strip()
    return fg_input == "nvngxfg" and replacement.casefold() == ANR_PROVIDER_NAME.casefold()


def status(target_dir):
    """Report ANR FG installation and verification state for one game folder."""
    from . import installer

    target = Path(target_dir)
    manifest = None
    try:
        manifest = installer.read_manifest(target)
    except ValueError:
        manifest = None

    anr_record = (manifest or {}).get("anr_fg") or {}
    managed_active = bool(anr_record and anr_record.get("enabled"))
    filename = (manifest or {}).get("filename")
    proxy_path = target / filename if filename else None
    provider_dll = target / ANR_PROVIDER_DLL_REL
    provider_present = provider_dll.is_file() and not provider_dll.is_symlink()
    provider_verified = _matches(provider_dll, ANR_PROVIDER_DLL_BYTES, ANR_PROVIDER_DLL_SHA256)
    proxy_matches_anr = bool(
        proxy_path and _matches(proxy_path, ANR_OPTISCALER_BYTES, ANR_OPTISCALER_SHA256)
    )
    ini_configured = is_ini_configured(target / INI_NAME)
    active = bool(managed_active and provider_verified and proxy_matches_anr)

    return {
        "installed": bool(provider_present or managed_active),
        "managed": bool(manifest is not None),
        "active": active,
        "version": anr_record.get("version") if managed_active else None,
        "pinned_version": ANR_VERSION,
        "optiscaler_commit": ANR_OPTISCALER_COMMIT,
        "provider_name": ANR_PROVIDER_NAME,
        "provider_present": provider_present,
        "provider_verified": provider_verified,
        "proxy_matches_anr": proxy_matches_anr,
        "ini_configured": ini_configured,
        "release_url": release_page(),
    }
