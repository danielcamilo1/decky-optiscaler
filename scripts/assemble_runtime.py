#!/usr/bin/env python3
"""Verify and copy the complete official release archive without repacking it."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'py_modules'))
from optiscaler.payload import extract_archive


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    expected = json.loads((ROOT / 'defaults/runtime-manifest.json').read_text())
    if digest(args.release_archive) != expected['archive_sha256']:
        raise ValueError('Official release archive checksum mismatch')
    if args.output.exists():
        raise FileExistsError('Choose a fresh output archive')
    with tempfile.TemporaryDirectory(prefix='decky-runtime-inputs-') as tmp:
        stage = Path(tmp) / 'runtime'
        extract_archive(args.release_archive, stage)
        inventory = {p.relative_to(stage).as_posix(): {'bytes': p.stat().st_size, 'sha256': digest(p)}
                     for p in stage.rglob('*') if p.is_file()}
        if inventory != expected['files']:
            raise ValueError('Component inventory differs from the reviewed runtime pin')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.release_archive, args.output)
    print(json.dumps({'archive': args.output.name, 'sha256': digest(args.output),
                      'component_files': len(inventory)}))


if __name__ == '__main__':
    main()
