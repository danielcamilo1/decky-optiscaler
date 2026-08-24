"""Look up install settings in the OptiScaler wiki compatibility list.

The wiki is a git-backed set of pages served as raw text, so we parse the
markdown table in Compatibility-List.md and, when a game has its own entry, the
AsciiDoc detail page that names the exact proxy filename to install as.
"""

import difflib
import hashlib
import json
import re
import socket
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

# How long to leave a detail page alone after it fails to download. Long enough
# that a wiki which is simply unreachable is asked once rather than on every
# question, short enough that coming back onto a network is noticed.
PAGE_RETRY_AFTER = 300

NOISE_WORDS = {
    "the", "a", "an", "of", "and",
    "goty", "definitive", "remastered", "edition", "complete", "deluxe",
    "ultimate", "directors", "director", "cut", "enhanced", "hd", "remake",
}

ROW_RE = re.compile(r"^\|(.+)\|\s*$")
# `[Game name](Wiki-Page)`. The target has to allow one level of nested
# parentheses, because wiki page names carry them: "[Resident Evil 2
# (2019)](Resident-Evil-2-(2019))". A target of `[^)]+` stops at the *inner*
# closing bracket and yields the page "Resident-Evil-2-(2019", which the wiki
# does not serve — so the detail page for every parenthesised title silently
# never downloaded, and those are exactly the Resident Evil entries whose
# settings and REFramework instructions live on the page rather than in the
# notes column.
LINK_RE = re.compile(r"\[([^\]]+)\]\(((?:[^()]|\([^()]*\))+)\)")
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
    #
    # Built without loading a trust store, and guarded like every other
    # candidate: `create_default_context` reads the system store, so on the one
    # machine where that is what is broken, the fallback meant to survive it
    # was the one construction that could throw the whole chain away.
    try:
        unverified = ssl._create_unverified_context()
    except Exception:
        return
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


class _ipv4_only:
    """Resolve names to IPv4 for the duration of one request.

    The classic "works on my machine" network fault: a router advertises IPv6,
    the address resolves, and nothing routes. Python's urllib has no Happy
    Eyeballs, so it does not fall back the way a browser does — it sits on the
    first address until the timeout, every time, and the wiki simply never
    loads on that network while everything else on the Deck is fine.
    """

    def __enter__(self):
        self._real = socket.getaddrinfo

        def ipv4(host, port, family=0, *args, **kwargs):
            return self._real(host, port, socket.AF_INET, *args, **kwargs)

        socket.getaddrinfo = ipv4
        return self

    def __exit__(self, *exc):
        socket.getaddrinfo = self._real
        return False


def _open(request, timeout, context, binary=False):
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        body = response.read()
    return body if binary else body.decode("utf-8", errors="replace")


def _is_retryable(exc):
    """True for a failure a second attempt could plausibly answer."""
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return True
    if isinstance(exc, urllib.error.HTTPError):
        return False  # the server answered; asking again says the same thing
    if isinstance(exc, urllib.error.URLError):
        return isinstance(exc.reason, (socket.timeout, TimeoutError, ConnectionError, OSError))
    return isinstance(exc, (ConnectionError, OSError))


def _http_get(url, timeout=12, binary=False):
    global _ssl_context, _ssl_context_kind

    # Wiki page names contain characters such as U+2010 HYPHEN, which urllib
    # cannot put on the request line unencoded.
    url = urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%~")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

    def attempt(context):
        """One fetch, retried once over IPv4 when the network stalls.

        A TLS failure is re-raised for the caller to answer with a different
        trust store; anything else gets the IPv4 retry, because a stalled
        connection and a genuinely unreachable host look identical from here
        and only one of them is worth a second try.
        """
        try:
            return _open(request, timeout, context, binary)
        except Exception as exc:
            if _is_tls_error(exc) or not _is_retryable(exc):
                raise
            with _ipv4_only():
                return _open(request, timeout, context, binary)

    if _ssl_context is not None:
        try:
            return attempt(_ssl_context)
        except Exception as exc:
            if not _is_tls_error(exc):
                raise
            # The remembered context stopped verifying (image update, clock
            # skew); fall through and pick a working one again.
            _ssl_context, _ssl_context_kind = None, None

    last_error = None
    for kind, context in _candidate_contexts():
        try:
            body = attempt(context)
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


