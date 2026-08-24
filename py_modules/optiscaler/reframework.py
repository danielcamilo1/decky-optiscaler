"""REFramework: the games that cannot host OptiScaler without it.

A handful of RE Engine titles — the Resident Evil games, Devil May Cry 5,
Monster Hunter Wilds, PRAGMATA — are on the compatibility list as working, and
they are, but only with `REFramework <https://github.com/praydog/REFramework>`_
already in the game folder. REF is what exposes the upscaler the game will not
expose itself; OptiScaler attaches to what REF publishes. Without it OptiScaler
loads, logs nothing wrong, and changes nothing on screen.

The wiki says all of this, in prose, in the same notes column everything else
is mined out of ("Requires REFramework to work"). Until now the plugin read
straight past it, so those games got an install that reported success and did
nothing — which is the worst outcome available, because there is no error to
go looking for.

Two builds, and they are not versions of one another:

* **the nightly** — praydog's own, now a single unified build for every game it
  supports. One asset, one file. Monster Hunter Wilds, PRAGMATA and Resident
  Evil 9 use this.
* **the pd-upscaler branch** — built per game, and needed by the entries that
  pair REF with PureDark's UpscalerBasePlugin, because that plugin does not
  support the unified nightly. Resident Evil 2/3/4/7/8 and DMC5 use this.

Which one an entry wants is read out of the entry, not guessed from the title:
the pd entries name the branch and the plugin, and the nightly ones do not.
Only the per-game *asset name* is curated (see ``REFRAMEWORK_PD_ASSETS``), for
the reason curation is ever right here — "RE2.zip" is not reachable from
"Resident Evil 2 (2019)" by any matching rule, and the wrong game's REF build
is a crash on launch rather than a worse frame rate.

Everything else in this module fails closed the way the rest of the plugin
does: an archive that does not contain what it should is refused rather than
unpacked, a game with no known asset reports that and links the release page,
and the one file that cannot be downloaded at all — UpscalerBasePlugin, which
lives behind a Nexus Mods login — is named and linked rather than pretended
about.
"""

import re
import zipfile
from pathlib import Path

from . import wiki
from .constants import (
    REFRAMEWORK_DLL,
    REFRAMEWORK_FILES,
    REFRAMEWORK_INSTALL_FILES,
    REFRAMEWORK_NIGHTLY_PAGE,
    REFRAMEWORK_NIGHTLY_URL,
    REFRAMEWORK_PD_ASSETS,
    REFRAMEWORK_PD_PAGE,
    REFRAMEWORK_PD_PLUGIN,
    REFRAMEWORK_PD_PLUGIN_NAME,
    REFRAMEWORK_PD_PLUGIN_URL,
    REFRAMEWORK_PD_RELEASES,
    REFRAMEWORK_REVISION,
)

# The Wine DLL override REFramework needs, for the same reason OptiScaler's
# proxy needs one: Proton ships its own dinput8 and loads that in preference to
# anything in the game folder. The wiki never says so — it is written for
# Windows, where the game folder wins — which makes this the one instruction in
# the whole set-up that has to come from here rather than from the entry.
REFRAMEWORK_OVERRIDE = "dinput8"

# "Requires REFramework", in the forms real entries write it. The full spelling
# is deliberate: the bare abbreviation "REF" is all over these pages in
# sentences that are not requirements at all ("XeFG disables the REF overlay",
# "REF + XeFG cause stuttering"), and a requirement is not something to infer
# from a passing mention.
REQUIRES_RE = re.compile(
    r"(?:require[sd]?|need(?:s|ed)?|only\s+works?\s+with|to\s+get\s+optiscaler\s+to\s+work\s+with)"
    r"[^.\n]{0,60}?\bre[\s\-]?framework\b"
    r"|\bre[\s\-]?framework\b[^.\n]{0,40}?\bis\s+(?:required|needed|mandatory)\b",
    re.I,
)
# An entry that has stopped needing it says so in the same sentence; taking the
# verb without reading what is in front of it would keep installing REF for a
# game that no longer wants it.
NEGATED_RE = re.compile(
    r"\b(?:no longer|not|never|doesn'?t|does not|don'?t|without)\b\s*$", re.I
)
# What marks the pd-upscaler branch rather than the nightly. Every one of these
# is a name the entry uses on purpose.
PD_MARKERS_RE = re.compile(
    r"pd[\s\-]?upscaler|pdperfplugin|upscalerbaseplugin|puredark", re.I
)


