#!/usr/bin/env python3
"""Print one version's section of CHANGELOG.md.

The release workflow uses this for the GitHub release body, so the notes on the
releases page and the notes in the repository are the same text.

    python3 scripts/changelog_section.py 0.0.1
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG = ROOT / "CHANGELOG.md"

# "## [0.0.1] - 2026-08-20", "## 0.0.1" or "## v0.0.1" all name a release.
HEADING = re.compile(r"^##\s+\[?v?(?P<version>\d[^\]\s]*)\]?")


def section(version: str) -> str:
    version = version.lstrip("v")
    lines = CHANGELOG.read_text(encoding="utf-8").splitlines()
    body: list[str] = []
    collecting = False
    for line in lines:
        match = HEADING.match(line)
        if match:
            if collecting:
                break
            collecting = match.group("version") == version
            continue
        if collecting:
            body.append(line)
    return "\n".join(body).strip("\n")


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <version>", file=sys.stderr)
        return 2
    version = sys.argv[1]
    text = section(version)
    if not text:
        print(f"no CHANGELOG.md section for version {version}", file=sys.stderr)
        return 1
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
