#!/usr/bin/env python3
"""Record or verify the native bridge's binary and source identity."""
import argparse
import hashlib
import json
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parent.parent
METADATA = ROOT / "defaults/live-build.json"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def current():
    profile = json.loads((ROOT / "defaults/live-profile.json").read_text())
    binary = ROOT / "bin/decky_optiscaler_live.asi"
    data = binary.read_bytes()
    if data[:2] != b"MZ" or len(data) < 64:
        raise ValueError("Live bridge is not a Windows image")
    offset = struct.unpack_from("<I", data, 60)[0]
    if offset + 24 > len(data) or data[offset:offset + 4] != b"PE\0\0":
        raise ValueError("Invalid live bridge PE header")
    machine, = struct.unpack_from("<H", data, offset + 4)
    characteristics, = struct.unpack_from("<H", data, offset + 22)
    if machine != 0x8664 or not characteristics & 0x2000:
        raise ValueError("Live bridge must be a Windows x64 DLL")
    if b"InitializeASI\0" not in data:
        raise ValueError("Live bridge does not export InitializeASI")
    sources = sorted(p for p in (ROOT / "asi").rglob("*")
                     if p.is_file() and p.suffix in (".cpp", ".h")
                     and "optiscaler_ref" not in p.parts and "tests" not in p.parts
                     and not p.stem.endswith("_tests"))
    sources.append(ROOT / "defaults/live-profile.json")
    return {
        "schema": profile["schema"],
        "build_id": profile["build_id"],
        "profile_id": profile["profile_id"],
        "sha256": digest(binary),
        "core_sha256": profile["core_sha256"],
        "toolchain": {"zig": "0.15.2", "target": "x86_64-windows-gnu"},
        "source_files": {p.relative_to(ROOT).as_posix(): digest(p) for p in sources},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    result = current()
    if args.check:
        if json.loads(METADATA.read_text()) != result:
            raise SystemExit("Live bridge metadata is stale; rebuild with asi/build.sh")
        print("Native bridge binary and source identity: PASS")
    else:
        METADATA.write_text(json.dumps(result, indent=2) + "\n", newline="\n")
        print("Recorded native bridge binary and source identity")


if __name__ == "__main__":
    main()