def download(url, dest, timeout=90):
    """Fetch a binary file to `dest`, via the same transport the wiki uses.

    It lives here, in the module about the compatibility list, because the
    transport does: the IPv4 retry, the CA-bundle fallback chain and the rule
    that a server which *answered* is never retried are all lessons this plugin
    learned the hard way on real Decks, and a second downloader that had not
    learned them would fail on exactly the networks these were written for.

    Written to a temporary file and moved into place, so a download that dies
    half way through leaves no half a DLL behind for the next run to trust.
    """
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    body = _http_get(url, timeout=timeout, binary=True)
    if not body:
        raise ValueError(f"empty response from {url}")
    partial = dest.with_name(dest.name + ".part")
    partial.write_bytes(body)
    partial.replace(dest)
    return dest


def download_json(url, timeout=20):
    """Fetch and parse JSON over the same transport."""
    return json.loads(_http_get(url, timeout=timeout))


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


def fingerprint(entries):
    """A short, stable id for one version of the compatibility list.

    Content rather than a counter: it survives the plugin being reloaded, and
    "the list changed" is then exactly "the content differs" — which is the
    question the UI asks when it decides whether a background refresh is worth
    redrawing for.
    """
    if not entries:
        return ""
    blob = json.dumps(entries, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


class WikiClient:
    """The compatibility list, served from cache and refreshed behind it.

    The wiki is a network resource on a handheld that is regularly offline, in
    sleep, or on a network that resolves but does not route — so waiting for it
    is the wrong default. Reading is therefore **stale-while-revalidate**:
    whatever is already on disk is returned at once and the network is never on
    the path of a question the user asked. `revalidate()` is the fetch, run
    behind that answer by the service, and it replaces the cache only when it
    actually succeeds.

    Three sources, in order: the runtime cache written by the last successful
    fetch, the copy bundled with the plugin (so a Deck that has never had a
    connection still has a list), and finally the network. A failed refresh
    changes nothing but the error the UI is allowed to print.
    """

    def __init__(self, cache_dir, seed_path=None):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.list_cache = self.cache_dir / "compat-list.json"
        self.seed_path = Path(seed_path) if seed_path else None
        self.page_cache = self.cache_dir / "pages"
        self.page_cache.mkdir(parents=True, exist_ok=True)
        # What the last refresh attempt did, so a cached answer can still say
        # that the list behind it is old and why.
        self.last_error = None
        self.last_attempt = None
        # Bumped whenever a background refresh actually brought something new —
        # a changed list, or a detail page that had not been seen. It rides in
        # the revision the UI watches, so a page landing behind an answer wakes
        # the same redraw a changed list does. A refresh that brought nothing
        # must not move it, or every watch would redraw for nothing.
        self.data_version = 0
        # When each detail page last failed to download, so one the wiki will
        # not serve is not asked for again on every single question.
        self._page_failed_at = {}

    # -- the cache -------------------------------------------------------
    @staticmethod
    def _read_list_file(path):
        if not path or not path.is_file():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        entries = payload.get("entries") if isinstance(payload, dict) else None
        if not isinstance(entries, list) or not entries:
            return None
        return {"entries": entries, "fetched_at": payload.get("fetched_at") or 0}

    def cached(self):
        """The best list already on disk, without touching the network."""
        runtime = self._read_list_file(self.list_cache)
        if runtime:
            return {**runtime, "source": "cache"}
        seed = self._read_list_file(self.seed_path)
        if seed:
            # Bundled with the plugin: what a Deck that has never reached the
            # wiki gets to work from, rather than nothing at all.
            return {**seed, "source": "bundled"}
        return None

    def age(self):
        """Seconds since the cached list was fetched, or None when there is none."""
        cached = self.cached()
        if not cached or not cached["fetched_at"]:
            return None
        return max(0.0, time.time() - cached["fetched_at"])

    def is_stale(self):
        """Whether a refresh is worth starting. No cache at all counts."""
        age = self.age()
        return age is None or age >= COMPAT_CACHE_TTL

    def revision(self):
        cached = self.cached()
        return f"{fingerprint(cached['entries'])}.{self.data_version}" if cached else ""

    def _meta(self, cached):
        return {
            "source": cached["source"] if cached else "none",
            "fetched_at": cached["fetched_at"] if cached else None,
            "error": self.last_error,
            "stale": self.is_stale(),
            "revision": self.revision(),
            "tls": ssl_context_kind(),
        }

    def revalidate(self):
        """Fetch the list and replace the cache. Blocking; run off the loop.

        Nothing is written unless the download both succeeded and parsed, so a
        failed refresh can never turn a working cache into an empty one — which
        is the only way this could make things worse than not refreshing.
        """
        self.last_attempt = time.time()
        try:
            markdown = _http_get(f"{WIKI_RAW_BASE}/{COMPAT_LIST_PAGE}")
            entries = parse_compat_list(markdown)
        except Exception as exc:  # network, TLS, disk, decoding — all non-fatal
            self.last_error = f"{type(exc).__name__}: {exc}"
            return {"ok": False, "changed": False, "count": 0, "error": self.last_error}
        if not entries:
            self.last_error = "compatibility list downloaded but parsed to zero rows"
            return {"ok": False, "changed": False, "count": 0, "error": self.last_error}

        after = fingerprint(entries)
        changed = after != fingerprint((self.cached() or {}).get("entries") or [])
        try:
            self.list_cache.write_text(
                json.dumps({"fetched_at": time.time(), "entries": entries}), encoding="utf-8"
            )
        except OSError as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
            return {"ok": False, "changed": False, "count": len(entries),
                    "error": self.last_error}
        self.last_error = None
        if changed:
            self.data_version += 1
        return {"ok": True, "changed": changed, "count": len(entries),
                "revision": self.revision(), "error": None}

    def status(self, force=False):
        """Whether the compatibility list is usable, and how old it is.

        The one question the UI could never answer: a failed download and a
        game that is genuinely not on the list produced the same empty result,
        so "the wiki is broken" and "your game is not in it" read identically.
        This says which, in the words of whatever actually failed — and, now
        that answers come from cache, whether the list behind one is old.
        """
        entries, meta = self.load_entries(force)
        return {
            "url": f"{WIKI_RAW_BASE}/{COMPAT_LIST_PAGE}",
            "entry_count": len(entries),
            "available": bool(entries),
            "source": meta.get("source"),
            "fetched_at": meta.get("fetched_at"),
            "age": self.age(),
            "stale": meta.get("stale"),
            "revision": meta.get("revision"),
            "error": meta.get("error"),
            "last_attempt": self.last_attempt,
            "tls": meta.get("tls"),
            "cache_path": str(self.list_cache),
        }

    # -- compatibility list ---------------------------------------------
    def load_entries(self, force=False):
        """The entries to answer with, now.

        Never waits for the network when anything is cached: the caller is a
        question the user asked, and a Deck that is asleep, offline or on a
        network that resolves but does not route would otherwise make every one
        of them hang for the timeout. Keeping the cache current is
        `revalidate()`'s job, run behind this by the service.

        `force` is the explicit "download it again" button, and is the only
        path that puts the network in front of an answer.
        """
        if force:
            self.revalidate()
        cached = self.cached()
        if cached:
            return cached["entries"], self._meta(cached)
        # Nothing on disk at all — not even the bundled copy. One synchronous
        # attempt is better than reporting an empty list forever.
        if not force:
            self.revalidate()
            cached = self.cached()
            if cached:
                return cached["entries"], self._meta(cached)
        return [], self._meta(None)

    def _page_file(self, page):
        return self.page_cache / f"{re.sub(r'[^A-Za-z0-9._-]', '_', page)}.adoc"

    def cached_page(self, page):
        """A detail page already on disk, at whatever age. None if never seen."""
        path = self._page_file(page)
        if not path.is_file():
            return None
        try:
            return path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None

    def page_needs_fetch(self, page):
        """Whether a background fetch of this page is worth starting.

        A page the wiki will not give up used to be re-attempted on every
        recommendation — and each attempt is two URLs deep, so on a Deck that
        stalls rather than refusing, a refresh was permanently in flight. The
        UI reads "a refresh is running" as "the answer may still change", so it
        never stopped waiting for one that was never going to arrive.
        """
        if not page or not self.page_is_stale(page):
            return False
        failed_at = self._page_failed_at.get(page)
        return not (failed_at and (time.time() - failed_at) < PAGE_RETRY_AFTER)

    def page_is_stale(self, page):
        path = self._page_file(page)
        if not path.is_file():
            return True
        try:
            return (time.time() - path.stat().st_mtime) >= COMPAT_CACHE_TTL
        except OSError:
            return True

    def fetch_page(self, page):
        """Download one detail page and cache it. Blocking; run off the loop."""
        previous = self.cached_page(page)
        for suffix in (".asciidoc", ".md"):
            try:
                text = _http_get(f"{WIKI_RAW_BASE}/{page}{suffix}")
            except Exception:
                continue
            try:
                self._page_file(page).write_text(text, encoding="utf-8")
            except OSError:
                pass
            self._page_failed_at.pop(page, None)
            if text != previous:
                self.data_version += 1
            return text
        # Nothing downloaded. Anything already cached stays exactly as it was,
        # and this page is not asked for again until the cooldown is up.
        self._page_failed_at[page] = time.time()
        return None

    def load_page(self, page, force=False, allow_fetch=True):
        """A wiki detail page, from cache first for the same reason the list is.

        `allow_fetch=False` is what the recommendation paths use, and it is the
        whole point: a page that has never been downloaded used to be fetched
        **in front of the answer**, two URLs deep, the second attempt starting
        only once the first had timed out. On a Deck whose route to the wiki is
        bad that is a lookup that never returns — the setup tab sat on
        "Checking the OptiScaler wiki…" for ever, for exactly the games whose
        page had not happened to be cached already.

        The list row alone is enough to answer with; the page makes the answer
        better and arrives behind it.
        """
        cached = self.cached_page(page)
        if cached is not None and not force:
            return cached
        if not allow_fetch:
            return cached
        return self.fetch_page(page) or cached

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
        entries, meta = self.load_entries()
        result = {
            "matched": True,
            "searched": [],
            "entry_count": len(entries),
            "list_available": True,
            "near_misses": [],
            "game": entry["name"],
            "page": entry.get("page"),
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
            # True when this game has a wiki page that is not cached yet: the
            # answer below is the list row, and a better one is on its way.
            "detail_pending": bool(entry.get("page")) and self.cached_page(entry["page"]) is None,
            # The real list meta, with "manual" recorded alongside rather than
            # instead of it. Inventing one here left it with no revision, and
            # the UI's watch compares revisions: against a missing one every
            # check said "something changed", so a pinned game reloaded its own
            # plan every two seconds for ever.
            "list_meta": {**meta, "source": "manual"},
            "match_score": 1.0,
            "manual": True,
        }
        if entry.get("page"):
            asciidoc = self.load_page(entry["page"], force=force, allow_fetch=force)
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
            "page": None,
            "filename": DEFAULT_PROXY,
            "filename_source": "default",
            "alternatives": [],
            "compatibility": None,
            "inputs": None,
            "notes": None,
            "optipatcher": False,
            "wiki_url": None,
            "detail": {},
            "detail_pending": False,
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
            # The wiki page behind this answer, so whoever asked can have it
            # refreshed behind them the same way the list is.
            page=entry["page"],
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

        result["detail_pending"] = (
            bool(entry["page"]) and self.cached_page(entry["page"]) is None
        )

        # A dedicated entry states the filename explicitly; prefer it.
        if entry["page"]:
            asciidoc = self.load_page(entry["page"], force=force, allow_fetch=force)
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
