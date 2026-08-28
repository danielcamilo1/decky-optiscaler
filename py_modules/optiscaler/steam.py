"""Discovery of Steam library folders and the games installed in them."""

import os
import re
import zlib
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


def _shortcut_files(home):
    """Every account's shortcuts.vdf on this machine, newest first."""
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
            path = entry / "config" / "shortcuts.vdf"
            if not path.is_file():
                continue
            try:
                found.append((path.stat().st_mtime, path))
            except OSError:
                continue
    found.sort(key=lambda pair: -pair[0])
    return [path for _, path in found]


def parse_binary_vdf(data):
    """Valve's binary KeyValues, as the nested dict it encodes.

    ``shortcuts.vdf`` is the only file this plugin reads in this format, and it
    is not the text one everything else here uses. Four byte markers matter: a
    nested map opens with 0x00, a string is 0x01, a 32-bit int is 0x02, and
    0x08 closes the map. Keys are NUL-terminated and their capitalisation is
    not stable across client versions, so every key is lowercased on the way
    in and looked up that way.
    """
    pos = 0
    end = len(data)

    def read_cstring():
        nonlocal pos
        stop = data.find(b"\x00", pos)
        if stop < 0:
            raise ValueError("unterminated string in binary VDF")
        raw = data[pos:stop]
        pos = stop + 1
        return raw.decode("utf-8", errors="replace")

    def read_map():
        nonlocal pos
        out = {}
        while pos < end:
            marker = data[pos]
            pos += 1
            if marker == 0x08:
                return out
            key = read_cstring().lower()
            if marker == 0x00:
                out[key] = read_map()
            elif marker == 0x01:
                out[key] = read_cstring()
            elif marker == 0x02:
                if pos + 4 > end:
                    raise ValueError("truncated int in binary VDF")
                out[key] = int.from_bytes(data[pos:pos + 4], "little", signed=True)
                pos += 4
            else:
                # 0x03 (int64), 0x07 (uint64) and the colour/pointer types do
                # not appear in shortcuts.vdf. Refusing is right: guessing a
                # width here would desynchronise every field after it.
                raise ValueError(f"unsupported binary VDF type {marker:#x}")
        return out

    return read_map()


def _shortcut_appid(entry):
    """The app id Steam's own UI uses for one shortcut.

    Stored as a signed 32-bit int and used unsigned everywhere else, so the two
    disagree for every shortcut Steam has ever created — they all have the top
    bit set. Very old entries have no ``appid`` field at all; theirs is derived
    from the target and the name the same way Steam derived it.
    """
    value = entry.get("appid")
    if isinstance(value, int):
        return str(value & 0xFFFFFFFF)
    exe = entry.get("exe") or entry.get("executable") or ""
    name = entry.get("appname") or ""
    if not exe:
        return None
    crc = zlib.crc32((exe + name).encode("utf-8")) & 0xFFFFFFFF
    return str(crc | 0x80000000)


def _unquote(value):
    """Strip the quotes Steam wraps a shortcut's target in."""
    return (value or "").strip().strip('"').strip()


def shortcut_folder(exe, start_dir=None):
    """The folder to manage OptiScaler in, for a target this plugin was given.

    A non-Steam shortcut has no app manifest and therefore no install
    directory: Steam knows only what to run. The folder holding that executable
    *is* the install folder — it is where the renderer lives, which is the only
    thing OptiScaler cares about — so that is what this returns, and the
    shortcut's start directory is only a fallback for a target that is a
    launcher script somewhere else. Neither is trusted without looking: a
    shortcut can name a path that no longer exists, or one inside a Proton
    prefix this plugin cannot see.
    """
    exe = _unquote(exe)
    start_dir = _unquote(start_dir)
    if exe:
        target = Path(exe)
        try:
            if target.is_file():
                return str(target.parent.resolve())
            if target.is_dir():
                return str(target.resolve())
        except OSError:
            pass
    if start_dir:
        try:
            folder = Path(start_dir)
            if folder.is_dir():
                return str(folder.resolve())
        except OSError:
            pass
    return None


def shortcut_entry(home, appid):
    """One shortcut as Steam recorded it, with the file it came out of.

    Steam's own record on disk, which is what makes any of this work when the
    client will not answer — the same reason ``launch_options`` reads
    ``localconfig.vdf``. It lags, though: a shortcut added this session may not
    have been flushed yet, which is why callers ask the client first.
    """
    appid = str(appid)
    for path in _shortcut_files(home):
        try:
            data = parse_binary_vdf(path.read_bytes())
        except (OSError, ValueError):
            continue
        entries = data.get("shortcuts")
        if not isinstance(entries, dict):
            continue
        for entry in entries.values():
            if isinstance(entry, dict) and _shortcut_appid(entry) == appid:
                return entry, path
    return None, None


def find_shortcut_by_appid(home, appid):
    """Locate a non-Steam game by the app id its library entry uses."""
    entry, _ = shortcut_entry(home, appid)
    if not entry:
        return None
    folder = shortcut_folder(entry.get("exe"), entry.get("startdir"))
    if not folder:
        return None
    return {
        "appid": str(appid),
        "name": entry.get("appname") or Path(folder).name,
        "path": folder,
        "source": "shortcut",
        "size_on_disk": 0,
        "library": str(Path(folder).parent),
    }


def _is_shortcut_appid(appid):
    """Whether an id belongs to a non-Steam shortcut rather than a Steam app.

    Steam derives every shortcut id with the top bit set, and no real app id
    comes anywhere near that, so the range is the distinction — there is no
    flag to read and nothing to look up first.
    """
    try:
        return int(appid) >= 0x80000000
    except (TypeError, ValueError):
        return False


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
    # A non-Steam shortcut keeps its launch options in shortcuts.vdf, not in
    # localconfig.vdf — where it has no entry at all. Reading the wrong file
    # would answer "this game has none", which is the state that lets removal
    # clear the field outright, so a shortcut with a wrapper command in it
    # would have had that wrapper deleted.
    if _is_shortcut_appid(appid):
        entry, path = shortcut_entry(home, appid)
        if entry is not None:
            value = entry.get("launchoptions")
            return {"found": True, "value": value if isinstance(value, str) else "",
                    "source": str(path)}
        return {"found": False, "value": "", "source": None}

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


def find_by_appid(home, appid, exe=None, start_dir=None, name=None):
    """Locate a game by the app id its library entry uses.

    Two kinds of entry, and only one of them has an app manifest. A Steam game
    is found the usual way. A **non-Steam shortcut** has no manifest, no
    ``steamapps/common`` folder and no install directory anywhere in Steam's
    records — the client knows what to run and nothing else — so its folder is
    derived from that target instead: the executable the shortcut points at
    lives in the folder OptiScaler has to go into.

    ``exe``/``start_dir``/``name`` are what the client said, passed down by the
    frontend when it could read them. They are tried before ``shortcuts.vdf`` for the
    reason the launch-options read tries the client first: the file is flushed
    on Steam's schedule and a shortcut added this session may not be in it yet.
    """
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

    folder = shortcut_folder(exe, start_dir)
    if folder:
        return {
            "appid": appid,
            "name": name or Path(folder).name,
            "path": folder,
            "source": "shortcut",
            "size_on_disk": 0,
            "library": str(Path(folder).parent),
        }
    return find_shortcut_by_appid(home, appid)
