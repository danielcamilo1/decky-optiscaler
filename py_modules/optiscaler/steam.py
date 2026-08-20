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
