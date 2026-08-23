#!/usr/bin/env python3
"""Refresh the compatibility list bundled with the plugin.

The plugin ships a copy of the OptiScaler wiki's compatibility list so that a
Deck which has never reached the network still has one — without it, an offline
install reports "no wiki entry matched this game" for every game it owns, which
is indistinguishable from the wiki being broken.

It is only a floor. The runtime cache replaces it on the first successful
fetch, and the service refreshes that behind whatever answer it just gave. Run
this before cutting a release so the floor is not years old.

    python3 scripts/fetch_compat_seed.py
"""

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py_modules"))

from optiscaler import wiki  # noqa: E402
from optiscaler.constants import COMPAT_LIST_PAGE, WIKI_RAW_BASE  # noqa: E402

SEED = ROOT / "defaults" / "compat-list.json"


def main():
    url = f"{WIKI_RAW_BASE}/{COMPAT_LIST_PAGE}"
    print(f"fetching {url}")
    markdown = wiki._http_get(url)
    entries = wiki.parse_compat_list(markdown)
    if not entries:
        print("  the page downloaded but parsed to zero rows — refusing to write", file=sys.stderr)
        return 1

    previous = None
    if SEED.is_file():
        try:
            previous = wiki.fingerprint(json.loads(SEED.read_text())["entries"])
        except (OSError, ValueError, KeyError):
            previous = None

    SEED.parent.mkdir(parents=True, exist_ok=True)
    SEED.write_text(
        json.dumps({"fetched_at": time.time(), "entries": entries}, ensure_ascii=False),
        encoding="utf-8",
    )
    current = wiki.fingerprint(entries)
    size = SEED.stat().st_size
    print(f"  {len(entries)} entries, {size / 1024:.0f} KB -> {SEED.relative_to(ROOT)}")
    print(f"  revision {previous or 'none'} -> {current}"
          f"{'' if previous != current else '  (unchanged)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
