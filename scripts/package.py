#!/usr/bin/env python3
"""Package the plugin into a Decky-installable zip.

Mirrors the layout `decky plugin build` produces: a single top-level directory
named after plugin.json's "name", holding the runtime files only.
"""

import json
import shutil
import stat
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "out"

# Files and directories that make up the installed plugin.
INCLUDE_FILES = ["plugin.json", "package.json", "main.py", "README.md", "LICENSE"]
INCLUDE_DIRS = ["dist", "py_modules", "bin", "defaults"]

EXCLUDE_NAMES = {"__pycache__", ".DS_Store", "node_modules", ".git"}
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".map", ".tmp"}


def keep(path: Path) -> bool:
    if any(part in EXCLUDE_NAMES for part in path.parts):
        return False
    return path.suffix not in EXCLUDE_SUFFIXES


def collect():
    entries = []
    for name in INCLUDE_FILES:
        path = ROOT / name
        if path.is_file():
            entries.append((path, Path(name)))
        else:
            print(f"  note: {name} not found, skipping")
    for name in INCLUDE_DIRS:
        base = ROOT / name
        if not base.is_dir():
            print(f"  note: {name}/ not found, skipping")
            continue
        for path in sorted(base.rglob("*")):
            if path.is_file() and keep(path.relative_to(ROOT)):
                entries.append((path, path.relative_to(ROOT)))
    return entries


# bin/ holds exactly two things: the pinned OptiScaler release archive and the
# compiled live-control ASI. Anything else is almost certainly an extracted
# payload, which would multiply the zip size.
ALLOWED_BIN_SUFFIXES = (".7z", ".asi")


def check_bin():
    """bin/ must hold only the release archive and the live-control plugin."""
    bin_dir = ROOT / "bin"
    if not bin_dir.is_dir():
        return
    strays = [
        p for p in bin_dir.iterdir()
        if p.is_dir()
        or (p.is_file() and p.suffix not in ALLOWED_BIN_SUFFIXES and p.name != ".DS_Store")
    ]
    if strays:
        sys.exit(
            "bin/ contains unexpected files: "
            + ", ".join(p.name for p in strays)
            + "\nRemove them (they are probably an extracted payload) and re-run."
        )

    asi = bin_dir / "decky_optiscaler_live.asi"
    if not asi.is_file():
        print("  note: bin/decky_optiscaler_live.asi missing -- live in-game control "
              "will be unavailable. Build it with asi/build.sh.")
    if not (bin_dir / "OptiPatcher.asi").is_file():
        print("  note: bin/OptiPatcher.asi missing -- the OptiPatcher option will be "
              "offered as unavailable. Fetch it from the OptiPatcher rolling release.")


def main():
    plugin = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    name = plugin["name"]
    version = package.get("version", "0.0.0")
    check_bin()

    if not (ROOT / "dist" / "index.js").is_file():
        sys.exit("dist/index.js is missing — run `pnpm build` first.")

    OUT_DIR.mkdir(exist_ok=True)
    archive = OUT_DIR / f"{name}.zip"
    if archive.exists():
        archive.unlink()

    entries = collect()
    total = 0
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for source, relative in entries:
            arcname = Path(name) / relative
            info = zipfile.ZipInfo(str(arcname))
            info.date_time = (2026, 1, 1, 0, 0, 0)
            executable = source.stat().st_mode & stat.S_IXUSR
            info.external_attr = (0o755 if executable else 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            data = source.read_bytes()
            total += len(data)
            zf.writestr(info, data)

    size = archive.stat().st_size
    print(f"\n{archive}  (version {version})")
    print(f"  {len(entries)} files, {total / 1e6:.1f} MB uncompressed -> {size / 1e6:.1f} MB zip")

    # The bundled release dominates the size; call it out so it is not a surprise.
    payload = next((r for _, r in entries if r.parts[0] == "bin"), None)
    if payload:
        print(f"  includes {payload} (OptiScaler release)")
    return archive


if __name__ == "__main__":
    main()
