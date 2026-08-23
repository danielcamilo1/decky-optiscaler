"""Discovery of Steam library folders and the games installed in them."""

import os
import re
from pathlib import Path

from .constants import EXE_DIR_BLACKLIST, EXE_NAME_BLACKLIST, STEAM_ROOTS

# Matches `"key"   "value"` pairs in Valve's KeyValues text format.
KV_RE = re.compile(r'"([^"]+)"\s+"([^"]*)"')


def _read_kv(path):
    """Flat parse of a KeyValues file into a list of (key, value) pairs."""
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return KV_RE.findall(text)


def steam_roots(home):
    """Every plausible Steam installation root on this machine."""
    found = []
    for rel in STEAM_ROOTS:
        candidate = Path(home) / rel
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if (resolved / "steamapps").is_dir() and resolved not in found:
            found.append(resolved)
    return found


def library_folders(home):
    """Return Steam library paths, from libraryfolders.vdf plus the roots."""
    libraries = []

    def add(path):
        try:
            p = Path(path).resolve()
        except (OSError, ValueError):
            return
        if (p / "steamapps").is_dir() and p not in libraries:
            libraries.append(p)

    for root in steam_roots(home):
        add(root)
        for vdf in (root / "steamapps" / "libraryfolders.vdf",
                    root / "config" / "libraryfolders.vdf"):
            if not vdf.is_file():
                continue
            for key, value in _read_kv(vdf):
                if key == "path" and value:
                    add(value)
    return libraries


# --- Steam's own record of launch options -----------------------------------
#
# `SteamClient.Apps.GetAppLaunchOptions` is undocumented and simply absent from
# some client builds, which is not a rare edge: on a Deck where it is missing,
# every launch-options question the plugin asks answers itself with "cannot
# tell" and every action it would take turns into nothing at all. Steam writes
# the same value to disk, so it is read from there when the client will not say.
#
# Tokens, in order: a quoted string, a brace, or a comment to skip. Whitespace
# between them needs no rule, because `finditer` walks past whatever does not
# match.
_VDF_TOKEN = re.compile(r'"((?:[^"\\]|\\.)*)"|([{}])|//[^\n]*')


def parse_vdf(text):
    """Valve's KeyValues text as nested dicts, with keys folded to lower case.

    Case folding is not cosmetic: the path to the launch options is spelled
    `Software/Valve/Steam/apps` in some client versions and `software/valve/
    steam/apps` in others, and a lookup that guesses wrong reads as "this user
    has no games".
    """
    root = {}
    stack = [root]
    key = None
    for match in _VDF_TOKEN.finditer(text):
        string, brace = match.group(1), match.group(2)
        if string is not None:
            value = string.replace('\\"', '"').replace("\\\\", "\\")
            if key is None:
                key = value
            else:
                stack[-1][key.lower()] = value
                key = None
        elif brace == "{":
            child = {}
            stack[-1][(key or "").lower()] = child
            stack.append(child)
            key = None
        elif brace == "}":
            if len(stack) > 1:
                stack.pop()
            key = None
    return root


def _local_configs(home):
    """Every Steam account's localconfig.vdf on this machine, newest first."""
    found = []
    for root in steam_roots(home):
        userdata = root / "userdata"
        if not userdata.is_dir():
            continue
        try:
            entries = sorted(userdata.iterdir())
        except OSError:
            continue
        for entry in entries:
            config = entry / "config" / "localconfig.vdf"
            if not config.is_file():
                continue
            try:
                found.append((config.stat().st_mtime, config))
            except OSError:
                continue
    found.sort(key=lambda pair: -pair[0])
    return [config for _, config in found]