def requirement(sources, game_key=None):
    """Whether this game needs REFramework, which build, and what said so.

    ``sources`` is the ``(origin, text)`` list ``autoplan`` already builds out
    of the wiki fields — the same prose, read once. Returns None when nothing in
    the entry states a requirement, which is the ordinary case for all but a
    dozen games on the list.
    """
    for origin, text in sources:
        match = REQUIRES_RE.search(text)
        if not match:
            continue
        before = text[max(0, match.start() - 24):match.start()]
        if NEGATED_RE.search(before.rstrip()):
            continue

        # The blob that carried the statement is what classifies it, rather
        # than the whole entry: a mention of PDPerfPlugin three fields away is
        # not this sentence saying which branch to install.
        pd = bool(PD_MARKERS_RE.search(text))
        sentence = text[match.start():match.start() + 200].strip()
        return _describe(pd, game_key, origin, sentence)
    return None


def _describe(pd, game_key, origin, detail):
    """One requirement, with the download it resolves to — or why it does not."""
    found = {
        "required": True,
        "variant": "pd-upscaler" if pd else "nightly",
        "dll": REFRAMEWORK_DLL,
        "override": REFRAMEWORK_OVERRIDE,
        "source": origin,
        "detail": detail,
        "asset": None,
        "url": None,
        "page": REFRAMEWORK_PD_PAGE if pd else REFRAMEWORK_NIGHTLY_PAGE,
        # UpscalerBasePlugin is Nexus-hosted and needs a logged-in browser, so
        # no amount of work here downloads it. The pd entries do not work
        # without it, and saying so is the only honest thing available.
        "plugin": REFRAMEWORK_PD_PLUGIN if pd else None,
        "plugin_name": REFRAMEWORK_PD_PLUGIN_NAME if pd else None,
        "plugin_url": REFRAMEWORK_PD_PLUGIN_URL if pd else None,
        "automatic": False,
        "reason": None,
    }
    if not pd:
        found.update(asset="REFramework.zip", url=REFRAMEWORK_NIGHTLY_URL, automatic=True)
        return found

    asset = REFRAMEWORK_PD_ASSETS.get(game_key or "")
    if asset:
        # The pd builds have no "latest" URL — the release has to be looked up
        # when the download actually happens, so only the asset name is settled
        # here.
        found.update(asset=asset, automatic=True)
    else:
        found["reason"] = (
            "no REFramework build is known for this game, so it has to be "
            "downloaded by hand"
        )
    return found


def status(target_dir, wanted=None, revision=None):
    """What is actually sitting next to the game's executable right now.

    ``revision`` comes from our manifest rather than the folder: the build stamp
    is deliberately not installed, so the only record of which build went in is
    the one we kept.
    """
    target = Path(target_dir)
    dll = target / REFRAMEWORK_DLL
    plugin_name = (wanted or {}).get("plugin")
    plugin = target / plugin_name if plugin_name else None
    return {
        "required": bool(wanted and wanted.get("required")),
        "installed": dll.is_file(),
        "dll": REFRAMEWORK_DLL,
        "path": str(dll),
        "revision": revision,
        "plugin": plugin_name,
        "plugin_installed": bool(plugin and plugin.is_file()),
        "plugin_url": (wanted or {}).get("plugin_url"),
        "plugin_name": (wanted or {}).get("plugin_name"),
        # The pd games do not upscale at all without it, so "REFramework is in
        # and OptiScaler is in" is not the same as "this game will do anything".
        "complete": dll.is_file() and (not plugin_name or bool(plugin and plugin.is_file())),
    }


