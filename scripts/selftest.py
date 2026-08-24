#!/usr/bin/env python3
"""End-to-end backend test against a synthetic Steam library in a temp dir.

Exercises library discovery, executable-folder scoring, the wiki lookup (needs
network; skipped gracefully offline), install/detect/uninstall round trips and
comment-preserving INI edits.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py_modules"))

from optiscaler.service import OptiScalerService  # noqa: E402
from optiscaler import installer  # noqa: E402
from optiscaler.inifile import IniFile  # noqa: E402
from optiscaler.constants import COMPAT_CACHE_TTL, INI_NAME  # noqa: E402

PASSED = []
FAILED = []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    mark = "ok  " if condition else "FAIL"
    print(f"  [{mark}] {name}{(' — ' + str(detail)) if detail else ''}")


def build_fixture(root):
    """A Steam install with two libraries and two differently-shaped games."""
    home = root / "home"
    steam = home / ".local" / "share" / "Steam"
    lib2 = root / "sdcard"
    (steam / "steamapps" / "common").mkdir(parents=True)
    (lib2 / "steamapps" / "common").mkdir(parents=True)
    (home / ".steam").mkdir(parents=True, exist_ok=True)
    os.symlink(steam, home / ".steam" / "steam")

    (steam / "steamapps" / "libraryfolders.vdf").write_text(
        '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"%s"\n\t}\n'
        '\t"1"\n\t{\n\t\t"path"\t\t"%s"\n\t}\n}\n' % (steam, lib2)
    )
    (steam / "steamapps" / "appmanifest_1091500.acf").write_text(
        '"AppState"\n{\n\t"appid"\t\t"1091500"\n\t"name"\t\t"Cyberpunk 2077"\n'
        '\t"installdir"\t\t"Cyberpunk 2077"\n\t"SizeOnDisk"\t\t"73819938816"\n}\n'
    )
    (steam / "steamapps" / "appmanifest_228980.acf").write_text(
        '"AppState"\n{\n\t"appid"\t\t"228980"\n\t"name"\t\t"Steamworks Common Redistributables"\n'
        '\t"installdir"\t\t"Steamworks Shared"\n}\n'
    )
    (lib2 / "steamapps" / "appmanifest_2358720.acf").write_text(
        '"AppState"\n{\n\t"appid"\t\t"2358720"\n\t"name"\t\t"Black Myth Wukong"\n'
        '\t"installdir"\t\t"BlackMythWukong"\n\t"SizeOnDisk"\t\t"1"\n}\n'
    )

    # Cyberpunk: launcher at the root, real binary under bin/x64.
    cp = steam / "steamapps" / "common" / "Cyberpunk 2077"
    (cp / "bin" / "x64").mkdir(parents=True)
    (cp / "REDprelauncher.exe").write_bytes(b"MZ")
    (cp / "bin" / "x64" / "Cyberpunk2077.exe").write_bytes(b"MZ" + b"\0" * (60 << 20))
    (steam / "steamapps" / "common" / "Steamworks Shared").mkdir(parents=True)

    # Unreal: real binary under <Project>/Binaries/Win64, Engine/ must be ignored.
    bmw = lib2 / "steamapps" / "common" / "BlackMythWukong"
    (bmw / "Engine" / "Binaries" / "Win64").mkdir(parents=True)
    (bmw / "b1" / "Binaries" / "Win64").mkdir(parents=True)
    (bmw / "Engine" / "Binaries" / "Win64" / "UnrealEditor.exe").write_bytes(b"MZ")
    (bmw / "b1" / "Binaries" / "Win64" / "b1-Win64-Shipping.exe").write_bytes(b"MZ" + b"\0" * (80 << 20))
    (bmw / "b1" / "Binaries" / "Win64" / "CrashReportClient.exe").write_bytes(b"MZ")
    return home


async def run():
    root = Path(tempfile.mkdtemp(prefix="decky-optiscaler-selftest-"))
    try:
        home = build_fixture(root)
        service = OptiScalerService(
            ROOT, root / "settings", root / "runtime", home, logging.getLogger("selftest")
        )

        print("\nPayload")
        status = await service.get_status()
        check("bundled archive present", status["archive_present"], status["archive_path"])
        check("an extractor is available", bool(status["extractor"]), status["extractor"])
        if not status["extractor"]:
            print("  (no 7z/bsdtar — skipping install tests)")
            return

        print("\nLibraries and games")
        libraries = await service.list_libraries()
        check("two steam libraries found", len(libraries) == 2, [l["name"] for l in libraries])
        added = await service.add_custom_library(str(root / "sdcard" / "steamapps" / "common"))
        check("custom library added", added["ok"])
        check("duplicate library rejected",
              not (await service.add_custom_library(str(root / "sdcard" / "steamapps" / "common")))["ok"])
        libraries = await service.list_libraries()
        check("custom library listed", any(l["source"] == "custom" for l in libraries))

        games = await service.list_games(libraries[0]["path"])
        names = [g["name"] for g in games]
        check("game listed", "Cyberpunk 2077" in names, names)
        check("redistributables filtered out",
              not any("Steamworks" in n for n in names), names)

        print("\nInstall target detection")
        cyberpunk = next(g for g in games if g["name"] == "Cyberpunk 2077")
        detail = await service.get_game(cyberpunk["path"], cyberpunk["name"])
        check("launcher folder rejected in favour of bin/x64",
              detail["target"].endswith("bin/x64"), detail["target"])
        wukong = await service.get_game(
            str(root / "sdcard" / "steamapps" / "common" / "BlackMythWukong"), "Black Myth Wukong"
        )
        check("unreal project binaries chosen over Engine/",
              wukong["target"].endswith("b1/Binaries/Win64"), wukong["target"])

        print("\nWiki name matching")
        from optiscaler.wiki import WikiClient  # noqa: E402
        wiki = WikiClient(root / "runtime" / "wiki-cache")
        wiki_entries, wiki_meta = wiki.load_entries()
        if not wiki_entries:
            print("  (offline — skipped)")
        else:
            expected = {
                "Expedition 33": "Clair Obscur: Expedition 33",
                "Cyberpunk 2077": "Cyberpunk 2077",
                "BlackMythWukong": "Black Myth: Wukong",
                "Talos Principle 2": "The Talos Principle 2",
                "Oblivion Remastered": "The Elder Scrolls IV: Oblivion Remastered",
            }
            for probe, want in expected.items():
                hit = wiki.match(probe, wiki_entries)
                check(f"matches {probe!r}", hit is not None and hit["name"] == want,
                      hit["name"] if hit else "no match")
            for probe in ("Balatro", "Stardew Valley", "Totally Made Up Game 9000"):
                check(f"no false positive for {probe!r}",
                      wiki.match(probe, wiki_entries) is None)

        print("\nWiki lookup")
        recommendation = await service.get_recommendation("Cyberpunk 2077")
        if recommendation["list_meta"]["error"] and not recommendation["matched"]:
            print("  (offline — skipped)")
        else:
            check("matched the compatibility list", recommendation["matched"], recommendation["game"])
            # The answer is two-phase now. The compatibility-list row answers
            # at once, and this game's own wiki page — which is what states the
            # filename outright — arrives behind it. Fetching it in front of
            # the answer is what made the setup tab hang for ever on a Deck
            # whose route to the wiki stalls.
            check("the first answer says its wiki page is still coming",
                  recommendation["detail_pending"] is True
                  or recommendation["filename_source"] == "wiki entry",
                  f"pending={recommendation['detail_pending']} "
                  f"via {recommendation['filename_source']}")
            for _ in range(200):
                await asyncio.sleep(0.05)
                if not service._wiki_jobs:
                    break
            settled = await service.get_recommendation("Cyberpunk 2077")
            check("and once it lands the filename comes from that entry",
                  settled["filename_source"] == "wiki entry"
                  and not settled["detail_pending"],
                  f"{settled['filename']} via {settled['filename_source']}")

        print("\nSchema generation")
        from optiscaler.schema_generated import OPTIONS  # noqa: E402
        by_id = {(o["section"], o["key"]): o for o in OPTIONS}
        multiplier = by_id[("XeFG", "InterpolationCount")]
        check("frame multiplier is a 2X/3X/4X choice, not a toggle",
              multiplier["type"] == "enum" and multiplier["options"] == ["1", "2", "3"],
              f"{multiplier['type']} {multiplier.get('options')}")
        check("multiplier labelled 2X/3X/4X",
              multiplier.get("optionLabels") == {"1": "2X", "2": "3X", "3": "4X"})
        dx12 = by_id[("Upscalers", "Dx12Upscaler")]
        check("fsr31 documented as also serving FSR4",
              "FSR4" in (dx12.get("optionLabels") or {}).get("fsr31", ""),
              (dx12.get("optionLabels") or {}).get("fsr31"))

        print("\nInstall / uninstall round trip")
        target = Path(detail["target"])
        original = b"THE GAME'S OWN DXGI" * 8
        (target / "dxgi.dll").write_bytes(original)
        # Games that ship their own FidelityFX DLLs must get them back intact.
        game_upscaler = b"GAME'S OWN FSR31 UPSCALER" * 8
        (target / "amd_fidelityfx_upscaler_dx12.dll").write_bytes(game_upscaler)
        (target / "Licenses").mkdir(exist_ok=True)
        (target / "Licenses" / "game.txt").write_text("GAME LICENSE")

        result = await service.install(str(target), "dxgi.dll")
        check("install succeeded", result["ok"], result.get("error"))
        check("launch option built",
              result.get("launch_option") == 'WINEDLLOVERRIDES="dxgi=n,b" %command%',
              result.get("launch_option"))
        check("original dll backed up", "dxgi.dll" in (result.get("backups") or {}))
        stash = target / "decky_optiscaler_backup_files"
        check("backup folder created", stash.is_dir(), stash.name)
        check("game's own FidelityFX dll set aside",
              (stash / "amd_fidelityfx_upscaler_dx12.dll").is_file())
        check("game's own Licenses folder set aside", (stash / "Licenses").is_dir())
        check("OptiScaler's FidelityFX dll actually replaced it",
              (target / "amd_fidelityfx_upscaler_dx12.dll").read_bytes() != game_upscaler)

        info = installer.detect(str(target))
        check("install detected", info["installed"] and info["filename"] == "dxgi.dll")

        # The launch options are Steam's, so only the frontend can read them --
        # but they are the other half of an install and have to be recoverable.
        recorded = await service.record_launch_options(str(target), "gamemoderun %command%")
        check("previous launch options recorded", recorded["ok"] and recorded["written"])
        # The client getter is absent from some builds; the frontend then hands
        # over None and Steam's own config has to answer instead. Recording
        # nothing is what made the removal dialog inert on those Decks.
        blind = await service.record_launch_options(str(root / "nowhere"), None, "1091500")
        check("a frontend that could not read is refused, not recorded as empty",
              not blind["ok"] and not blind["recorded"], blind.get("error"))
        again = await service.record_launch_options(
            str(target), 'WINEDLLOVERRIDES="dxgi=n,b" %command%')
        check("recording again keeps the original, not our own override",
              not again["written"] and again["value"] == "gamemoderun %command%",
              again["value"])
        check("the record travels with the install detail",
              installer.detect(str(target))["launch_record"]
              == {"recorded": True, "value": "gamemoderun %command%"})

        # Live control has to arrive with the install, and OptiScaler has to be
        # told to load it -- an .asi it never looks for would do nothing.
        from optiscaler import live as live_mod
        asi_shipped = (ROOT / "bin" / live_mod.ASI_NAME).is_file()
        if asi_shipped:
            check("live-control asi installed alongside OptiScaler",
                  (target / "plugins" / live_mod.ASI_NAME).is_file())
            ini_after = IniFile(target / "OptiScaler.ini").to_dict()
            check("OptiScaler told to load asi plugins",
                  ini_after.get("Plugins", {}).get("LoadAsiPlugins") == "true",
                  ini_after.get("Plugins"))
            check("install reports whether asi loading was switched on",
                  result.get("asi_loading_enabled") is True,
                  result.get("asi_loading_error"))
            # Path is deliberately left at auto: OptiScaler resolves that to
            # <dll folder>/plugins, whereas a relative "plugins" would be read
            # against the game's working directory instead.
            check("asi plugin path is left for OptiScaler to resolve",
                  ini_after.get("Plugins", {}).get("Path") in (None, "auto"),
                  ini_after.get("Plugins", {}).get("Path"))
        else:
            print("  [skip] live-control asi not built (run asi/build.sh)")
        check("recognised as plugin-managed", info["managed"])
        check("OptiScaler.ini written", info["ini_present"])

        print("\nSwitching filename")
        switched = await service.install(str(target), "winmm.dll")
        check("switch succeeded", switched["ok"])
        check("now installed as winmm.dll",
              installer.detect(str(target))["filename"] == "winmm.dll")
        check("original dxgi.dll restored on switch",
              (target / "dxgi.dll").read_bytes() == original)

        print("\nInstall verification / FSR4")
        verified = await service.verify_install(str(target))
        check("every bundled file landed in the game folder",
              verified["ok"] and verified["complete"], verified.get("problems"))
        ffx = verified["ffx_upscaler"]
        check("FidelityFX upscaler present with a readable version",
              ffx["present"] and ffx["version"], ffx)
        check("bundled FidelityFX provides FSR4 (>= 4.1.1)",
              ffx["fsr4_capable"], ffx["version"])

        source = root / "fsr4src"
        source.mkdir()
        (source / "amdxcffx64.dll").write_bytes(b"AMDXCFFX64" * 64)
        (source / "amdxc64.dll").write_bytes(b"AMDXC64" * 64)
        imported = await service.import_fsr4_files(str(target), str(source))
        check("optional driver FSR4 dlls imported", imported["ok"], imported.get("imported"))
        check("driver FSR4 dlls detected after import",
              installer.fsr4_status(str(target))["ready"])

        print("\nConfiguration")
        config = await service.read_config(str(target))
        check("ini parsed", config["ok"] and len(config["values"]) == 34, len(config["values"]))
        before = (target / "OptiScaler.ini").read_text(encoding="utf-8")

        write = await service.write_config(str(target), [
            {"section": "FrameGen", "key": "Enabled", "value": "true"},
            {"section": "FrameGen", "key": "FGInput", "value": "fsrfg"},
            {"section": "Upscalers", "key": "Dx12Upscaler", "value": "fsr31"},
            {"section": "FrameGen", "key": "FGOutput", "value": "NOT_A_VALUE"},
            {"section": "Sharpness", "key": "Sharpness", "value": "9.9"},
        ])
        check("valid changes applied", len(write["applied"]) == 3, write["applied"])
        check("invalid enum rejected",
              any(r["key"] == "FGOutput" for r in write["rejected"]))
        check("out-of-range float rejected",
              any(r["key"] == "Sharpness" for r in write["rejected"]))

        after_ini = IniFile(target / "OptiScaler.ini")
        values = after_ini.to_dict()
        check("values persisted",
              values["FrameGen"]["Enabled"] == "true"
              and values["Upscalers"]["Dx12Upscaler"] == "fsr31")
        after = (target / "OptiScaler.ini").read_text(encoding="utf-8")
        check("every comment preserved",
              before.count(";") == after.count(";"),
              f"{before.count(';')} -> {after.count(';')}")

        print("\nManual wiki selection")
        if wiki_entries:
            found = await service.search_wiki("forza")
            names = [r["name"] for r in found["results"]]
            check("search finds Forza entries", "Forza Horizon 5" in names, names[:3])
            found = await service.search_wiki("expedition")
            check("search finds Expedition 33",
                  any("Expedition 33" in n for n in
                      [r["name"] for r in found["results"]]))
            await service.set_wiki_entry(cyberpunk["path"], "Forza Horizon 5")
            pinned = await service.get_recommendation(
                "Cyberpunk 2077", None, False, cyberpunk["path"]
            )
            check("pinned entry overrides name matching",
                  pinned["game"] == "Forza Horizon 5" and pinned.get("manual"),
                  pinned["game"])
            await service.set_wiki_entry(cyberpunk["path"], "")
            unpinned = await service.get_recommendation(
                "Cyberpunk 2077", None, False, cyberpunk["path"]
            )
            check("unpinning restores automatic matching",
                  unpinned["game"] == "Cyberpunk 2077", unpinned["game"])

            missing = await service.get_recommendation("Totally Made Up Game 9000")
            check("a miss reports the list as available, not broken",
                  missing["list_available"] and missing["entry_count"] > 0)
            check("a miss reports what was searched", missing["searched"] == ["Totally Made Up Game 9000"])
            check("a miss offers near misses to pick from", len(missing["near_misses"]) > 0)
        else:
            print("  (offline — skipped)")

        print("\nWiki refresh behind the answer")
        from optiscaler import wiki as wiki_mod
        real_get = wiki_mod._http_get
        served = []
        try:
            # A list already on disk, and a network that is slow enough that
            # waiting for it would be obvious in the answer's timing.
            service.wiki.list_cache.write_text(json.dumps({
                "fetched_at": time.time() - COMPAT_CACHE_TTL - 60,
                "entries": [{"name": "Cached Game", "key": "cachedgame", "page": None,
                             "compatibility": "OK", "inputs": "DLSS",
                             "optipatcher": False, "notes": ""}],
            }))

            def slow(url, *a, **k):
                served.append(url)
                time.sleep(0.4)
                return ("| Game | Compatibility | Inputs |\n|---|---|---|\n"
                        "| [Cached Game](Cached-Game) | OK | DLSS |\n"
                        "| [Brand New Game](Brand-New-Game) | OK | DLSS |\n")

            wiki_mod._http_get = slow
            started = time.monotonic()
            answer = await service.get_recommendation("Cached Game")
            elapsed = time.monotonic() - started
            check("a stale list still answers immediately", elapsed < 0.3, f"{elapsed:.2f}s")
            check("and answers from the cache it had", answer["matched"], answer.get("game"))
            check("the answer says the list behind it is old",
                  answer["list_meta"].get("stale") is True)
            before = answer["list_meta"].get("revision")

            # And the refresh really did run behind it.
            for _ in range(40):
                await asyncio.sleep(0.05)
                if not service._wiki_jobs:
                    break
            check("a refresh was started behind the answer", bool(served), served)
            after = await service.wiki_status()
            check("and the newer list replaced the cached one",
                  after["entry_count"] == 2 and after["revision"] != before,
                  f"{before} -> {after['revision']}")
            check("which is how the UI knows to redraw", bool(after["revision"]))

            # Single flight: three questions in a row are not three downloads.
            service.wiki.list_cache.write_text(json.dumps({
                "fetched_at": time.time() - COMPAT_CACHE_TTL - 60,
                "entries": after["entry_count"] * [
                    {"name": "Cached Game", "key": "cachedgame", "page": None,
                     "compatibility": "OK", "inputs": "DLSS",
                     "optipatcher": False, "notes": ""}],
            }))
            served.clear()
            await asyncio.gather(*(service.get_recommendation("Cached Game") for _ in range(3)))
            for _ in range(40):
                await asyncio.sleep(0.05)
                if not service._wiki_jobs:
                    break
            check("three questions in a row are one download, not three",
                  len(served) == 1, len(served))

            # The Forza Horizon 5 case: a game whose own wiki page has never
            # been cached, on a Deck whose route to the wiki stalls rather than
            # refusing. The page used to be fetched in front of the answer, so
            # the setup tab sat on "Checking the OptiScaler wiki…" for ever —
            # while a game whose page happened to be cached answered fine.
            shutil.rmtree(service.wiki.page_cache, ignore_errors=True)
            service.wiki.page_cache.mkdir(parents=True, exist_ok=True)
            service.wiki.list_cache.write_text(json.dumps({
                "fetched_at": time.time(),
                "entries": [{"name": "Cached Game", "key": "cachedgame",
                             "page": "Cached-Game", "compatibility": "OK",
                             "inputs": "DLSS", "optipatcher": False, "notes": ""}],
            }))

            def stalls(url, *a, **k):
                served.append(url)
                # Long enough that answering at all proves nothing waited for
                # it, short enough that the attempt finishes inside this test.
                time.sleep(1)
                raise TimeoutError("stalled")

            wiki_mod._http_get = stalls
            started = time.monotonic()
            answer = await service.get_recommendation("Cached Game")
            elapsed = time.monotonic() - started
            check("a game whose wiki page was never cached still answers at once",
                  elapsed < 0.3, f"{elapsed:.2f}s")
            check("and says the fuller answer is still coming",
                  answer["matched"] and answer["detail_pending"] is True)
            for _ in range(200):
                await asyncio.sleep(0.05)
                if not service._wiki_jobs:
                    break
            # And having failed once, it stops claiming a refresh is running —
            # a page the wiki will not serve kept one permanently in flight,
            # which is how "Reading this game's entry…" became permanent.
            await service.get_recommendation("Cached Game")
            await asyncio.sleep(0.1)
            check("a page that will not download stops being re-attempted",
                  not service._wiki_jobs, service._wiki_jobs)

            # A pinned entry's answer has to be comparable with the status the
            # UI watches. It used to invent its own metadata with no revision
            # in it, so every check read as "something changed" and the plan
            # reloaded every two seconds for ever.
            await service.set_wiki_entry(str(target), "Cached Game")
            pinned = await service.get_recommendation("Cached Game", game_path=str(target))
            state = await service.wiki_status()
            check("a pinned entry carries the same revision the watch compares",
                  pinned["list_meta"].get("revision") == state["revision"],
                  f"{pinned['list_meta'].get('revision')} vs {state['revision']}")
            check("and still says it was pinned by hand",
                  pinned["list_meta"]["source"] == "manual")
            await service.set_wiki_entry(str(target), None)
        finally:
            wiki_mod._http_get = real_get

        print("\nMonitoring")
        (target / "OptiScaler.log").write_text(
            "[12:00:01.1] [I] Running on Wine 9.0-GE!\n"
            "[12:00:01.2] [I] OptiScaler working as winmm.dll, system dll loaded\n"
            "[12:00:02.0] [I] Adapter Desc: AMD Custom GPU 0405\n"
            "[12:00:05.0] [I] Creating new FSR 4.0.2 upscaler\n"
            "[12:00:06.0] [I] XeFG swapchain created\n"
            "[12:00:07.0] [E] Something broke\n"
        )
        report = await service.get_monitor(str(target))
        check("upscaler read from log", report["state"]["upscaler"] == "FSR 4.0.2",
              report["state"]["upscaler"])
        check("frame generation path detected", report["frame_generation"] == ["XeFG"],
              report["frame_generation"])
        check("errors counted", report["counts"].get("error") == 1)
        check("configured values reported", report["configured"]["fg_enabled"] == "true")

        print("\nUninstall")
        removal = await service.uninstall(str(target))
        check("uninstall succeeded", removal["ok"])
        check("no install remains", not installer.detect(str(target))["installed"])
        check("game folder restored to original contents",
              sorted(p.name for p in target.iterdir())
              == ["Cyberpunk2077.exe", "Licenses", "amd_fidelityfx_upscaler_dx12.dll", "dxgi.dll"],
              sorted(p.name for p in target.iterdir()))
        check("original dll byte-identical", (target / "dxgi.dll").read_bytes() == original)
        check("game's own FidelityFX dll restored byte-identical",
              (target / "amd_fidelityfx_upscaler_dx12.dll").read_bytes() == game_upscaler)
        check("game's own Licenses folder restored",
              (target / "Licenses" / "game.txt").read_text() == "GAME LICENSE")
        check("backup folder cleaned up", not stash.exists())
        check("the launch-options record goes with the install",
              not installer.detect(str(target))["launch_record"]["recorded"])
        check("imported FSR4 files removed too",
              not (target / "amdxcffx64.dll").exists())
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _accepts(field, value):
    try:
        field.encode(value)
        return True
    except (TypeError, ValueError):
        return False


def check_live_control():
    """The live-control channel: field mapping, wire format, install/removal.

    The mapping check matters most -- the ASI writes into OptiScaler's memory at
    offsets derived from the member names listed here, so a name that no longer
    exists in the generated mirror would be a silent no-op at best.
    """
    import json
    import re
    from optiscaler import live

    print("\nLive in-game control")

    mirror = ROOT / "asi" / "generated" / "config_mirror.h"
    check("generated config mirror exists", mirror.is_file())
    known = set(re.findall(r"^    X\((\w+),", mirror.read_text(), re.M)) if mirror.is_file() else set()
    missing = sorted(f.member for f in live.LIVE_FIELDS.values() if f.member not in known)
    check("every live field exists in the generated mirror", not missing, missing)

    ini_map = json.loads((ROOT / "py_modules" / "optiscaler" / "live_fields.json").read_text())["fields"]
    mismatched = sorted(
        key for key, field in live.LIVE_FIELDS.items()
        if ini_map.get(key, {}).get("member") != field.member
    )
    check("every live field maps to the ini key OptiScaler reads it from",
          not mismatched, mismatched)

    # 0.9.4 keeps the upscaler ids as plain strings in Config and State, so they
    # go over the wire verbatim -- but only ids OptiScaler actually knows.
    check("upscaler ids are passed through unchanged",
          live.LIVE_FIELDS["Upscalers.Dx12Upscaler"].encode("fsr31") == "fsr31")
    check("the dx11-on-12 id is a distinct backend",
          live.LIVE_FIELDS["Upscalers.Dx11Upscaler"].encode("fsr31_12") == "fsr31_12")
    check("an id OptiScaler does not know is refused",
          not _accepts(live.LIVE_FIELDS["Upscalers.Dx12Upscaler"], "ffx"))

    root = Path(tempfile.mkdtemp(prefix="optiscaler-live-"))
    try:
        target = root / "game"
        target.mkdir()
        state = live.status(str(target))
        check("no live channel before install", not state["attached"] and state["state"] == "absent")

        fake_asi = root / "fake.asi"
        fake_asi.write_bytes(b"MZ fake")
        check("asi installs into the plugins folder",
              live.install_asi(str(target), fake_asi)["ok"]
              and (target / "plugins" / live.ASI_NAME).is_file())

        result = live.apply_changes(str(target), [
            {"section": "FrameGen", "key": "Enabled", "value": "true"},
            {"section": "Upscalers", "key": "Dx12Upscaler", "value": "fsr31"},
            {"section": "Hotfix", "key": "DisableOverlays", "value": "true"},
        ])
        body = (target / live.CMD_FILE).read_text()
        check("live-settable keys are sent", result["applied"] == ["FGEnabled"],
              result["applied"])
        check("restart-only keys are reported as deferred",
              result["deferred"] == ["Hotfix.DisableOverlays"], result["deferred"])
        # The overlay's own upscaler switch is two writes: the id into
        # State::newBackend, then every backend marked changed. Writing Config
        # alone would change nothing until the next launch.
        check("an upscaler change asks for the live backend switch",
              "backend fsr31" in body and result["backend_change"]
              and result["backend"] == "fsr31", body)
        check("command file is the documented wire format",
              body.splitlines()[1:3] == ["backend fsr31", "set FGEnabled bool 1"],
              body.splitlines())
        # The overlay's "Change Upscaler" writes State::newBackend and leaves
        # Config alone until OptiScaler has rebuilt the feature; it also refuses
        # to act when newBackend already equals the Config value. Pushing the
        # new id into Config first is therefore how a switch turns into a no-op,
        # which is exactly what "frame generation moves, the upscaler does not"
        # looked like. The ini still records the choice for the next launch.
        check("the config upscaler is not written alongside the switch",
              "set Dx12Upscaler" not in body, body)

        # The FFX frame generator goes over its own verb, because the ASI has
        # to write Config *and* raise two State flags; a plain field write
        # would leave the new index sitting in Config doing nothing until the
        # next launch. This is the one live setting where Config is the target.
        fg = live.apply_changes(str(target), [
            {"section": live.FFX_FG_SECTION, "key": live.FFX_FG_KEY, "value": "1"},
        ])
        fg_body = (target / live.CMD_FILE).read_text()
        check("an ffx fg version change is sent as its own command",
              fg_body.splitlines()[1] == "fgindex 1" and fg["fg_change"],
              fg_body.splitlines())
        check("it is not also sent as a plain field write",
              "set FfxFGIndex" not in fg_body, fg_body)
        check("an index OptiScaler could not have is refused rather than clamped",
              not _accepts(live.LIVE_FIELDS[live.FFX_FG_ID], "99")
              and not _accepts(live.LIVE_FIELDS[live.FFX_FG_ID], "-1"))
        check("an unset ffx fg version is left for the next launch",
              live.apply_changes(str(target), [
                  {"section": live.FFX_FG_SECTION, "key": live.FFX_FG_KEY,
                   "value": "auto"}])["deferred"] == [live.FFX_FG_ID])

        # The FSR version travels the same way and for the same reason one
        # step out: the index is read when the *upscaler* builds its context,
        # so what makes it take effect now is the feature being rebuilt.
        ups = live.apply_changes(str(target), [
            {"section": live.FFX_UPSCALER_SECTION, "key": live.FFX_UPSCALER_KEY,
             "value": "2"},
        ])
        ups_body = (target / live.CMD_FILE).read_text()
        check("an ffx upscaler version change is sent as its own command",
              ups_body.splitlines()[1] == "ffxupscaler 2" and ups["ffx_upscaler_change"],
              ups_body.splitlines())
        check("it is not also sent as a plain field write",
              "set FfxUpscalerIndex" not in ups_body, ups_body)
        check("an index this game could not have is refused rather than clamped",
              not _accepts(live.LIVE_FIELDS[live.FFX_UPSCALER_ID], "99")
              and not _accepts(live.LIVE_FIELDS[live.FFX_UPSCALER_ID], "-1"))

        # Both are answered by one rebuild, and the rebuild reads the index --
        # so the index has to be written before the rebuild is asked for. A
        # preset that picks the backend *and* the version sends both at once.
        both = live.apply_changes(str(target), [
            {"section": "Upscalers", "key": "Dx12Upscaler", "value": "fsr31"},
            {"section": live.FFX_UPSCALER_SECTION, "key": live.FFX_UPSCALER_KEY,
             "value": "0"},
        ])
        both_body = (target / live.CMD_FILE).read_text()
        check("the version is written before the switch that rebuilds on it",
              both_body.splitlines()[1:3] == ["ffxupscaler 0", "backend fsr31"],
              both_body.splitlines())
        check("and both are reported", both["backend_change"] and both["ffx_upscaler_change"])

        # DX12 and DX11 name the same upscaler differently; only one id can go
        # into newBackend, and DX12 is the one that wins.
        multi = live.apply_changes(str(target), [
            {"section": "Upscalers", "key": "Dx11Upscaler", "value": "fsr31_12"},
            {"section": "Upscalers", "key": "Dx12Upscaler", "value": "fsr31"},
        ])
        check("the dx12 id wins when several apis are set at once",
              multi["backend"] == "fsr31", multi["backend"])

        check("a change with nothing live-settable sends nothing",
              live.apply_changes(str(target), [
                  {"section": "Hotfix", "key": "DisableOverlays", "value": "true"}])["sent"] is False)

        live.remove_asi(str(target))
        check("removal takes the asi and its control files",
              not (target / "plugins" / live.ASI_NAME).exists()
              and not (target / live.CMD_FILE).exists()
              and not (target / "plugins").exists())
    finally:
        shutil.rmtree(root, ignore_errors=True)


def check_live_diagnostics():
    """The three separate reasons live control can be silently absent.

    "Not connected" on its own is useless to the user, and each of these has a
    different fix: the plugin is missing, OptiScaler is not set to load plugins
    at all (it defaults to off), or it loaded and could not find what it needed.
    """
    import tempfile
    from optiscaler import live

    print("\nLive control diagnostics")
    root = Path(tempfile.mkdtemp(prefix="optiscaler-diag-"))
    try:
        target = root / "game"
        target.mkdir()

        check("no ini means the load switch is unknown", live.load_enabled(str(target)) is None)
        (target / "OptiScaler.ini").write_text("[Plugins]\nLoadAsiPlugins=auto\n")
        check("the switch defaults to off, and is reported as off",
              live.load_enabled(str(target)) is False)
        (target / "OptiScaler.ini").write_text("[Plugins]\nLoadAsiPlugins=true\n")
        check("the switch is seen once it is on", live.load_enabled(str(target)) is True)
        # It must not match the same key in another section.
        (target / "OptiScaler.ini").write_text("[Menu]\nLoadAsiPlugins=true\n")
        check("the switch is only read from the Plugins section",
              live.load_enabled(str(target)) is False)

        check("no log means it is unknown whether OptiScaler loaded it",
              live.loaded_by_optiscaler(str(target)) is None)
        (target / "OptiScaler.log").write_text("[info] Checking C:\\game\\plugins for *.asi\n")
        check("a searched-but-empty plugins folder is reported as not loaded",
              live.loaded_by_optiscaler(str(target)) is False)
        (target / "OptiScaler.log").write_text(
            f"[info] Loaded: C:\\game\\plugins\\{live.ASI_NAME}\n")
        check("OptiScaler's own log confirms the load",
              live.loaded_by_optiscaler(str(target)) is True)

        # The heartbeat is what makes staleness mean "the game is gone" rather
        # than "nobody changed a setting recently".
        check("the staleness window is short enough to track a live game",
              live.STATUS_STALE_SECONDS <= 30, live.STATUS_STALE_SECONDS)

        status_file = target / live.STATUS_FILE
        status_file.write_text(
            "schema 2\nstatus ready\nseq 1\nconfig 0x1\nstate 0x2\nbackends 0x3\n"
            "newbackend 0x4\nfps 40.4\nfg_enabled 1\ndx12_upscaler fsr31\n"
            "pending_backend \nerror \n")
        report = live.status(str(target))
        check("a fresh heartbeat reads as attached", report["attached"] and report["ready"])
        check("frame rate is carried through", report["fps"] == 40.4, report["fps"])
        check("frame generation state is carried through", report["fg_enabled"] is True)
        check("the live upscaler is carried through",
              report["upscaler"]["dx12"] == "fsr31", report["upscaler"])
        check("upscaler switching needs both halves present",
              report["can_switch_upscaler"])

        old = time.time() - (live.STATUS_STALE_SECONDS + 30)
        os.utime(status_file, (old, old))
        check("a stale heartbeat reads as gone", not live.status(str(target))["attached"])

        # A status file from an older in-game plugin has none of the new fields.
        status_file.write_text("schema 1\nstatus ready\nseq 1\nbackends 0x0\nerror \n")
        legacy = live.status(str(target))
        check("an older status file degrades instead of breaking",
              legacy["fps"] is None and legacy["fg_enabled"] is None
              and not legacy["can_switch_upscaler"])

        # How many upscalers OptiScaler has registered is the difference
        # between "wait, the game has not made one yet" and "the backend list
        # could not be read", and the two need different advice.
        status_file.write_text(
            "schema 3\nstatus ready\nseq 1\nconfig 0x1\nstate 0x2\nbackends 0x3\n"
            "newbackend 0x4\nbackend_entries 0\nframes 12000\nfps 60.0\nerror \n")
        none_yet = live.status(str(target))
        check("no registered upscaler means no live switch",
              none_yet["backend_entries"] == 0 and not none_yet["can_switch_upscaler"])
        check("the raw frame counter is carried through for diagnostics",
              none_yet["frames"] == 12000, none_yet["frames"])

        status_file.write_text(
            "schema 3\nstatus ready\nseq 1\nconfig 0x1\nstate 0x2\nbackends 0x3\n"
            "newbackend 0x4\nbackend_entries -1\nerror \n")
        unreadable = live.status(str(target))
        check("an unreadable count is unknown, not zero",
              unreadable["backend_entries"] is None and unreadable["can_switch_upscaler"])

        sent = live.switch_backend(str(target), "fsr31")
        body = (target / live.CMD_FILE).read_text().splitlines()
        check("the explicit switch sends just the backend command",
              sent["ok"] and body[1] == "backend fsr31", body)
        check("the explicit switch refuses an unknown id",
              not live.switch_backend(str(target), "ffx")["ok"])
    finally:
        shutil.rmtree(root, ignore_errors=True)


def check_reported_folder():
    """The folder the in-game plugin reports, against the one being managed.

    The plugin reports a Windows path and Proton's drive letters are what make
    this more than a string compare. ``Z:`` is the filesystem root, so that case
    shares a tail outright -- but a library on the SD card gets its own letter,
    and ``S:\\steamapps\\common\\...`` shares no tail at all with
    ``/run/media/.../steamapps/common/...``. A healthy install on a card
    therefore reported itself as writing to the wrong folder, in a warning that
    told the user to reinstall something that was working.
    """
    from optiscaler.live import _same_dir

    print("\nThe folder the in-game plugin reports")
    check("a library on the SD card matches through its drive letter",
          _same_dir("S:\\steamapps\\common\\Expedition 33\\Sandfall\\Binaries\\Win64",
                    "/run/media/mmcblk0p1/steamapps/common/Expedition 33/"
                    "Sandfall/Binaries/Win64") is True)
    check("and so does internal storage, where Z: is the root",
          _same_dir("Z:\\home\\deck\\.steam\\steam\\steamapps\\common\\Game\\Bin",
                    "/home/deck/.steam/steam/steamapps/common/Game/Bin") is True)
    check("a genuinely different game is still a mismatch",
          _same_dir("S:\\steamapps\\common\\Other\\Binaries\\Win64",
                    "/run/media/mmcblk0p1/steamapps/common/Expedition 33/"
                    "Sandfall/Binaries/Win64") is False)
    # Whole components only: "Win64" is every Unreal game's last folder, and
    # one shared name is not a shared path.
    check("one shared folder name is not a match",
          _same_dir("S:\\somewhere\\Win64", "/games/Expedition 33/Win64") is False)
    check("a path that says nothing gives no answer",
          _same_dir("", "/games/x") is None)


def check_asi_staleness():
    """A game keeps the in-game plugin it was set up with, for ever.

    Updating the Decky plugin copies a new ASI into ``bin/`` and nothing else:
    every game still holds the build it was set up with, which attaches,
    heartbeats and answers exactly like a current one -- it simply has nothing
    to say about fields added since. That is indistinguishable from a feature
    that was never built, which is precisely how it was reported.
    """
    import tempfile
    from optiscaler import live

    print("\nAn out-of-date in-game plugin")
    root = Path(tempfile.mkdtemp(prefix="optiscaler-asi-"))
    try:
        target = root / "game"
        (target / live.PLUGIN_SUBDIR).mkdir(parents=True)
        shipped = root / "bin" / live.ASI_NAME
        shipped.parent.mkdir()
        shipped.write_bytes(b"MZ" + b"new" * 40)

        check("nothing to compare against is unknown, not out of date",
              live.asi_current(str(target), None) is None)
        check("and neither is a game that has no plugin at all",
              live.asi_current(str(target), str(shipped)) is None)

        installed = live.asi_path(str(target))
        installed.write_bytes(b"MZ" + b"old" * 40)
        check("a same-sized older build is still caught",
              live.asi_current(str(target), str(shipped)) is False)
        installed.write_bytes(b"MZ" + b"old" * 10)
        check("so is one of a different size",
              live.asi_current(str(target), str(shipped)) is False)
        installed.write_bytes(shipped.read_bytes())
        check("the shipped build compares equal",
              live.asi_current(str(target), str(shipped)) is True)

        # The shipped bytes are cached against the source file's stat, so a
        # rebuilt ASI has to invalidate it -- otherwise every game reads as
        # current for the rest of the session.
        import os
        shipped.write_bytes(b"MZ" + b"newer" * 40)
        os.utime(shipped, ns=(0, 0))
        check("a rebuilt plugin is noticed rather than served from the cache",
              live.asi_current(str(target), str(shipped)) is False)

        report = live.status(str(target), str(shipped))
        check("and the status report carries the answer",
              report["asi_current"] is False, report["asi_current"])
        check("a report asked without a source says nothing either way",
              live.status(str(target))["asi_current"] is None)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def check_asi_reporting():
    """The in-game plugin has to report what the panel needs to explain itself.

    Both of these exist because their absence was indistinguishable from a
    working plugin: a frame counter that never moves reads as "measuring" for
    ever, and an empty backend list reads as a switch that simply did nothing.
    """
    print("\nASI reporting")
    source = (ROOT / "asi" / "live.cpp").read_text(encoding="utf-8")
    check("the status file carries the backend count", '"backend_entries %d\\n"' in source)
    check("the status file carries the raw frame counter", '"frames %llu\\n"' in source)
    check("a counter that never moves triggers a search for one that does",
          "SearchFrameCounter" in source and "if (g_fps <= 0.0) SearchFrameCounter();" in source)
    check("the search only ever reads", "g_frameCount = (uint64_t*)" in source
          and "*g_frameCount =" not in source)
    # The FFX FG list is the game's own answer, and the flag pointer is how the
    # panel tells "cannot change it now" from "did not change it".
    check("the status file carries the ffx fg version list",
          '"ffx_fg_versions %s\\n"' in source)
    check("the status file says whether the fg flags were found",
          '"fgflags %p\\n"' in source)
    check("the status file carries the configured ffx fg index",
          '"fg_index %d\\n"' in source)
    # The FSR version list is the only place the exact version is written down;
    # the backend id says "fsr31" for every FSR from 2.3.4 to 4.1.1.
    check("the status file carries the ffx upscaler version list",
          '"ffx_upscaler_versions %s\\n"' in source)
    check("the status file carries the configured ffx upscaler index",
          '"ffx_upscaler_index %d\\n"' in source)
    # Two frame rates need two measurements. Both are read-only, and both are
    # sampled at the worker's own rate rather than once a heartbeat, because
    # each slot holds one frame's interval and not an average.
    check("the status file carries both frame intervals",
          '"rendered_ms %.3f\\n"' in source and '"presented_ms %.3f\\n"' in source)
    check("the frame intervals are sampled every tick, not every heartbeat",
          source.count("SampleFrameTimes();") >= 2, source.count("SampleFrameTimes();"))
    check("the frame intervals are only ever read",
          "const double* rendered" in source and "*g_frameTimes.rendered =" not in source)
    check("an implausible interval is dropped rather than averaged in",
          "if (!PlausibleInterval(value)) continue;" in source
          and "return ms > 0.05 && ms < 2000.0;" in source)
    # The declared offset produced nothing at all on a real Deck while the
    # counter eight bytes in front of the same table was correct, so there has
    # to be a way back from a mirror whose arithmetic is wrong.
    check("a pair that never reports is searched for instead",
          "if (g_renderedMs <= 0.0 && g_presentedMs <= 0.0) SearchFrameTimes();" in source)
    check("and the search identifies an interval rather than accepting any double",
          "static bool FrameTimeAnchor(double now, double before, double expected)" in source
          and "ratio > 0.65 && ratio < 1.35" in source)
    check("two separate intervals are a refusal, not a choice",
          "refusing to guess" in source)
    check("the search is read-only and gives up rather than running for ever",
          "g_ftDone = true;" in source and "FT_MAX_ROUNDS" in source)


def check_live_frame_rates():
    """Reporting the rendered frame rate separately from the presented one.

    With frame generation on there are two frame rates and only one of them is
    the one the frame counter counts. OptiScaler measures both intervals for its
    own overlay and the plugin reads both.

    Which slot holds which was assumed once, from reading the two hooks that
    write them, and it was wrong: the panel showed the rendered rate labelled as
    the total and never showed a base at all, because the ratio came out above 1
    and was refused. Both numbers look like frame rates either way round, which
    is why nothing is assumed now -- interpolation can only add frames, so the
    shorter interval is the presented one whichever slot it came from, and which
    rate the counter counts is settled by which interval agrees with it.
    """
    from optiscaler.live import _frame_rates

    print("\nLive frame rates")
    # Two frames out for every one in, and the counter is on the presented side:
    # 60 fps presented, 30 rendered.
    check("a counter on the presented side gives the base below it",
          _frame_rates(60.0, 16.6, 33.2) == (30.0, 60.0))
    # The same session with the slots the other way round must give the same
    # answer -- that is the whole point.
    check("and the same answer with the two slots swapped",
          _frame_rates(60.0, 33.2, 16.6) == (30.0, 60.0))
    # The counter on the rendered side: 30 counted, so 60 reach the screen.
    check("a counter on the rendered side gives the total above it",
          _frame_rates(30.0, 16.6, 33.2) == (30.0, 60.0))
    check("and again with the slots swapped",
          _frame_rates(30.0, 33.2, 16.6) == (30.0, 60.0))
    check("tripled frames third the base", _frame_rates(90.0, 11.0, 33.0) == (30.0, 90.0))
    check("with nothing generated the two rates agree",
          _frame_rates(60.0, 16.6, 16.6) == (60.0, 60.0))
    # A counter that agrees with neither interval is not counting either of
    # them, and averaging over that would produce two plausible wrong numbers.
    check("a counter matching neither interval is refused",
          _frame_rates(200.0, 16.6, 33.2) == (None, None))
    check("an unmeasured interval means no answer",
          _frame_rates(60.0, None, 16.6) == (None, None)
          and _frame_rates(60.0, 16.6, None) == (None, None))
    check("no frame rate to scale means no answer",
          _frame_rates(None, 16.6, 33.2) == (None, None))


def check_remembered_choices():
    """Answers the user asked to be remembered have to survive a restart.

    The launch-options question is the one that matters: without the override
    Proton loads its own DLL and OptiScaler never runs, so the install offers to
    set it - but only until the user says "remember my choice".
    """
    import tempfile
    from optiscaler.settings import Settings

    print("\nRemembered choices")
    root = Path(tempfile.mkdtemp(prefix="optiscaler-prefs-"))
    try:
        path = root / "settings.json"
        settings = Settings(path)
        check("an unanswered question has no stored answer",
              settings.get_pref("launch_options") is None)
        settings.set_pref("launch_options", "always")
        check("the answer survives a reload",
              Settings(path).get_pref("launch_options") == "always")
        settings.set_pref("launch_options", None)
        check("forgetting it puts the question back",
              Settings(path).get_pref("launch_options") is None)
        check("prefs do not disturb the rest of the file",
              Settings(path).get("custom_libraries") == [])
        # "Remember my choices" is stored as a boolean and defaults to on, so
        # False has to survive as an answer rather than reading as "unset" —
        # otherwise turning remembering off would silently turn itself back on.
        settings.set_pref("remember_choices", False)
        check("switching remembering off is itself remembered",
              Settings(path).get_pref("remember_choices", True) is False)
        check("an untouched switch defaults to on",
              Settings(path).get_pref("never_asked", True) is True)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def check_launch_record():
    """Removing OptiScaler has to be able to undo the launch options too.

    Three states have to stay distinguishable, because each means a different
    thing on the removal dialog: no record at all (an older install, or a Steam
    build that would not report them - take out only our own override), a
    recorded empty string (the game genuinely had none - the field can be
    cleared outright), and a recorded value (put exactly that back).
    """
    import tempfile

    print("\nLaunch-options record")
    root = Path(tempfile.mkdtemp(prefix="optiscaler-launch-"))
    try:
        check("nothing recorded reads as nothing recorded",
              installer.read_launch_record(root) == {"recorded": False, "value": ""})

        installer.record_launch_options(root, "")
        check("an empty record is still a record — the game had none",
              installer.read_launch_record(root) == {"recorded": True, "value": ""})

        installer.record_launch_options(root, "mangohud %command%")
        check("write-once: the first answer is the one kept",
              installer.read_launch_record(root)["value"] == "",
              installer.read_launch_record(root)["value"])

        installer.forget_launch_options(root)
        installer.record_launch_options(root, 'PROTON_LOG=1 %command% -dx12')
        check("a real value round trips verbatim",
              installer.read_launch_record(root)["value"] == 'PROTON_LOG=1 %command% -dx12')
        check("the file is plain text next to the install",
              (root / "decky_optiscaler_previous_launch_options.txt").is_file())

        check("forgetting reports whether there was anything to forget",
              installer.forget_launch_options(root) is True
              and installer.forget_launch_options(root) is False)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def check_launch_options_read():
    """Steam's own config is the answer when the client will not give one.

    `SteamClient.Apps.GetAppLaunchOptions` is missing from some client builds
    outright, and the first version of the removal dialog leaned on it alone:
    on those Decks it recorded nothing at install time and offered nothing at
    removal, so OptiScaler's own override was left behind and the whole feature
    looked like it had never shipped. This is the source that does not depend
    on an undocumented method existing.
    """
    import tempfile
    from optiscaler import steam as steam_mod

    print("\nLaunch options from Steam's config")
    root = Path(tempfile.mkdtemp(prefix="optiscaler-localconfig-"))
    try:
        home = root / "home"
        config = home / ".local" / "share" / "Steam" / "userdata" / "12345" / "config"
        config.mkdir(parents=True)
        (home / ".local" / "share" / "Steam" / "steamapps").mkdir(parents=True)
        (home / ".steam").mkdir(parents=True, exist_ok=True)
        os.symlink(home / ".local" / "share" / "Steam", home / ".steam" / "steam")

        check("nothing readable is not the same as nothing set",
              steam_mod.launch_options(home, "1091500") == {"found": False, "value": "",
                                                            "source": None})

        (config / "localconfig.vdf").write_text(
            '"UserLocalConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n'
            '\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"apps"\n\t\t\t\t{\n'
            '\t\t\t\t\t"1091500"\n\t\t\t\t\t{\n'
            '\t\t\t\t\t\t"LaunchOptions"\t\t"mangohud %command% -dx12"\n'
            '\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n'
        )
        found = steam_mod.launch_options(home, "1091500")
        check("the launch options are read out of localconfig.vdf",
              found["found"] and found["value"] == "mangohud %command% -dx12", found["value"])
        absent = steam_mod.launch_options(home, "2358720")
        check("a game with no entry has none, which is an answer not a gap",
              absent["found"] and absent["value"] == "", absent)

        # Older and newer clients disagree on the capitalisation of the path,
        # and a lookup that guesses wrong reads as "this user has no games".
        (config / "localconfig.vdf").write_text(
            '"userlocalconfigstore" { "software" { "valve" { "steam" { "apps" {'
            ' "1091500" { "launchoptions" "PROTON_LOG=1 %command%" } } } } } }'
        )
        check("the path is matched whatever its capitalisation",
              steam_mod.launch_options(home, "1091500")["value"] == "PROTON_LOG=1 %command%")

        # An override with quotes in it is the exact case this has to survive.
        (config / "localconfig.vdf").write_text(
            '"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "1091500" {'
            ' "LaunchOptions" "WINEDLLOVERRIDES=\\"dxgi=n,b\\" %command%" } } } } } }'
        )
        check("an escaped quote in the value survives the round trip",
              steam_mod.launch_options(home, "1091500")["value"]
              == 'WINEDLLOVERRIDES="dxgi=n,b" %command%',
              steam_mod.launch_options(home, "1091500")["value"])
    finally:
        shutil.rmtree(root, ignore_errors=True)


def check_wiki_failure_reporting():
    """A list that will not download must not read as "your game is not on it".

    Both produced an empty result and the UI showed the same sentence for each,
    so a network fault presented as every game in the library being unknown to
    the wiki — with nothing anywhere saying otherwise and no way to retry.
    `status()` is the answer to which of the two it is.
    """
    import tempfile
    from optiscaler import wiki as wiki_mod

    print("\nWiki failure reporting")
    root = Path(tempfile.mkdtemp(prefix="optiscaler-wiki-"))
    real_get = wiki_mod._http_get
    try:
        client = wiki_mod.WikiClient(root / "cache")

        wiki_mod._http_get = lambda *a, **k: (_ for _ in ()).throw(
            urllib.error.URLError("Network is unreachable"))
        entries, meta = client.load_entries(True)
        check("an unreachable wiki yields no entries", entries == [])
        check("and says so in the words of what failed",
              "Network is unreachable" in (meta["error"] or ""), meta["error"])
        state = client.status()
        check("status reports the list as unavailable, not empty",
              not state["available"] and state["entry_count"] == 0)
        check("status carries the error the UI has to print",
              "Network is unreachable" in (state["error"] or ""))
        check("status names the address it could not reach",
              state["url"].endswith("Compatibility-List.md"), state["url"])

        # A list that does download is the other answer, and the difference is
        # the whole point.
        table = ("| Game | Compatibility | Inputs |\n|---|---|---|\n"
                 "| [Cyberpunk 2077](Cyberpunk-2077) | OK | DLSS |\n")
        wiki_mod._http_get = lambda *a, **k: table
        state = client.status(True)
        check("a list that downloads reports as available",
              state["available"] and state["entry_count"] == 1, state)
        check("and carries no error", state["error"] is None)

        # A fetch that succeeds but parses to nothing is a third case, and must
        # not be cached as if it were a real answer.
        wiki_mod._http_get = lambda *a, **k: "not a table at all"
        empty, meta = client.load_entries(True)
        check("a page that parses to nothing is reported, not cached",
              "zero rows" in (meta["error"] or ""), meta["error"])
        check("and the last good list is served instead of nothing",
              len(empty) == 1, len(empty))
    finally:
        wiki_mod._http_get = real_get
        shutil.rmtree(root, ignore_errors=True)


def check_wiki_cache():
    """Answers come from cache; the network is never in front of a question.

    A handheld is regularly asleep, offline, or on a network that resolves and
    does not route. Waiting for the wiki before answering meant every one of
    those cost a full timeout, and a cache older than a day was thrown away
    rather than used. Reading is stale-while-revalidate now: whatever is on
    disk is returned at once, and the refresh happens behind it.
    """
    import tempfile
    from optiscaler import wiki as wiki_mod

    print("\nWiki cache")
    root = Path(tempfile.mkdtemp(prefix="optiscaler-swr-"))
    real_get = wiki_mod._http_get
    calls = []

    def serve(table):
        def get(url, *a, **k):
            calls.append(url)
            return table
        return get

    one = ("| Game | Compatibility | Inputs |\n|---|---|---|\n"
           "| [Cyberpunk 2077](Cyberpunk-2077) | OK | DLSS |\n")
    two = one + "| [Black Myth: Wukong](Black-Myth-Wukong) | OK | DLSS |\n"

    try:
        seed = root / "seed.json"
        seed.write_text(json.dumps({
            "fetched_at": time.time(),
            "entries": [{"name": "Seeded Game", "key": "seededgame", "page": None,
                         "compatibility": "OK", "inputs": "DLSS", "optipatcher": False,
                         "notes": ""}],
        }))

        # A Deck that has never had a connection still has a list.
        wiki_mod._http_get = lambda *a, **k: (_ for _ in ()).throw(
            urllib.error.URLError("Network is unreachable"))
        offline = wiki_mod.WikiClient(root / "a", seed)
        entries, meta = offline.load_entries()
        check("an offline Deck falls back to the bundled list",
              len(entries) == 1 and meta["source"] == "bundled", meta["source"])
        check("and reports the list as available, not as a missing game",
              offline.status()["available"])

        # With no seed and no network there is genuinely nothing.
        bare = wiki_mod.WikiClient(root / "b")
        check("no cache and no network is still an empty list, reported as such",
              bare.load_entries()[0] == [] and not bare.status()["available"])

        # A cached list answers without touching the network at all.
        wiki_mod._http_get = serve(one)
        client = wiki_mod.WikiClient(root / "c", seed)
        client.revalidate()
        calls.clear()
        entries, meta = client.load_entries()
        check("a cached list is served with no request at all",
              len(entries) == 1 and calls == [], calls)
        check("and says which list it came from", meta["source"] == "cache")

        # Even when it is older than the TTL: stale is a reason to refresh
        # behind the answer, never a reason to wait for one.
        payload = json.loads(client.list_cache.read_text())
        payload["fetched_at"] = time.time() - (COMPAT_TTL := 60 * 60 * 24) - 60
        client.list_cache.write_text(json.dumps(payload))
        calls.clear()
        entries, meta = client.load_entries()
        check("a stale list is still served without waiting",
              len(entries) == 1 and calls == [], calls)
        check("and is flagged stale so a refresh gets started",
              meta["stale"] and client.is_stale())

        # The fingerprint is what the UI watches to know something arrived.
        before = client.revision()
        wiki_mod._http_get = serve(one)
        same = client.revalidate()
        check("a refresh that brings back the same list changes nothing",
              same["ok"] and not same["changed"] and client.revision() == before)
        wiki_mod._http_get = serve(two)
        changed = client.revalidate()
        check("a refresh that brings something new says so",
              changed["ok"] and changed["changed"] and changed["count"] == 2)
        check("and the fingerprint moves with it", client.revision() != before)

        # The one rule that keeps this from ever making things worse.
        good = client.revision()
        wiki_mod._http_get = lambda *a, **k: (_ for _ in ()).throw(
            urllib.error.URLError("Network is unreachable"))
        failed = client.revalidate()
        check("a failed refresh leaves the working cache alone",
              not failed["ok"] and client.revision() == good and
              len(client.load_entries()[0]) == 2)
        check("but the failure is remembered for the UI to show",
              "unreachable" in (client.last_error or ""), client.last_error)
        wiki_mod._http_get = serve(two)
        client.revalidate()
        check("and a later success clears it", client.last_error is None)

        # Detail pages follow the same rule: a stale one used to mean two HTTP
        # attempts in front of the answer, the second only after the first
        # timed out.
        wiki_mod._http_get = serve("== Cyberpunk\n|**Filename**\n|`dxgi.dll`\n")
        client.fetch_page("Cyberpunk-2077")
        os.utime(client._page_file("Cyberpunk-2077"),
                 (time.time() - COMPAT_TTL - 60,) * 2)
        calls.clear()
        page = client.load_page("Cyberpunk-2077")
        check("a stale detail page is served from disk, not waited for",
              page is not None and calls == [], calls)
        check("and is reported stale so it can be refreshed behind the answer",
              client.page_is_stale("Cyberpunk-2077"))

        # The hole the stale rule left: a page never downloaded at all was
        # still fetched in front of the answer, two URLs deep with the second
        # attempt only starting once the first had timed out. On a Deck with a
        # bad route to the wiki that is a lookup that never returns, and the
        # setup tab sat on "Checking the OptiScaler wiki…" for ever — for
        # exactly the games whose page had not happened to be cached already.
        calls.clear()
        missing = client.load_page("Never-Seen", allow_fetch=False)
        check("a page never downloaded is not fetched in front of the answer",
              missing is None and calls == [], calls)
        check("but it counts as stale, so it is fetched behind one",
              client.page_is_stale("Never-Seen"))

        # And the arrival has to be visible to the same watch that notices a
        # changed list, or the better answer never reaches the screen.
        before_page = client.revision()
        wiki_mod._http_get = serve("== Never seen\n|**Filename**\n|`winmm.dll`\n")
        client.fetch_page("Never-Seen")
        check("a page arriving moves the revision the UI watches",
              client.revision() != before_page,
              f"{before_page} -> {client.revision()}")
        after_page = client.revision()
        client.fetch_page("Never-Seen")
        check("re-fetching the same page moves nothing",
              client.revision() == after_page)

        # A page the wiki will not serve must not be asked for on every
        # question. Each attempt is two URLs deep, so re-attempting kept a
        # refresh permanently in flight — and the UI reads "a refresh is
        # running" as "the answer may still change", so it never stopped
        # waiting for one that was never going to arrive.
        wiki_mod._http_get = lambda *a, **k: (_ for _ in ()).throw(
            urllib.error.URLError("Network is unreachable"))
        check("a page that has never been seen is worth one attempt",
              client.page_needs_fetch("Refused-Page"))
        check("which is made", client.fetch_page("Refused-Page") is None)
        check("and not repeated on the next question",
              not client.page_needs_fetch("Refused-Page"))
        check("a page already cached is not asked for at all",
              not client.page_needs_fetch("Never-Seen"))
        check("nor is a game with no wiki page", not client.page_needs_fetch(None))
        # Coming back onto a network has to be noticed eventually.
        client._page_failed_at["Refused-Page"] = time.time() - wiki_mod.PAGE_RETRY_AFTER - 1
        check("but the cooldown does expire", client.page_needs_fetch("Refused-Page"))
    finally:
        wiki_mod._http_get = real_get
        shutil.rmtree(root, ignore_errors=True)


def check_wiki_transport():
    """The fetch has to survive the ways one Deck's network differs.

    A router that advertises IPv6 it cannot route is the classic case: the
    address resolves, nothing connects, and urllib has no Happy Eyeballs to
    fall back the way a browser would — so it sits on the first address until
    the timeout, every time, and the wiki never loads on that network while
    everything else works.
    """
    import socket as socket_mod
    from optiscaler import wiki as wiki_mod

    print("\nWiki transport")
    real_open = wiki_mod._open
    attempts = []

    def stalls_once(request, timeout, context, binary=False):
        attempts.append(socket_mod.getaddrinfo)
        if len(attempts) == 1:
            raise urllib.error.URLError(TimeoutError("timed out"))
        return "| Game | Compatibility |\n|---|---|\n| [X](X) | OK |\n"

    try:
        wiki_mod._open = stalls_once
        body = wiki_mod._http_get("https://example.invalid/x")
        check("a stalled connection is retried rather than given up on",
              body.startswith("| Game"), len(attempts))
        check("and the retry is the one that forces IPv4",
              attempts[1] is not attempts[0])
        check("the resolver is put back afterwards",
              socket_mod.getaddrinfo is attempts[0])

        # A server that answered is not retried: asking again says the same.
        attempts.clear()

        def refuses(request, timeout, context, binary=False):
            attempts.append(1)
            raise urllib.error.HTTPError("u", 404, "Not Found", {}, None)

        wiki_mod._open = refuses
        try:
            wiki_mod._http_get("https://example.invalid/x")
            check("an HTTP error is not retried", False, "no error raised")
        except urllib.error.HTTPError:
            check("an HTTP error is not retried", len(attempts) == 1, len(attempts))
    finally:
        wiki_mod._open = real_open

    kinds = [kind for kind, _ in wiki_mod._candidate_contexts()]
    check("an unverified context is always the last resort",
          kinds and kinds[-1] == "unverified", kinds)


def check_wiki_tls():
    """TLS failures must fall through to the next CA source, not abort.

    urlopen wraps an SSLError in a URLError, so an `except ssl.SSLError` around
    it never fires -- the fallback contexts were unreachable and every lookup
    reported the game as absent from the compatibility list. No network needed
    to catch that: it is entirely about which exception is recognised.
    """
    import ssl
    import urllib.error
    from optiscaler import wiki

    print("\nWiki TLS")
    verify_failed = ssl.SSLCertVerificationError(
        "certificate verify failed: unable to get local issuer certificate")
    check("a bare SSLError counts as a tls failure", wiki._is_tls_error(verify_failed))
    check("the URLError urlopen actually raises counts too",
          wiki._is_tls_error(urllib.error.URLError(verify_failed)))
    check("an ordinary network error does not",
          not wiki._is_tls_error(urllib.error.URLError(OSError("unreachable"))))
    check("a timeout does not", not wiki._is_tls_error(TimeoutError()))

    kinds = [kind for kind, _ in wiki._candidate_contexts()]
    check("more than one CA source is tried", len(kinds) > 1, kinds)
    check("an unverified attempt is the last resort, never the first",
          kinds[-1] == "unverified" and kinds[0] != "unverified", kinds)


def check_version_pin():
    """The vendored headers must describe the OptiScaler build actually shipped.

    This is not a formality. The ASI's view of Config is generated from
    asi/optiscaler_ref/Config.h, and the offsets it writes to come from that
    mirror. Vendoring headers from a newer OptiScaler than the release in bin/
    produces a mirror that describes a struct the shipped DLL does not have --
    every validation check then fails and live control silently never attaches.
    That is exactly what happened once already.
    """
    from optiscaler import constants

    print("\nVersion pinning")
    ref = ROOT / "asi" / "optiscaler_ref" / "SOURCE_COMMIT.txt"
    check("vendored OptiScaler headers are recorded", ref.is_file())
    if not ref.is_file():
        return
    text = ref.read_text(encoding="utf-8")
    check("vendored headers name the shipped OptiScaler version",
          f"v{constants.OPTISCALER_VERSION}" in text,
          f"want v{constants.OPTISCALER_VERSION} in SOURCE_COMMIT.txt")
    check("the shipped archive matches the pinned version",
          constants.OPTISCALER_VERSION in constants.PAYLOAD_ARCHIVE,
          constants.PAYLOAD_ARCHIVE)

    # And the archive is the one the hash names. This pins more than OptiScaler
    # itself: the FidelityFX libraries inside it are what decide the FSR
    # versions a game reports, and the panel names the newest one by reading
    # that library rather than by trusting the reference ini, which documents
    # whichever build *it* shipped with (4.0.2, where this carries 4.1.1).
    archive = ROOT / "bin" / constants.PAYLOAD_ARCHIVE
    check("the shipped archive is present", archive.is_file(), str(archive))
    if archive.is_file():
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        check("the shipped archive is the one the hash pins",
              digest == constants.PAYLOAD_SHA256, digest)

    # The header must be the one the mirror was generated from.
    config_h = (ROOT / "asi" / "optiscaler_ref" / "Config.h").read_text(encoding="utf-8")
    mirror = (ROOT / "asi" / "generated" / "config_mirror.h")
    check("the generated mirror is present", mirror.is_file())
    if mirror.is_file():
        members = re.findall(r"^    X\((\w+),", mirror.read_text(encoding="utf-8"), re.M)
        absent = [m for m in members if f" {m} " not in config_h and f" {m};" not in config_h
                  and f" {m}\n" not in config_h]
        check("every mirrored member still exists in the vendored header",
              not absent, absent[:5])

    # 0.9.4-specific: the upscaler ids are strings, not the enum master uses.
    check("the vendored build stores upscalers as strings",
          "CustomOptional<std::string, SoftDefault> Dx12Upscaler" in config_h)


def check_optipatcher():
    """OptiPatcher ships alongside and installs into the same plugin folder."""
    import tempfile
    from optiscaler import constants, live

    print("\nOptiPatcher")
    bundled = ROOT / "bin" / constants.OPTIPATCHER_NAME
    check("optipatcher is bundled", bundled.is_file())
    if bundled.is_file():
        check("bundled optipatcher is a windows dll", bundled.read_bytes()[:2] == b"MZ")
        digest = hashlib.sha256(bundled.read_bytes()).hexdigest()
        check("bundled optipatcher matches the recorded build",
              digest == constants.OPTIPATCHER_SHA256, digest)

    root = Path(tempfile.mkdtemp(prefix="optiscaler-patcher-"))
    try:
        target = root / "game"
        target.mkdir()
        source = root / "fake.asi"
        source.write_bytes(b"MZ fake")
        result = live.install_plugin_asi(str(target), source, constants.OPTIPATCHER_NAME)
        landed = target / live.PLUGIN_SUBDIR / constants.OPTIPATCHER_NAME
        # The README's instructions are: plugins/OptiPatcher.asi plus
        # LoadAsiPlugins=true. The second half is service.install's job.
        check("optipatcher lands in the plugins folder", result["ok"] and landed.is_file())
        check("it sits next to the live-control plugin",
              landed.parent.name == live.PLUGIN_SUBDIR)
        requirements = {(r["section"], r["key"]): r["value"] for r in live.ini_requirements()}
        check("asi loading is switched on for it",
              requirements.get(("Plugins", "LoadAsiPlugins")) == "true", requirements)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def check_asi_wide_formats():
    """No wide format string in the ASI may use a bare %s.

    zig cc builds the plugin against mingw's C99-conformant printf, where "%s"
    in a *wide* format string consumes a char*, not a wchar_t*. Passing a UTF-16
    path to it reads the first byte and stops at the NUL that follows, so
    swprintf(L"%s\\x", path) produced a one-character relative path. Every
    control file then landed in the game's working directory, the plugin looked
    completely dead from outside, and nothing anywhere said why. Use %ls, or
    build the path by concatenation.
    """
    print("\nASI wide format strings")
    source = (ROOT / "asi" / "live.cpp").read_text(encoding="utf-8")
    # Wide literals only: L"..." with no escaped quotes inside is enough here.
    wide = re.findall(r'L"((?:[^"\\]|\\.)*)"', source)
    offenders = [text for text in wide if re.search(r"%[-+ #0-9.]*s", text)]
    check("no wide format string passes a path through %s", not offenders, offenders[:3])
    check("the status file reports the folder the plugin chose",
          '"dir %s\\n"' in source)
    check("control paths are built without printf", "JoinPath(g_statusPath" in source)

    built = ROOT / "bin" / "decky_optiscaler_live.asi"
    check("the built plugin is present", built.is_file())
    if built.is_file():
        data = built.read_bytes()
        check("the built plugin is a windows dll", data[:2] == b"MZ")
        # If a wide format ever comes back, so does this import.
        check("the built plugin no longer pulls in wide printf",
              b"__stdio_common_vfwprintf" not in data)
        check("the built plugin still exports what OptiScaler calls",
              b"InitializeASI" in data)


def check_asi_backend_layout():
    """The ASI's model of State::changeBackend must match the vendored headers.

    This is the check the upscaler switch did not have, and its absence cost
    the feature entirely. The first implementation looked for "a vector-shaped
    triple with 0.8f somewhere in the following 80 bytes" and kept the last
    match -- but unordered_dense's table holds *two* vectors, m_values and
    m_buckets, and m_buckets is both within that window and later. Every run
    latched onto m_buckets, so State::newBackend was searched for 24 bytes past
    where it lives, never validated, and the plugin reported "newBackend not
    located; cannot switch upscaler" for the whole session. Frame generation
    went on working, which is why it read as "the upscaler switch is broken"
    rather than as a discovery failure.

    So: the layout is mirrored in live.cpp with static_asserts (the compiler
    checks those at build time), and what is checked here is that the vendored
    headers still say what the mirror assumes.
    """
    print("\nASI backend map layout")
    ref = ROOT / "asi" / "optiscaler_ref"
    source = (ROOT / "asi" / "live.cpp").read_text(encoding="utf-8")

    ud = ref / "unordered_dense.h"
    check("the pinned unordered_dense header is vendored", ud.is_file())
    if ud.is_file():
        text = ud.read_text(encoding="utf-8")
        # Only detail::table -- segmented_vector, declared earlier in the same
        # header, has members of its own that would otherwise be picked up.
        body = text[text.index("class table :"):]
        # The member order is the layout: m_values first (so the map's address
        # is its value vector's address), m_buckets second, then the load
        # factor the mirror anchors on and the shift count it cross-checks.
        members = re.findall(
            r"^\s+(?:value_container_type|bucket_container_type|size_t|float|Hash|KeyEqual|uint8_t)"
            r"\s+(m_\w+)",
            body, re.M)
        check("the table's member order is the one live.cpp mirrors",
              members[:6] == ["m_values", "m_buckets", "m_max_bucket_capacity",
                              "m_max_load_factor", "m_hash", "m_equal"],
              members[:6])
        check("m_shifts is the table's last member", "m_shifts" in members[6:7], members[:8])
        check("the default load factor is still 0.8",
              "default_max_load_factor = 0.8F" in text)
        check("the initial shift count is still 64 - 2",
              "initial_shifts = 64 - 2" in text)
        check("the default bucket is still two uint32s",
              re.search(r"struct standard\s*\{[^}]*uint32_t m_dist_and_fingerprint;"
                        r"[^}]*uint32_t m_value_idx;", text, re.S) is not None)

    state_h = (ref / "State.h").read_text(encoding="utf-8")
    # newBackend is located as "one table past changeBackend", and frameCount as
    # the eight bytes in front of it. Both are declaration-order facts.
    order = re.search(
        r"UINT64 frameCount = 0;\s*"
        r"(?://[^\n]*\n\s*)*"
        r"ankerl::unordered_dense::map<unsigned int, bool> changeBackend;\s*"
        r"std::string newBackend",
        state_h)
    check("frameCount, changeBackend and newBackend are still declared together",
          order is not None)

    # The mirror itself. These are compiled as static_asserts, so their presence
    # is what matters; the build fails if any of them stops holding.
    for text, why in (
        ("sizeof(ud_table) == 64", "the table size newBackend's offset depends on"),
        ("offsetof(ud_table, m_max_load_factor) == 56", "the load-factor anchor"),
        ("offsetof(ud_table, m_buckets) == 24", "the bucket vector"),
        ("sizeof(backend_entry) == 8", "the pair stride the overlay walks"),
        ("offsetof(backend_entry, changed) == 4", "the bool the switch writes"),
    ):
        check(f"live.cpp pins {why}", f"static_assert({text}," in source, text)

    # The regression itself: identification must not go back to hunting for a
    # constant in a window, and newBackend must be part of identifying the map
    # rather than something guessed at afterwards.
    check("the load factor is checked at its exact offset, not scanned for",
          "t->m_max_load_factor != kMaxLoadFactor" in source)
    check("newBackend is what tells changeBackend from State's other maps",
          "return LooksLikeNewBackend((const msvc_string*) (t + 1));" in source)
    check("locating the map and the string is one indivisible step",
          "g_newBackend = found.newBackend;" in source)


def _state_members():
    """The members `class State` declares, in order, from the vendored header.

    Declaration order is layout order, which is the whole basis for the mirrors
    in live.cpp: a member inserted, removed or reordered upstream moves every
    offset after it. Functions and the private tail are skipped; everything else
    that ends in a semicolon at class scope is a member.
    """
    text = (ROOT / "asi" / "optiscaler_ref" / "State.h").read_text(encoding="utf-8")
    body = text[text.index("class State"):]
    body = body[:body.index("\n  private:")]
    names = []
    for raw in body.splitlines():
        if not raw.startswith("    ") or raw.startswith("     "):
            continue
        line = raw.strip()
        if not line.endswith(";") or "(" in line:
            continue
        if line.startswith(("//", "static", "using", "typedef", "return", "friend")):
            continue
        head = re.split(r"\s*=|\s*\{", line)[0].rstrip(";").strip()
        tokens = re.findall(r"[A-Za-z_]\w*", head)
        if tokens:
            names.append(tokens[-1])
    return names


def _mirror_members(source, name):
    """The members of one `struct <name>` in live.cpp, in declaration order."""
    start = source.index(f"struct {name} {{")
    body = source[start:source.index("\n};", start)]
    return re.findall(r"^    [\w:*<>, ]+?\s(\w+)(?:\[\d+\])?;\s*(?://.*)?$", body, re.M)


def check_asi_state_layout():
    """The ASI's model of State must match the vendored header, member for member.

    Two things are located by walking out from an object the scan can identify:
    State::FGchanged and State::SCchanged, 21 and 20 bytes in front of
    CapturedHudlesses, and State::ffxFGVersionNames, a computed distance past
    changeBackend. Both distances come from the compiler, out of structs in
    live.cpp that mirror the declaration runs -- so what has to be checked here
    is that the header still declares those runs the way the mirrors say.

    This matters more than the offsets themselves: FGchanged is written to. A
    member inserted upstream would move it, every static_assert would still
    hold (they are about the mirror, not the header), and the plugin would set a
    byte in the middle of something else. The version pin makes that impossible
    in a shipped build; this makes it impossible to miss when the pin moves.
    """
    print("\nASI State layout")
    source = (ROOT / "asi" / "live.cpp").read_text(encoding="utf-8")
    declared = _state_members()
    check("State's members can be read out of the vendored header",
          len(declared) > 100, len(declared))

    for struct in ("state_head", "state_fg_block", "state_tail"):
        mirrored = _mirror_members(source, struct)
        check(f"live.cpp declares a {struct} mirror", bool(mirrored), mirrored)
        if not mirrored:
            continue
        if mirrored[0] not in declared:
            check(f"{struct} starts at a member State still has", False, mirrored[0])
            continue
        at = declared.index(mirrored[0])
        # The run has to match exactly: a member inserted anywhere inside it
        # shifts everything the mirror computes an offset for.
        check(f"{struct} mirrors State's declaration run exactly",
              declared[at:at + len(mirrored)] == mirrored,
              declared[at:at + len(mirrored)])

    # The mirrors reproduce sizes as well as order, so the few declarations
    # whose *type* the offsets depend on are pinned here too.
    state_h = (ROOT / "asi" / "optiscaler_ref" / "State.h").read_text(encoding="utf-8")
    for text, why in (
        ("bool FGchanged = false;", "the flag the FFX FG switch raises"),
        ("bool SCchanged = false;", "the flag that makes the context rebuild"),
        ("size_t FGcapturedResourceCount = false;", "the one non-bool in that run"),
        ("ankerl::unordered_dense::map<void*, CapturedHudlessInfo> CapturedHudlesses;",
         "the table the flags are found relative to"),
        ("uint64_t NVNGX_ApplicationId = 1337;", "the value that confirms that table"),
        ("std::vector<const char*> ffxFGVersionNames {};", "the FFX FG version names"),
        ("std::vector<uint64_t> ffxFGVersionIds {};", "the ids declared beside them"),
        ("std::vector<const char*> ffxUpscalerVersionNames {};",
         "the FSR versions, the only place the exact one is written down"),
        ("std::vector<uint64_t> ffxUpscalerVersionIds {};",
         "the ids declared beside those"),
        ("std::deque<double> upscaleTimes;", "the first deque the tail steps over"),
        ("std::deque<double> frameTimes;", "the second"),
        ("double lastFGFrameTime = 0.0;", "the frame-generation hook's interval"),
        ("double presentFrameTime = 0.0;", "the wrapped swapchain's interval"),
    ):
        check(f"State still declares {why}", text in state_h, text)

    check("captured_hudless_info is still a counter, a UINT and a bool",
          re.search(r"typedef struct CapturedHudlessInfo\s*\{\s*UINT64 usageCount[^}]*"
                    r"UINT captureInfo[^}]*bool enabled", state_h, re.S) is not None)

    # Compiled assertions; their presence is what matters, the build enforces them.
    for text, why in (
        ("offsetof(state_head, DeviceAdapterNames) == 104", "where the search for the table starts"),
        ("FG_BLOCK_OFF(FGchanged) == -21", "how far in front of the table the flag sits"),
        ("FG_BLOCK_OFF(SCchanged) == -20", "the flag beside it"),
        ("FG_BLOCK_OFF(NVNGX_ApplicationId) == 72", "the value that confirms the table"),
        ("offsetof(state_tail, ffxFGVersionNames) == 256", "where the version list sits"),
        ("offsetof(state_tail, ffxUpscalerVersionNames) == 208",
         "where the FSR version list sits"),
        ("offsetof(state_tail, lastFGFrameTime) == 400", "where the frame intervals sit"),
        ("sizeof(msvc_deque_raw) == 32", "the width of the deques the tail steps over"),
        ("sizeof(hudless_entry) == 24", "the stride the table's elements are checked at"),
    ) :
        check(f"live.cpp pins {why}", f"static_assert({text}," in source, text)

    # The flags are written, so identification has to be unambiguous or refused.
    check("an ambiguous table means the flags stay unlocated",
          "if (matches != 1) {" in source, "FindFgFlags")
    check("the search is bounded by two objects already identified",
          "offsetof(state_head, DeviceAdapterNames) + sizeof(ud_table)" in source
          and "unsigned char* last = (unsigned char*) map->table;" in source)
    check("nothing is written when the flags were not found",
          'snprintf(g_error, sizeof(g_error),\n                 "FGchanged/SCchanged not located' in source)

    # The overlay's own "Change FG" button is what this copies; if OptiScaler
    # ever stops doing all three writes, so should we.
    menu = (ROOT / "asi" / "optiscaler_ref" / "menu_common.cpp").read_text(encoding="utf-8")
    check("the overlay's Change FG button is still config, then both flags",
          re.search(r'ImGui::Button\("Change FG"\).*?config->FfxFGIndex = _ffxFGIndex;\s*'
                    r'state\.FGchanged = true;\s*state\.SCchanged = true;', menu, re.S) is not None)
    # And the same for the FFX upscaler, whose button is the ordinary upscaler
    # switch pointed at the backend that is already running: the index into
    # Config, then a rebuild. This plugin leaves newBackend empty instead of
    # naming the current backend, because ChangeFeature reads that as "use
    # whatever Config holds for this API" -- which is the same rebuild by a
    # route that cannot pick the wrong graphics API.
    check("the overlay's FFX Change Upscaler is still config, then a rebuild",
          re.search(r'ImGui::Button\("Change Upscaler"\).*?'
                    r'config->FfxUpscalerIndex = _ffxUpscalerIndex;\s*'
                    r'state\.newBackend = currentBackend;\s*'
                    r'MARK_ALL_BACKENDS_CHANGED\(\);', menu, re.S) is not None)
    # What lets this plugin leave newBackend alone: every provider reads an
    # empty one as "use Config", and clears it again after a rebuild, so an
    # empty one is also the normal resting state.
    for provider in ("Dx12", "Dx11", "Vk"):
        text = (ROOT / "asi" / "optiscaler_ref" / f"FeatureProvider_{provider}.cpp") \
            .read_text(encoding="utf-8")
        check(f"an empty newBackend still means \u201cuse Config\u201d on {provider}",
              'State::Instance().newBackend == ""' in text)
        check(f"and {provider} still clears it once the rebuild succeeded",
              'State::Instance().newBackend = "";' in text)

    config_cpp = (ROOT / "asi" / "optiscaler_ref" / "Config.cpp").read_text(encoding="utf-8")
    check("FfxFGIndex is still the ini's [FSR] FGIndex",
          'FfxFGIndex.set_from_config(readInt("FSR", "FGIndex"))' in config_cpp)
    check("FfxUpscalerIndex is still the ini's [FSR] UpscalerIndex",
          'FfxUpscalerIndex.set_from_config(readInt("FSR", "UpscalerIndex"))' in config_cpp)

    # There are two intervals and one counter, and which hook writes which is
    # deliberately *not* relied on: reading these two files says presentFrameTime
    # is the presented side, and on a real Deck running FSR-FG the numbers said
    # the opposite. What is checked here is only that both writers still exist
    # and that the counter still moves with one of them -- `live._frame_rates`
    # works out which from the values themselves.
    swapchain = (ROOT / "asi" / "optiscaler_ref" / "wrapped_swapchain.cpp") \
        .read_text(encoding="utf-8")
    check("presentFrameTime is still timed in the wrapped swapchain",
          "State::Instance().presentFrameTime = ftDelta;" in swapchain)
    check("and the frame counter still ticks beside it",
          "State::Instance().frameCount = _frameCounter;" in swapchain)
    fg_hooks = (ROOT / "asi" / "optiscaler_ref" / "FG_Hooks.cpp").read_text(encoding="utf-8")
    check("lastFGFrameTime is still timed in the frame-generation hook",
          "State::Instance().lastFGFrameTime = ftDelta;" in fg_hooks
          and "State::Instance().FGPresentIsCalled = true;" in fg_hooks)
    # OptiScaler's own overlay derives the pair the same way round this now
    # does: one measured rate, and the other from a ratio.
    menu = (ROOT / "asi" / "optiscaler_ref" / "menu_common.cpp").read_text(encoding="utf-8")
    check("the overlay still shows one rate divided into two",
          "frameRate / (float) (fg->GetInterpolatedFrameCount() + 1)" in menu)


def check_auto_plan():
    """Reading a wiki entry back out as instructions.

    The compatibility list is community prose, not a specification, so the whole
    value of automatic set-up rests on two properties: what it takes is real,
    and what it cannot take is reported rather than dropped. Both are checked
    here against the shapes real entries actually have — every fixture below is
    lifted from a live entry on the list.
    """
    from optiscaler import autoplan

    print("\nAutomatic set-up plan")

    def plan_for(**recommendation):
        base = {"matched": True, "game": "Test Game", "filename": "dxgi.dll",
                "filename_source": "wiki entry", "optipatcher": False,
                "compatibility": "✅", "notes": None, "detail": {}}
        base.update(recommendation)
        return autoplan.build(base)

    check("no match means no plan", not autoplan.build({"matched": False})["available"])
    check("no recommendation at all is survivable", not autoplan.build(None)["available"])

    # -- ini settings mined out of prose ---------------------------------
    plan = plan_for(detail={"Settings": "`Dxgi=false` since spoofing isn't required to see "
                                        "DLSS inputs _(autoapplied by Opti)_"})
    check("a setting the wiki states is taken",
          [(s["section"], s["key"], s["value"]) for s in plan["settings"]]
          == [("Spoofing", "Dxgi", "false")], plan["settings"])
    check("each setting says which part of the entry asked for it",
          plan["settings"][0]["source"] == "wiki entry, “Settings”")

    plan = plan_for(detail={"Settings": "`DontCreateD3D12DeviceForLuma=true`"})
    check("a key that is not an OptiScaler setting is refused",
          not plan["settings"] and plan["unresolved"], plan)
    check("and is reported rather than dropped",
          "DontCreateD3D12DeviceForLuma" in plan["unresolved"][0]["text"])

    # A dozen key names exist in several sections. Guessing one would write a
    # real setting the wiki never asked for, in the wrong place.
    plan = plan_for(detail={"Settings": "`Enabled = true`"})
    check("a key name several sections share is not guessed at",
          not plan["settings"] and "ambiguous" in plan["unresolved"][0]["text"],
          plan["unresolved"])
    plan = plan_for(detail={"Settings": "`[OutputScaling]` `Enabled = true` `Multiplier = 2.0`"})
    check("a stated section resolves the same key",
          ("OutputScaling", "Enabled", "true") in
          [(s["section"], s["key"], s["value"]) for s in plan["settings"]], plan["settings"])
    # A real entry, quoting the pre-0.9 layout: [OptiFG] had an Enabled key and
    # no longer does. Resolving it to some other section's Enabled would write a
    # setting nobody asked for, so it has to fail and say so.
    plan = plan_for(detail={"Settings": "[FrameGen] `FGType = optifg` [OptiFG] `Enabled = true`"})
    check("a section that no longer has that key is not quietly re-homed",
          not any(item["key"] == "Enabled" for item in plan["settings"]), plan["settings"])

    plan = plan_for(detail={"Settings": "`Dx12Upscaler = fsr31` had the highest performance"})
    check("the upscaler is left to the user even when an entry names one",
          not plan["settings"], plan["settings"])
    plan = plan_for(detail={"Settings": "`Sharpness = 9.5`"})
    check("a value outside the option's range is refused",
          not plan["settings"] and plan["unresolved"], plan)
    plan = plan_for(detail={"Settings": "`ShortcutKey=0x24`"})
    check("a hex key code is a valid keycode",
          [(s["key"], s["value"]) for s in plan["settings"]] == [("ShortcutKey", "0x24")],
          plan["settings"])

    # -- launch options --------------------------------------------------
    plan = plan_for(notes="Use -dx12 launch option.")
    check("a launch flag the wiki asks for is picked up", plan["launch_flags"] == ["-dx12"])
    check("and lands after %command%, where the game's own arguments go",
          plan["launch_options"] == 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx12',
          plan["launch_options"])
    # This one read as an instruction for every Luma Unreal Engine entry.
    plan = plan_for(detail={"Known Issues": "If seeing the non-DX11 device error, set ..."})
    check("a flag spelled inside a word is not an instruction",
          plan["launch_flags"] == [], plan["launch_flags"])
    plan = plan_for(notes="Don't use -dx12, the DX11 renderer is the working one.")
    check("a flag the entry warns against is not applied",
          plan["launch_flags"] == [], plan["launch_flags"])
    plan = plan_for(filename="OptiScaler.asi")
    check("an .asi build needs no dll override",
          plan["launch_options"] == "%command%", plan["launch_options"])

    # -- frame generation ------------------------------------------------
    plan = plan_for(detail={"FG Inputs": "DLSSG via Streamline"})
    check("the recommended FG input becomes an ini value",
          (plan["framegen"]["input"], plan["framegen"]["output"]) == ("dlssg", "fsrfg"),
          plan["framegen"])
    check("and is labelled the way OptiScaler's overlay labels it",
          plan["framegen"]["input_label"] == "DLSSG via Streamline")
    # "Nukem's DLSSG" contains "DLSSG", so order of matching decides this one.
    plan = plan_for(detail={"FG Inputs": "Nukem's DLSSG"})
    check("Nukem's is not mistaken for Streamline DLSSG",
          plan["framegen"]["input"] == "nukems", plan["framegen"])
    plan = plan_for(detail={"FG-Settings": "OptiFG (Upscaler) -> XeFG"})
    check("an arrow states the output as well as the input",
          (plan["framegen"]["input"], plan["framegen"]["output"]) == ("upscaler", "xefg"),
          plan["framegen"])
    plan = plan_for(detail={"FG Inputs": "None"})
    check("an entry reporting no working FG says so rather than picking one",
          plan["framegen"]["input"] == "nofg", plan["framegen"])
    check("and that produces no FG changes to apply",
          autoplan.framegen_changes(plan) == [], autoplan.framegen_changes(plan))
    plan = plan_for(detail={"Notes": "FSR3.1 inputs cannot be hooked."})
    check("a passing mention of FG is not a recommendation",
          plan["framegen"] is None, plan["framegen"])

    # -- the whole thing -------------------------------------------------
    plan = plan_for(
        game="007 First Light", filename="dxgi.dll", optipatcher=True,
        notes="Use -dx12 launch option.",
        detail={
            "FG Inputs": "DLSSG via Streamline",
            "Known Issues": "`Dxgi=false` to disable spoofing. "
                            "`RestoreComputeSignature=true` for DLSS inputs.",
        })
    check("a complete entry produces a complete plan",
          plan["available"] and plan["optipatcher"] and plan["source"] == "wiki entry"
          and plan["launch_flags"] == ["-dx12"] and plan["framegen"]["input"] == "dlssg"
          and len(plan["settings"]) == 2, plan)
    changes = autoplan.setting_changes(plan) + autoplan.framegen_changes(plan)
    check("every planned change is a writable ini change",
          all(set(c) == {"section", "key", "value"} for c in changes) and len(changes) == 4,
          changes)
    check("known issues are surfaced as a warning to read them",
          any("known issues" in w.lower() for w in plan["warnings"]), plan["warnings"])


def check_reframework():
    """The games that cannot host OptiScaler without REFramework.

    Nine entries on the compatibility list say, in prose, that OptiScaler does
    nothing in this game unless REFramework is already in the folder — and for
    three releases the plugin read straight past it. Those games got an install
    that reported success, set the launch options, and changed nothing on
    screen, which is the worst failure available because there is no error
    anywhere to go looking for.

    Everything below is driven by the text real entries actually carry.
    """
    from optiscaler import autoplan, reframework
    from optiscaler.constants import REFRAMEWORK_DLL, REFRAMEWORK_PD_ASSETS

    print("\nREFramework")

    def plan_for(**recommendation):
        base = {"matched": True, "game": "Test Game", "filename": "dxgi.dll",
                "filename_source": "wiki entry", "optipatcher": False,
                "compatibility": "✅", "notes": None, "detail": {}}
        base.update(recommendation)
        return autoplan.build(base)

    # -- reading the requirement out of the entry ------------------------
    plan = plan_for(game="Monster Hunter Wilds",
                    notes="Requires REFramework, set Dxgi=false in the OptiScaler.ini "
                          "to avoid crashes.")
    ref = plan["reframework"]
    check("a list row stating the requirement is read as one", bool(ref), plan["reframework"])
    check("praydog's unified nightly is the default build",
          ref["variant"] == "nightly" and ref["asset"] == "REFramework.zip", ref)
    check("and it can be fetched without help", ref["automatic"], ref)
    check("the entry that said so is cited", "notes" in ref["source"].lower(), ref["source"])

    # The pd entries name a different mod that happens to share a filename.
    plan = plan_for(game="Resident Evil 2 (2019)",
                    notes="Requires REFramework (pd-upscaler branch) + PDUpscaler plugin "
                          "+ OptiScaler, check Wiki")
    ref = plan["reframework"]
    check("an entry naming the pd-upscaler branch gets the pd build",
          ref["variant"] == "pd-upscaler" and ref["asset"] == "RE2.zip", ref)
    check("and is told it needs UpscalerBasePlugin as well",
          ref["plugin"] == "PDPerfPlugin.dll" and ref["plugin_url"], ref)
    check("which is reported as the user's job, since Nexus needs a login",
          any("Nexus" in w for w in plan["warnings"]), plan["warnings"])

    plan = plan_for(game="Devil May Cry 5",
                    notes="Requires REFramework PDUpscaler branch + PDPerfPlugin mod and "
                          "carefully reading the compatibility entry")
    check("the branch spelled without a hyphen is the same branch",
          plan["reframework"]["asset"] == "DMC5.zip", plan["reframework"])

    # The detail page states it a different way than the list row does.
    plan = plan_for(game="Resident Evil 8 Village", detail={
        "Notes": "To get OptiScaler to work with REFramework + UpscalerBasePlugin: "
                 "Download REFramework's pd-upscaler branch."})
    check("the wiki page's phrasing is read too",
          plan["reframework"]["variant"] == "pd-upscaler", plan["reframework"])

    # -- what must not be read as a requirement --------------------------
    # These sentences are on the same pages, about the same mod, and none of
    # them is an instruction to install anything.
    for text in ("XeFG seems to disable the REF overlay",
                 "REF + XeFG currently cause heavy intermittent stuttering",
                 "Might also have to disable Vignette through REF (under Camera options)",
                 "OptiScaler depends on REF bypassing the anti-modding DRM"):
        check("a passing mention of REF is not a requirement",
              plan_for(detail={"Known Issues": text})["reframework"] is None, text)
    check("and an entry that no longer needs it is not given it anyway",
          plan_for(notes="This no longer requires REFramework as of 0.9.")["reframework"]
          is None)
    check("a game the entry says nothing about gets nothing",
          plan_for(notes="Use -dx12 launch option.")["reframework"] is None)

    # -- Proton's half, which the wiki never mentions ---------------------
    # The wiki is written for Windows, where the game folder wins. On Proton it
    # does not: REFramework's dll needs an override of its own or the mod sits
    # in the folder doing nothing, and following the entry to the letter is
    # exactly how that happens.
    plan = plan_for(game="PRAGMATA", notes="Requires REFramework to work.")
    check("REFramework gets a WINEDLLOVERRIDES entry of its own",
          plan["launch_options"] == 'WINEDLLOVERRIDES="dxgi=n,b;dinput8=n,b" %command%',
          plan["launch_options"])
    plan = plan_for(game="PRAGMATA", notes="Requires REFramework to work. Use -dx12.")
    check("and the game's own arguments still land after %command%",
          plan["launch_options"].endswith("%command% -dx12"), plan["launch_options"])
    check("a game with no REFramework requirement is unchanged",
          plan_for()["launch_options"] == 'WINEDLLOVERRIDES="dxgi=n,b" %command%')
    # -- a game with no known build --------------------------------------
    plan = plan_for(game="Some Unlisted RE Engine Game",
                    notes="Requires REFramework (pd-upscaler branch) to work.")
    ref = plan["reframework"]
    check("a pd game with no known asset refuses rather than guessing one",
          ref["required"] and not ref["automatic"] and ref["asset"] is None, ref)
    check("and says where to get it by hand", ref["page"] and ref["reason"], ref)
    check("which is raised as a warning, not buried",
          any("REFramework" in w for w in plan["warnings"]), plan["warnings"])

    # -- the archive is unpacked by name, never on trust -------------------
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        archive = root / "REFramework.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("dinput8.dll", b"REF" * 100)
            zf.writestr("reframework_revision.txt", "abc123")
            zf.writestr("readme.txt", "not ours")
            zf.writestr("../../evil.dll", b"nope")
            zf.writestr("nested/dinput8.dll", b"a second one")
        taken = reframework._extract(archive, root / "out")
        check("the files REFramework ships are taken",
              sorted(taken) == ["dinput8.dll", "reframework_revision.txt"], taken)
        check("and nothing else in the archive is",
              not (root / "out" / "readme.txt").exists()
              and sorted(p.name for p in (root / "out").iterdir())
              == ["dinput8.dll", "reframework_revision.txt"],
              sorted(p.name for p in (root / "out").iterdir()))
        check("a path that climbs out of the folder lands nowhere",
              not (root.parent / "evil.dll").exists() and not (root / "evil.dll").exists())
        check("the first copy of a name wins, so a nested one cannot overwrite it",
              (root / "out" / "dinput8.dll").read_bytes() == b"REF" * 100)

        empty = root / "empty.zip"
        with zipfile.ZipFile(empty, "w") as zf:
            zf.writestr("something_else.dll", b"x")
        try:
            reframework._extract(empty, root / "out2")
            check("an archive without the dll is refused", False, "no error raised")
        except ValueError as exc:
            check("an archive without the dll is refused", REFRAMEWORK_DLL in str(exc), exc)

    # -- installing it, and taking it back out ---------------------------
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        game = root / "game"
        game.mkdir()
        payload = root / "payload"
        payload.mkdir()
        (payload / "OptiScaler.dll").write_bytes(b"OptiScaler" + b"\0" * (5 << 20))
        (payload / INI_NAME).write_text("[Upscalers]\nDx12Upscaler=auto\n")
        source = root / "ref"
        source.mkdir()
        (source / REFRAMEWORK_DLL).write_bytes(b"the REFramework build")
        # The game already ships a dinput8 of its own, which is the case the
        # whole backup contract exists for.
        (game / REFRAMEWORK_DLL).write_bytes(b"the game's own dinput8")

        result = installer.install(str(game), str(payload), "dxgi.dll", False, None,
                                   None, None, [source / REFRAMEWORK_DLL])
        check("REFramework lands next to the executable",
              result["reframework"]["installed"]
              and (game / REFRAMEWORK_DLL).read_bytes() == b"the REFramework build", result)
        check("and the game's own file is set aside rather than lost",
              REFRAMEWORK_DLL in result["backups"], result["backups"])
        found = installer.detect(str(game))
        check("detect reports it, and that we are the ones who installed it",
              found["reframework"]["installed"] and found["reframework"]["managed"], found)

        installer.uninstall(str(game))
        check("removing OptiScaler removes REFramework with it",
              (game / REFRAMEWORK_DLL).read_bytes() == b"the game's own dinput8",
              (game / REFRAMEWORK_DLL).read_bytes())

    # -- adding it to a game already set up -------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        game = root / "game"
        game.mkdir()
        payload = root / "payload"
        payload.mkdir()
        (payload / "OptiScaler.dll").write_bytes(b"OptiScaler" + b"\0" * (5 << 20))
        (payload / INI_NAME).write_text("[Upscalers]\nDx12Upscaler=auto\n")
        installer.install(str(game), str(payload), "dxgi.dll", False)
        source = root / "ref"
        source.mkdir()
        (source / REFRAMEWORK_DLL).write_bytes(b"added later")

        added = installer.add_files(str(game), [source / REFRAMEWORK_DLL])
        check("REFramework can be added without reinstalling OptiScaler",
              added["ok"] and (game / REFRAMEWORK_DLL).is_file(), added)
        manifest = installer.read_manifest(game)
        check("and joins the manifest, so it is removed with everything else",
              REFRAMEWORK_DLL in manifest["files"] and manifest["reframework"], manifest)
        installer.uninstall(str(game))
        check("which it is", not (game / REFRAMEWORK_DLL).exists())

    # -- the curated asset table ------------------------------------------
    seed = json.loads((ROOT / "defaults" / "compat-list.json").read_text())
    keys = {entry["key"] for entry in seed["entries"]}
    unknown = sorted(k for k in REFRAMEWORK_PD_ASSETS if k not in keys)
    check("every curated asset key is a real compatibility-list entry",
          not unknown, unknown)

    # The point of the whole feature: the games on the real list that need it
    # are found, and no others are.
    found = {}
    for entry in seed["entries"]:
        recommendation = dict(entry, matched=True, game=entry["name"], detail={},
                              filename="dxgi.dll", filename_source="x")
        ref = autoplan.build(recommendation)["reframework"]
        if ref:
            found[entry["name"]] = ref["variant"]
    check("the whole bundled list yields exactly the entries that ask for it",
          sorted(found) == [
              "Devil May Cry 5", "Monster Hunter Wilds", "PRAGMATA",
              "Resident Evil 2 (2019)", "Resident Evil 3 (2020)",
              "Resident Evil 4 (2023)", "Resident Evil 7 Biohazard",
              "Resident Evil 8 Village", "Resident Evil 9 Requiem",
          ], sorted(found))
    check("with the right build for each",
          [found[name] for name in sorted(found)] ==
          ["pd-upscaler", "nightly", "nightly", "pd-upscaler", "pd-upscaler",
           "pd-upscaler", "pd-upscaler", "pd-upscaler", "nightly"], found)
    check("and every automatic one resolves to an asset",
          all(autoplan.build(dict(e, matched=True, game=e["name"], detail={},
                                  filename="dxgi.dll", filename_source="x"))
              ["reframework"]["asset"]
              for e in seed["entries"] if e["name"] in found))


def check_parenthesised_pages():
    """A wiki page name with brackets in it has to survive being parsed.

    `[Resident Evil 2 (2019)](Resident-Evil-2-(2019))` is an ordinary row on the
    compatibility list, and a link target of `[^)]+` stops at the inner bracket:
    the page came out as "Resident-Evil-2-(2019", the wiki does not serve that,
    and the detail page for every parenthesised title silently never downloaded.
    Those are exactly the Resident Evil entries whose settings and REFramework
    instructions live on the page rather than in the notes column.
    """
    from optiscaler import wiki as wiki_mod

    print("\nParenthesised wiki pages")
    markdown = (
        "| Game | Compatibility | FG Inputs | OptiPatcher | Notes |\n"
        "|---|---|---|---|---|\n"
        "| [Resident Evil 2 (2019)](Resident-Evil-2-(2019)) | ✅ | DLSS |  | Requires REF |\n"
        "| [AI Limit](AI-Limit) | ✅ | DLSS |  |  |\n"
    )
    entries = {e["name"]: e for e in wiki_mod.parse_compat_list(markdown)}
    check("a page name carrying brackets is kept whole",
          entries["Resident Evil 2 (2019)"]["page"] == "Resident-Evil-2-(2019)",
          entries["Resident Evil 2 (2019)"]["page"])
    check("and an ordinary one is unaffected",
          entries["AI Limit"]["page"] == "AI-Limit", entries["AI Limit"]["page"])
    check("the game's own name keeps its brackets too",
          "Resident Evil 2 (2019)" in entries)

    seed = json.loads((ROOT / "defaults" / "compat-list.json").read_text())
    truncated = [e["name"] for e in seed["entries"]
                 if e["page"] and e["page"].count("(") != e["page"].count(")")]
    check("the bundled seed has no half-a-bracket page names left",
          not truncated, truncated)


def check_library_labels():
    """Only the SD card is called an SD card.

    The label used to be a path test — anything under /run/media, or with
    "mmcblk" anywhere in the string — so every USB stick and external SSD came
    back as "SD Card". It is now the mount's own block device, which is the only
    thing that actually knows, and this fakes /proc/mounts to drive it.
    """
    print("\nLibrary labels")
    from optiscaler.service import OptiScalerService

    mounts = {
        "/": "/dev/nvme0n1p8",                 # internal SSD, as on most Decks
        "/run/media/mmcblk0p1": "/dev/mmcblk0p1",   # the SD card
        "/run/media/deck/USB": "/dev/sda1",         # a USB stick
        "/run/media/deck/EXT": "/dev/nvme1n1p1",    # an external NVMe drive
        "/home/deck": "/dev/nvme0n1p8",
    }

    def fake_device(path):
        path = str(path)
        best, best_len = None, -1
        for mount, device in mounts.items():
            if path == mount or path.startswith(mount.rstrip("/") + "/"):
                if len(mount) > best_len:
                    best, best_len = device, len(mount)
        return best

    service = OptiScalerService.__new__(OptiScalerService)
    service.home = Path("/home/deck")
    original = OptiScalerService._mount_device
    OptiScalerService._mount_device = staticmethod(fake_device)
    try:
        card = service._library_label("/run/media/mmcblk0p1/steamapps/common")
        usb = service._library_label("/run/media/deck/USB/games")
        ext = service._library_label("/run/media/deck/EXT/games")
        internal = service._library_label("/home/deck/.local/share/Steam")
        check("the sd card is called an sd card", card.startswith("SD Card"), card)
        check("a usb stick is not", not usb.startswith("SD Card"), usb)
        check("nor is an external ssd", not ext.startswith("SD Card"), ext)
        check("internal storage is still internal", internal == "Internal Storage", internal)

        # The 64GB Deck boots from eMMC, so its internal drive is an mmcblk
        # device too - being MMC cannot be the whole test.
        mounts["/"] = "/dev/mmcblk0p8"
        mounts["/run/media/mmcblk1p1"] = "/dev/mmcblk1p1"
        emmc_root = service._library_label("/run/media/mmcblk0p1/steamapps/common")
        real_card = service._library_label("/run/media/mmcblk1p1/steamapps/common")
        check("the drive the system booted from is never the card",
              not emmc_root.startswith("SD Card"), emmc_root)
        check("the other mmc drive still is", real_card.startswith("SD Card"), real_card)
    finally:
        OptiScalerService._mount_device = original

    check("partition suffixes are stripped from either drive naming scheme",
          (OptiScalerService._disk_name("/dev/mmcblk0p1"),
           OptiScalerService._disk_name("/dev/nvme0n1p8"),
           OptiScalerService._disk_name("/dev/sda2")) == ("mmcblk0", "nvme0n1", "sda"))


def check_option_validation():
    """Values the config writer accepts, for the keys whose list is not fixed.

    A write the writer refuses is dropped *and* never pushed to the running
    game, and the panel is left showing a choice that reached neither. That is
    only correct when the refusal is: FSR.FGIndex is documented in the shipped
    ini as the two generators the reference build had, but each game's
    FidelityFX runtime reports its own list, and the plugin lists what the game
    reports. Validating a pick against the ini's two entries therefore refused
    every generator past the second one that a game actually offered.

    FSR.UpscalerIndex is the same snapshot one step over -- the ini names the
    three FSR versions the reference build shipped, and the game in the
    screenshot this was written from reports 4.1.1, which is in none of them.
    """
    from optiscaler.live import FFX_FG_MAX, FFX_UPSCALER_MAX
    from optiscaler.schema import SCHEMA, valid

    print("\nOption validation")

    fg_index = SCHEMA[("FSR", "FGIndex")]
    check("the reference ini only documents two FFX generators",
          fg_index["options"] == ["0", "1"], fg_index["options"])
    check("but a third one the game reports is accepted", valid(fg_index, "2"))
    check("up to the ceiling the live channel enforces",
          valid(fg_index, str(FFX_FG_MAX - 1)) and not valid(fg_index, str(FFX_FG_MAX)))
    check("an index that is not one is still refused",
          not valid(fg_index, "-1") and not valid(fg_index, "fsr"))
    check("auto still means auto", valid(fg_index, "auto"))

    ups_index = SCHEMA[("FSR", "UpscalerIndex")]
    check("the reference ini only documents three FSR versions",
          ups_index["options"] == ["0", "1", "2"], ups_index["options"])
    check("but a fourth the game reports is accepted", valid(ups_index, "3"))
    check("up to the same ceiling",
          valid(ups_index, str(FFX_UPSCALER_MAX - 1))
          and not valid(ups_index, str(FFX_UPSCALER_MAX)))
    check("an index that is not one is still refused",
          not valid(ups_index, "-1") and not valid(ups_index, "fsr4"))

    # Everything else keeps the closed-set treatment: these lists are the
    # backends OptiScaler has, not a snapshot of one runtime's answer.
    dx12 = SCHEMA[("Upscalers", "Dx12Upscaler")]
    check("a real backend id is accepted", valid(dx12, "fsr31"))
    check("an id OptiScaler does not have is not", not valid(dx12, "fsr31_12"))

    # Basic mode's presets all have to survive the writer, or picking one would
    # half-apply: some keys written, others silently dropped.
    from optiscaler.schema import option as schema_option
    presets = {
        "fsr4": [("Upscalers", "Dx12Upscaler", "fsr31"), ("Upscalers", "Dx11Upscaler", "fsr31_12"),
                 ("Upscalers", "VulkanUpscaler", "fsr31_12"), ("FSR", "Fsr4Update", "true"),
                 ("FSR", "UpscalerIndex", "0")],
        "fsr31": [("Upscalers", "Dx12Upscaler", "fsr31"), ("Upscalers", "Dx11Upscaler", "fsr31"),
                  ("Upscalers", "VulkanUpscaler", "fsr31"), ("FSR", "Fsr4Update", "false"),
                  ("FSR", "UpscalerIndex", "1")],
        "xess": [("Upscalers", "Dx12Upscaler", "xess"), ("Upscalers", "Dx11Upscaler", "xess_12"),
                 ("Upscalers", "VulkanUpscaler", "xess")],
    }
    for name, changes in presets.items():
        bad = [f"{s}.{k}={v}" for s, k, v in changes
               if not (schema_option(s, k) and valid(schema_option(s, k), v))]
        check(f"every key the {name} preset writes is accepted", not bad, bad)


def main():
    logging.basicConfig(level=logging.ERROR)
    asyncio.run(run())
    check_live_control()
    check_live_diagnostics()
    check_remembered_choices()
    check_launch_record()
    check_launch_options_read()
    check_asi_reporting()
    check_asi_staleness()
    check_reported_folder()
    check_live_frame_rates()
    check_wiki_failure_reporting()
    check_wiki_cache()
    check_wiki_transport()
    check_wiki_tls()
    check_version_pin()
    check_optipatcher()
    check_asi_wide_formats()
    check_asi_backend_layout()
    check_asi_state_layout()
    check_auto_plan()
    check_reframework()
    check_parenthesised_pages()
    check_option_validation()
    check_library_labels()
    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        for name in FAILED:
            print(f"  FAILED: {name}")
        sys.exit(1)


if __name__ == "__main__":
    main()
