"""Look up install settings in the OptiScaler wiki compatibility list.

The wiki is a git-backed set of pages served as raw text, so we parse the
markdown table in Compatibility-List.md and, when a game has its own entry, the
AsciiDoc detail page that names the exact proxy filename to install as.
"""

import difflib
import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .constants import (
    COMPAT_CACHE_TTL,
    COMPAT_LIST_PAGE,
    DEFAULT_PROXY,
    PROXY_FILENAMES,
    WIKI_HTML_BASE,
    WIKI_RAW_BASE,
)

USER_AGENT = "decky-optiscaler/0.1 (+https://github.com/SteamDeckHomebrew)"

NOISE_WORDS = {
    "the", "a", "an", "of", "and",
    "goty", "definitive", "remastered", "edition", "complete", "deluxe",
    "ultimate", "directors", "director", "cut", "enhanced", "hd", "remake",
}

ROW_RE = re.compile(r"^\|(.+)\|\s*$")
LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
# `dxgi.dll` / `OptiScaler.asi` in backticks, optionally quoted
FILENAME_RE = re.compile(
    r"`?\b(" + "|".join(re.escape(f).replace(r"\.", r"\.") for f in PROXY_FILENAMES) + r")\b`?",
    re.IGNORECASE,
)
PROXY_LOOKUP = {f.lower(): f for f in PROXY_FILENAMES}


# SteamOS images do not always expose a CA bundle where Python looks for one,
# and the Decky plugin runs with a trimmed environment, so the default context
# can fail with CERTIFICATE_VERIFY_FAILED even though the network is fine. Try
# every bundle we can find before giving up.
SYSTEM_CA_BUNDLES = (
    "/etc/ssl/certs/ca-certificates.crt",   # SteamOS / Arch / Debian
    "/etc/pki/tls/certs/ca-bundle.crt",     # Fedora / RHEL
    "/etc/ssl/ca-bundle.pem",               # openSUSE
    "/etc/ssl/cert.pem",                    # macOS / BSD
)

_ssl_context = None
_ssl_context_kind = None


def _candidate_contexts():
    """SSL contexts to try, most trustworthy first.

    Building a context can itself fail when the trust store is missing or
    unreadable, so every candidate is constructed defensively - one that cannot
    be built must not take the remaining fallbacks down with it.
    """
    try:
        yield "default", ssl.create_default_context()
    except Exception:
        pass

    try:
        import certifi
    except ImportError:
        pass
    else:
        try:
            yield "certifi", ssl.create_default_context(cafile=certifi.where())
        except Exception:
            pass

    for bundle in SYSTEM_CA_BUNDLES:
        if Path(bundle).is_file():
            try:
                yield f"system:{bundle}", ssl.create_default_context(cafile=bundle)
            except Exception:
                continue

    # Last resort. The compatibility list is public, read-only data and we send
    # no credentials, so an unverified fetch leaks nothing; the alternative is
    # the whole wiki lookup silently reporting "game not in list".
    unverified = ssl.create_default_context()
    unverified.check_hostname = False
    unverified.verify_mode = ssl.CERT_NONE
    yield "unverified", unverified


def ssl_context_kind():
    """Which CA source the last successful fetch used, for diagnostics."""
    return _ssl_context_kind


def _is_tls_error(exc):
    """True when a request failed at the TLS layer rather than the network.

    urllib raises URLError with the SSLError as its .reason, so the SSLError
    never surfaces directly - checking only for ssl.SSLError silently skips
    every fallback context.
    """
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, ssl.SSLError):
            return True
        exc = getattr(exc, "reason", None) if isinstance(exc, urllib.error.URLError) else None
    return False


def _http_get(url, timeout=20):
    global _ssl_context, _ssl_context_kind

    # Wiki page names contain characters such as U+2010 HYPHEN, which urllib
    # cannot put on the request line unencoded.
    url = urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%~")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

    if _ssl_context is not None:
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context) as response:
                return response.read().decode("utf-8", errors="replace")
        except Exception as exc:
            if not _is_tls_error(exc):
                raise
            # The remembered context stopped verifying (image update, clock
            # skew); fall through and pick a working one again.
            _ssl_context, _ssl_context_kind = None, None

    last_error = None
    for kind, context in _candidate_contexts():
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
                body = response.read().decode("utf-8", errors="replace")
        except Exception as exc:
            # urlopen wraps the SSLError in URLError, so catching ssl.SSLError
            # here would never fire and the fallbacks would never be reached.
            if not _is_tls_error(exc):
                raise
            last_error = exc
            continue
        # Only remember the context once it has actually completed a request.
        _ssl_context, _ssl_context_kind = context, kind
        return body

    raise last_error if last_error else urllib.error.URLError("no usable TLS context")


