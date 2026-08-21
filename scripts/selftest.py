#!/usr/bin/env python3
"""End-to-end backend test against a synthetic Steam library in a temp dir.

Exercises library discovery, executable-folder scoring, the wiki lookup (needs
network; skipped gracefully offline), install/detect/uninstall round trips and
comment-preserving INI edits.
"""

import asyncio
import hashlib
import logging
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py_modules"))

from optiscaler.service import OptiScalerService  # noqa: E402
from optiscaler import installer  # noqa: E402
from optiscaler.inifile import IniFile  # noqa: E402

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
            check("filename came from the wiki entry",
                  recommendation["filename_source"] == "wiki entry",
                  f"{recommendation['filename']} via {recommendation['filename_source']}")

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
    finally:
        shutil.rmtree(root, ignore_errors=True)


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
    check_asi_reporting()
    check_asi_staleness()
    check_reported_folder()
    check_live_frame_rates()
    check_wiki_tls()
    check_version_pin()
    check_optipatcher()
    check_asi_wide_formats()
    check_asi_backend_layout()
    check_asi_state_layout()
    check_auto_plan()
    check_option_validation()
    check_library_labels()
    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        for name in FAILED:
            print(f"  FAILED: {name}")
        sys.exit(1)


if __name__ == "__main__":
    main()