def launch_options(home, appid):
    """What Steam passes this game, read out of its own config.

    ``found`` is the part that matters: an app with no entry in a file we could
    read genuinely has no launch options, and that is a different answer from
    not being able to read anything, which is the one case where this plugin
    must not touch the field. The account that actually has an entry for the
    app wins over the merely most recent one, because a machine with two Steam
    logins has two of these files and only one of them owns the game.
    """
    appid = str(appid)
    fallback = None
    for config in _local_configs(home):
        try:
            data = parse_vdf(config.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        apps = data
        for step in ("userlocalconfigstore", "software", "valve", "steam", "apps"):
            apps = apps.get(step) if isinstance(apps, dict) else None
            if apps is None:
                break
        if not isinstance(apps, dict):
            continue
        entry = apps.get(appid)
        if isinstance(entry, dict) and isinstance(entry.get("launchoptions"), str):
            return {"found": True, "value": entry["launchoptions"], "source": str(config)}
        if fallback is None:
            fallback = str(config)
    if fallback:
        # The file was readable and this game is not in it: Steam is passing
        # nothing, which is an answer rather than a gap.
        return {"found": True, "value": "", "source": fallback}
    return {"found": False, "value": "", "source": None}


def _parse_appmanifest(path):
    data = dict(_read_kv(path))
    appid = data.get("appid")
    name = data.get("name")
    installdir = data.get("installdir")
    if not (appid and installdir):
        return None
    try:
        size = int(data.get("SizeOnDisk") or 0)
    except ValueError:
        size = 0
    return {
        "appid": str(appid),
        "name": name or installdir,
        "installdir": installdir,
        "size_on_disk": size,
    }


def steam_games(library_path):
    """List installed games in a Steam library folder."""
    steamapps = Path(library_path) / "steamapps"
    common = steamapps / "common"
    games = []
    if not steamapps.is_dir():
        return games
    for manifest in sorted(steamapps.glob("appmanifest_*.acf")):
        info = _parse_appmanifest(manifest)
        if not info:
            continue
        game_dir = common / info["installdir"]
        if not game_dir.is_dir():
            continue
        # Steam's own runtimes/redistributables are not games.
        if info["appid"] in ("228980",) or info["name"].startswith("Steamworks Common"):
            continue
        if "Proton" in info["name"] or "Steam Linux Runtime" in info["name"]:
            continue
        games.append(
            {
                "appid": info["appid"],
                "name": info["name"],
                "path": str(game_dir),
                "source": "steam",
                "size_on_disk": info["size_on_disk"],
            }
        )
    games.sort(key=lambda g: g["name"].lower())
    return games


def folder_games(folder_path):
    """Treat each immediate subdirectory of a custom folder as a game."""
    root = Path(folder_path)
    games = []
    if not root.is_dir():
        return games
    try:
        entries = sorted(root.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return games
    for entry in entries:
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        games.append(
            {
                "appid": None,
                "name": entry.name,
                "path": str(entry),
                "source": "custom",
                "size_on_disk": 0,
            }
        )
    return games


def _normalize_name(text):
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _score_exe(exe, game_root):
    """Rank a candidate executable; higher is a more likely render target."""
    rel = exe.relative_to(game_root)
    parts = [p.lower() for p in rel.parts[:-1]]
    name = exe.name.lower()
    score = 0.0

    if name in EXE_NAME_BLACKLIST:
        return -1000.0
    if any(p in EXE_DIR_BLACKLIST for p in parts):
        # Engine/Binaries/Win64 is the Unreal *engine* folder, never the game.
        return -1000.0

    # Unreal: <Project>/Binaries/Win64/<Project>-Win64-Shipping.exe
    if "binaries" in parts and ("win64" in parts or "win32" in parts):
        score += 100
        if name.endswith("-win64-shipping.exe"):
            score += 50
    # Executables sitting at the game root are the common case.
    if len(rel.parts) == 1:
        score += 30
    else:
        score -= 5 * (len(rel.parts) - 1)

    # An executable named after the game itself is a strong signal, and is how
    # titles like Cyberpunk 2077 hide their real binary under a launcher.
    stem = _normalize_name(exe.stem)
    folder = _normalize_name(game_root.name)
    if stem and folder and (stem == folder or stem.startswith(folder) or folder.startswith(stem)):
        score += 45

    if "shipping" in name:
        score += 10
    if any(word in name for word in ("launcher", "prelauncher", "setup", "config", "editor",
                                     "server", "benchmark", "crash", "helper", "unins")):
        score -= 70
    if any(word in parts for word in ("bin", "binaries", "win64", "x64", "retail", "game")):
        score += 15

    try:
        score += min(exe.stat().st_size / (16 * 1024 * 1024), 20)
    except OSError:
        pass
    return score


def find_exe_dirs(game_path, max_depth=6, limit=40):
    """Return candidate install directories, best first.

    OptiScaler must sit next to the executable that creates the D3D device,
    which for Unreal titles is several levels below the Steam install dir.
    """
    root = Path(game_path)
    if not root.is_dir():
        return []

    candidates = {}
    root_depth = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root):
        current = Path(dirpath)
        depth = len(current.parts) - root_depth
        if depth >= max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for filename in filenames:
            if not filename.lower().endswith(".exe"):
                continue
            exe = current / filename
            score = _score_exe(exe, root)
            if score <= -100:
                continue
            entry = candidates.setdefault(
                str(current), {"path": str(current), "score": score, "executables": []}
            )
            entry["score"] = max(entry["score"], score)
            if len(entry["executables"]) < 12:
                entry["executables"].append(filename)

    ordered = sorted(candidates.values(), key=lambda c: -c["score"])[:limit]
    for entry in ordered:
        entry["relative"] = os.path.relpath(entry["path"], str(root))
        entry["executables"].sort()
    return ordered


def find_by_appid(home, appid):
    """Locate an installed Steam game by its app id."""
    appid = str(appid)
    for library in library_folders(home):
        manifest = Path(library) / "steamapps" / f"appmanifest_{appid}.acf"
        if not manifest.is_file():
            continue
        info = _parse_appmanifest(manifest)
        if not info:
            continue
        game_dir = Path(library) / "steamapps" / "common" / info["installdir"]
        if not game_dir.is_dir():
            continue
        return {
            "appid": info["appid"],
            "name": info["name"],
            "path": str(game_dir),
            "source": "steam",
            "size_on_disk": info["size_on_disk"],
            "library": str(library),
        }
    return None