def tokens(name):
    """Word tokens of a game name, with noise words dropped."""
    text = name.lower().replace("\u2019", "'").replace("\u2010", "-").replace("\u2013", "-")
    words = re.findall(r"[a-z0-9]+", text)
    return [w for w in words if w not in NOISE_WORDS]


def normalize(name):
    """Fold a game name to a comparable key."""
    text = name.lower()
    text = text.replace("’", "'").replace("‐", "-").replace("–", "-")
    text = re.sub(r"\b(the|a|an)\b", " ", text)
    text = re.sub(r"\b(goty|game of the year|definitive|remastered|edition|"
                  r"complete|deluxe|ultimate|directors cut|director's cut)\b", " ", text)
    text = re.sub(r"[^a-z0-9]+", "", text)
    return text


def _split_row(line):
    m = ROW_RE.match(line.strip())
    if not m:
        return None
    return [c.strip() for c in m.group(1).split("|")]


def parse_compat_list(markdown):
    """Parse the compatibility table into structured entries."""
    entries = []
    in_table = False
    for raw in markdown.splitlines():
        line = raw.strip()
        if line.startswith("|") and "Game" in line and "Compatibility" in line:
            in_table = True
            continue
        if not in_table:
            continue
        if line.startswith("|") and set(line) <= set("|-: "):
            continue  # separator row
        cells = _split_row(line)
        if not cells or len(cells) < 2:
            if line and not line.startswith("|"):
                in_table = False
            continue

        name_cell = cells[0]
        page = None
        link = LINK_RE.search(name_cell)
        if link:
            name = link.group(1).strip()
            target = link.group(2).strip()
            if not target.startswith("http"):
                page = target.split("#")[0]
        else:
            name = re.sub(r"[\[\]]", "", name_cell).strip()
        if not name:
            continue

        entries.append(
            {
                "name": name,
                "key": normalize(name),
                "page": page,
                "compatibility": cells[1] if len(cells) > 1 else "",
                "inputs": cells[2] if len(cells) > 2 else "",
                "optipatcher": bool(cells[3].strip()) if len(cells) > 3 else False,
                "notes": cells[4] if len(cells) > 4 else "",
            }
        )
    return entries


def filenames_in_text(text):
    """Proxy filenames mentioned in a blob of text, in order of appearance."""
    found = []
    for match in FILENAME_RE.finditer(text or ""):
        canonical = PROXY_LOOKUP.get(match.group(1).lower())
        if canonical and canonical not in found:
            found.append(canonical)
    return found


def parse_detail_page(asciidoc):
    """Pull the labelled rows out of a wiki compatibility entry."""
    fields = {}
    label = None
    buffer = []

    def flush():
        if label:
            value = " ".join(v.strip() for v in buffer if v.strip())
            value = re.sub(r"^a\|", "", value).strip()
            fields[label] = value

    for raw in asciidoc.splitlines():
        line = raw.rstrip()
        m = re.match(r"^\|\s*\*\*(.+?)\*\*\s*$", line.strip())
        if m:
            flush()
            label = m.group(1).strip()
            buffer = []
            continue
        if label is not None:
            if line.strip() in ("|===", "|==="):
                break
            buffer.append(re.sub(r"^\s*[|*]\s*", "", line))
    flush()
    return fields