def resolve_pd_url(asset, logger=None):
    """The download URL for one per-game pd-upscaler asset.

    There is no stable "latest" link for these — they are attached to dated
    pre-releases — so the release list is asked, and the newest release that
    carries this exact asset name wins. Exact: a build for another game is not a
    near-enough answer to fall back to.
    """
    releases = wiki.download_json(REFRAMEWORK_PD_RELEASES)
    if not isinstance(releases, list):
        raise ValueError("unexpected response from the REFramework release list")
    for release in releases:
        for item in release.get("assets") or []:
            if item.get("name") == asset and item.get("browser_download_url"):
                if logger:
                    logger.info("REFramework %s from %s", asset, release.get("tag_name"))
                return item["browser_download_url"]
    raise FileNotFoundError(f"no {asset} in any REFramework pd-upscaler release")


def fetch(wanted, cache_dir, logger=None):
    """Download and unpack one REFramework build; returns the files to install.

    The archive is kept, so setting up a second Resident Evil game is a copy
    rather than a second 13 MB download on a handheld's connection.
    """
    if not wanted or not wanted.get("automatic"):
        raise ValueError(wanted.get("reason") if wanted else "no REFramework requirement")

    asset = wanted["asset"]
    cache = Path(cache_dir) / wanted["variant"]
    unpacked = cache / Path(asset).stem
    existing = _unpacked_files(unpacked)
    if existing:
        return existing

    url = wanted.get("url") or resolve_pd_url(asset, logger)
    archive = cache / asset
    if logger:
        logger.info("downloading REFramework: %s", url)
    wiki.download(url, archive)
    try:
        _extract(archive, unpacked)
    except Exception:
        # A truncated or wrong-shaped archive must not sit in the cache being
        # trusted by every later run.
        archive.unlink(missing_ok=True)
        raise
    files = _unpacked_files(unpacked)
    if not files:
        raise ValueError(f"{asset} did not contain {REFRAMEWORK_DLL}")
    return files


def _extract(archive, dest):
    """Unpack only the files an REFramework archive is supposed to contain.

    Deliberately not "extract the zip": this runs against a folder full of
    somebody's game, and a member path is attacker-controlled input as far as
    this code is concerned. Names are matched exactly, flattened, and anything
    else in the archive is left in it.
    """
    dest.mkdir(parents=True, exist_ok=True)
    wanted = {name.lower(): name for name in REFRAMEWORK_FILES}
    taken = []
    with zipfile.ZipFile(archive) as zf:
        for member in zf.infolist():
            if member.is_dir():
                continue
            name = wanted.get(Path(member.filename).name.lower())
            if not name or name in taken:
                continue
            with zf.open(member) as src, open(dest / name, "wb") as out:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            taken.append(name)
    if REFRAMEWORK_DLL not in taken:
        raise ValueError(f"{archive.name} contains no {REFRAMEWORK_DLL}")
    return taken


def _unpacked_files(unpacked):
    """The files to install for one cached build, or [] when the DLL is absent.

    Only the DLL: the revision stamp is unpacked beside it in the cache and read
    from there, because the nightly's release notes ask for nothing else to be
    put in the game folder.
    """
    if not (unpacked / REFRAMEWORK_DLL).is_file():
        return []
    return [unpacked / name for name in REFRAMEWORK_INSTALL_FILES
            if (unpacked / name).is_file()]


def revision_of(files):
    """The build stamp beside a fetched DLL, for the manifest and the UI."""
    for path in files:
        stamp = Path(path).parent / REFRAMEWORK_REVISION
        if stamp.is_file():
            try:
                return stamp.read_text(encoding="utf-8", errors="replace").strip()[:80]
            except OSError:
                return None
    return None