class WikiClient:
    def __init__(self, cache_dir):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.list_cache = self.cache_dir / "compat-list.json"
        self.page_cache = self.cache_dir / "pages"
        self.page_cache.mkdir(parents=True, exist_ok=True)

    # -- compatibility list ---------------------------------------------
    def load_entries(self, force=False):
        """Return (entries, meta). Falls back to a stale cache when offline."""
        meta = {"source": "cache", "fetched_at": None, "error": None}
        cached = None
        if self.list_cache.exists():
            try:
                cached = json.loads(self.list_cache.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                cached = None

        fresh_enough = (
            cached
            and not force
            and (time.time() - cached.get("fetched_at", 0)) < COMPAT_CACHE_TTL
        )
        if fresh_enough:
            meta["fetched_at"] = cached["fetched_at"]
            return cached["entries"], meta

        try:
            markdown = _http_get(f"{WIKI_RAW_BASE}/{COMPAT_LIST_PAGE}")
            entries = parse_compat_list(markdown)
            if entries:
                payload = {"fetched_at": time.time(), "entries": entries}
                self.list_cache.write_text(json.dumps(payload), encoding="utf-8")
                meta.update(source="network", fetched_at=payload["fetched_at"],
                            tls=ssl_context_kind())
                return entries, meta
            meta["error"] = "compatibility list downloaded but parsed to zero rows"
        except Exception as exc:  # network, TLS, disk, decoding — all non-fatal
            meta["error"] = f"{type(exc).__name__}: {exc}"

        meta["tls"] = ssl_context_kind()
        if cached:
            meta["fetched_at"] = cached.get("fetched_at")
            return cached["entries"], meta
        return [], meta

    def load_page(self, page, force=False):
        """Fetch a wiki detail page, caching the raw AsciiDoc."""
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", page)
        cached_file = self.page_cache / f"{safe}.adoc"
        if cached_file.exists() and not force:
            age = time.time() - cached_file.stat().st_mtime
            if age < COMPAT_CACHE_TTL:
                return cached_file.read_text(encoding="utf-8", errors="replace")
        for suffix in (".asciidoc", ".md"):
            try:
                text = _http_get(f"{WIKI_RAW_BASE}/{page}{suffix}")
            except Exception:
                continue
            cached_file.write_text(text, encoding="utf-8")
            return text
        if cached_file.exists():
            return cached_file.read_text(encoding="utf-8", errors="replace")
        return None

    # -- matching --------------------------------------------------------
    @staticmethod
    def _score(probe_key, probe_tokens, entry):
        """Similarity of one candidate name to one compatibility-list entry."""
        entry_key = entry["key"]
        if not entry_key or not probe_key:
            return 0.0
        if entry_key == probe_key:
            return 1.0

        # Steam's install folder is often a fragment of the full title, e.g.
        # "Expedition 33" for "Clair Obscur: Expedition 33". Substring rather
        # than prefix, but only when the fragment is substantial enough to be
        # distinctive.
        shorter, longer = sorted((probe_key, entry_key), key=len)
        if len(shorter) >= 6 and shorter in longer:
            return 0.80 + 0.15 * (len(shorter) / len(longer))

        # Token containment catches reordered or punctuation-heavy titles.
        entry_tokens = entry.get("tokens") or []
        if probe_tokens and entry_tokens:
            probe_set, entry_set = set(probe_tokens), set(entry_tokens)
            overlap = probe_set & entry_set
            if overlap:
                if probe_set <= entry_set or entry_set <= probe_set:
                    small, large = sorted((len(probe_set), len(entry_set)))
                    # A single shared word is far too weak on its own.
                    if small >= 2 or (small == 1 and len(next(iter(overlap))) >= 8):
                        return 0.80 + 0.15 * (small / large)
                coverage = len(overlap) / max(len(probe_set), len(entry_set))
                if coverage >= 0.75:
                    return 0.78 + 0.12 * coverage

        return difflib.SequenceMatcher(None, probe_key, entry_key).ratio()

    def match(self, name, entries, extra_names=None):
        """Best compatibility-list entry for a game name, or None."""
        for entry in entries:
            if "tokens" not in entry:
                entry["tokens"] = tokens(entry["name"])

        best = None
        best_score = 0.0
        for candidate in [name] + list(extra_names or []):
            probe_key = normalize(candidate)
            probe_tokens = tokens(candidate)
            if not probe_key:
                continue
            for entry in entries:
                score = self._score(probe_key, probe_tokens, entry)
                if score > best_score:
                    best, best_score = entry, score
        if best and best_score >= 0.78:
            return dict(best, match_score=round(best_score, 3))
        return None

    def near_misses(self, name, entries, extra_names=None, limit=8):
        """Closest entries below the match threshold, for manual picking."""
        scored = []
        for candidate in [name] + list(extra_names or []):
            probe_key = normalize(candidate)
            probe_tokens = tokens(candidate)
            if not probe_key:
                continue
            for entry in entries:
                if "tokens" not in entry:
                    entry["tokens"] = tokens(entry["name"])
                scored.append((self._score(probe_key, probe_tokens, entry), entry))
        scored.sort(key=lambda pair: -pair[0])
        out = []
        seen = set()
        for score, entry in scored:
            if entry["name"] in seen:
                continue
            seen.add(entry["name"])
            out.append({"name": entry["name"], "page": entry["page"],
                        "score": round(score, 3)})
            if len(out) >= limit:
                break
        return out

    def search(self, query, limit=30):
        """Free-text search over the compatibility list for manual selection."""
        entries, meta = self.load_entries()
        needle = normalize(query)
        needle_tokens = set(tokens(query))
        results = []
        for entry in entries:
            if "tokens" not in entry:
                entry["tokens"] = tokens(entry["name"])
            key = entry["key"]
            if needle and needle in key:
                score = 1.0 if key == needle else 0.9
            elif needle_tokens and needle_tokens <= set(entry["tokens"]):
                score = 0.85
            elif needle and difflib.SequenceMatcher(None, needle, key).ratio() > 0.6:
                score = difflib.SequenceMatcher(None, needle, key).ratio()
            else:
                continue
            results.append({
                "name": entry["name"],
                "page": entry["page"],
                "compatibility": entry["compatibility"],
                "inputs": entry["inputs"],
                "score": round(score, 3),
            })
        results.sort(key=lambda r: (-r["score"], r["name"]))
        return {"results": results[:limit], "meta": meta, "entry_count": len(entries)}

    def entry_by_name(self, name):
        """Exact lookup used when the user picks an entry by hand."""
        entries, _ = self.load_entries()
        for entry in entries:
            if entry["name"] == name:
                return entry
        return None

    def recommend_entry(self, entry, force=False):
        """Build a recommendation from an already-chosen compatibility entry."""
        result = {
            "matched": True,
            "searched": [],
            "entry_count": 0,
            "list_available": True,
            "near_misses": [],
            "game": entry["name"],
            "filename": DEFAULT_PROXY,
            "filename_source": "default",
            "alternatives": [],
            "compatibility": entry.get("compatibility"),
            "inputs": entry.get("inputs"),
            "notes": entry.get("notes") or None,
            "optipatcher": entry.get("optipatcher", False),
            "wiki_url": (
                f"{WIKI_HTML_BASE}/{entry['page']}" if entry.get("page")
                else f"{WIKI_HTML_BASE}/Compatibility-List"
            ),
            "detail": {},
            "list_meta": {"source": "manual", "fetched_at": None, "error": None},
            "match_score": 1.0,
            "manual": True,
        }
        if entry.get("page"):
            asciidoc = self.load_page(entry["page"], force=force)
            if asciidoc:
                fields = parse_detail_page(asciidoc)
                result["detail"] = fields
                names = filenames_in_text(fields.get("Filename", ""))
                if names:
                    result.update(filename=names[0], alternatives=names[1:],
                                  filename_source="wiki entry")
                    return result
        names = filenames_in_text(entry.get("notes", ""))
        if names:
            result.update(filename=names[0], alternatives=names[1:],
                          filename_source="compatibility list notes")
        return result

    def recommend(self, name, extra_names=None, force=False):
        """Recommend an install filename for a game, with the evidence."""
        entries, meta = self.load_entries(force=force)
        searched = [n for n in ([name] + list(extra_names or [])) if n]
        result = {
            "matched": False,
            "searched": searched,
            "entry_count": len(entries),
            "list_available": bool(entries),
            "near_misses": [],
            "game": None,
            "filename": DEFAULT_PROXY,
            "filename_source": "default",
            "alternatives": [],
            "compatibility": None,
            "inputs": None,
            "notes": None,
            "optipatcher": False,
            "wiki_url": None,
            "detail": {},
            "list_meta": meta,
            "match_score": None,
        }
        if not entries:
            return result

        entry = self.match(name, entries, extra_names)
        if not entry:
            # Show what nearly matched so a wrong folder name is obvious.
            result["near_misses"] = self.near_misses(name, entries, extra_names)
            return result

        result.update(
            matched=True,
            game=entry["name"],
            compatibility=entry["compatibility"],
            inputs=entry["inputs"],
            notes=entry["notes"] or None,
            optipatcher=entry["optipatcher"],
            match_score=entry["match_score"],
            wiki_url=(
                f"{WIKI_HTML_BASE}/{entry['page']}" if entry["page"] else
                f"{WIKI_HTML_BASE}/Compatibility-List"
            ),
        )

        # A dedicated entry states the filename explicitly; prefer it.
        if entry["page"]:
            asciidoc = self.load_page(entry["page"], force=force)
            if asciidoc:
                fields = parse_detail_page(asciidoc)
                result["detail"] = fields
                names = filenames_in_text(fields.get("Filename", ""))
                if names:
                    result.update(
                        filename=names[0],
                        alternatives=names[1:],
                        filename_source="wiki entry",
                    )
                    return result

        # Otherwise mine the notes column for "install as `winmm.dll`".
        names = filenames_in_text(entry["notes"])
        if names:
            result.update(
                filename=names[0],
                alternatives=names[1:],
                filename_source="compatibility list notes",
            )
        return result
