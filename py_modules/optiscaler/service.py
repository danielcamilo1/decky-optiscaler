"""Facade tying the backend modules into the API the frontend calls."""

import asyncio
import os
import time
from pathlib import Path

from . import autoplan, installer, live, monitor, steam
from .constants import (
    DEFAULT_PROXY,
    INI_NAME,
    OPTIPATCHER_NAME,
    OPTIPATCHER_VERSION,
    OPTISCALER_VERSION,
    PAYLOAD_ARCHIVE,
    PROXY_FILENAMES,
)
from .inifile import IniFile
from .payload import Payload
from .schema import SCHEMA, valid as _valid
from .settings import Settings
from .sysinfo import gpu_info
from .wiki import WikiClient


class OptiScalerService:
    def __init__(self, plugin_dir, settings_dir, runtime_dir, home, logger):
        self.plugin_dir = Path(plugin_dir)
        self.runtime_dir = Path(runtime_dir)
        self.home = Path(home)
        self.log = logger

        self.settings = Settings(Path(settings_dir) / "settings.json")
        self.payload = Payload(
            self.plugin_dir / "bin" / PAYLOAD_ARCHIVE, self.runtime_dir / "payload"
        )
        self.wiki = WikiClient(self.runtime_dir / "wiki-cache")
        self._payload_lock = asyncio.Lock()

    # -- helpers ---------------------------------------------------------
    @staticmethod
    async def _run(func, *args, **kwargs):
        return await asyncio.to_thread(func, *args, **kwargs)

    async def ensure_payload(self, force=False):
        async with self._payload_lock:
            if self.payload.ready and not force:
                return str(self.payload.root)
            root = await self._run(self.payload.ensure, force, self.log)
            return str(root)

    # -- status ----------------------------------------------------------
    async def get_status(self):
        status = self.payload.status()
        status["optiscaler_version"] = OPTISCALER_VERSION
        status["proxy_filenames"] = PROXY_FILENAMES
        status["default_proxy"] = DEFAULT_PROXY
        return status

    # -- libraries -------------------------------------------------------
    def _libraries(self):
        """Steam library folders plus any the user added by hand."""
        libraries = []
        for path in steam.library_folders(self.home):
            libraries.append(
                {
                    "path": str(path),
                    "name": self._library_label(path),
                    "source": "steam",
                    "game_count": len(steam.steam_games(path)),
                    "available": True,
                }
            )
        for entry in self.settings.get("custom_libraries", []):
            path = Path(entry["path"])
            available = path.is_dir()
            libraries.append(
                {
                    "path": str(path),
                    "name": entry.get("name") or path.name,
                    "source": "custom",
                    "game_count": len(steam.folder_games(path)) if available else 0,
                    "available": available,
                }
            )
        return libraries

    async def list_libraries(self):
        return await self._run(self._libraries)

    def _library_label(self, path):
        path = Path(path)
        text = str(path)
        if str(self.home) in text:
            return "Internal Storage"
        if self._is_sd_card(path):
            return f"SD Card ({path.name})"
        # Anything else mounted under /run/media is removable, but it is a USB
        # stick or an external SSD - calling those an SD card was the bug this
        # replaced, and there is nothing here that can tell which kind it is.
        if text.startswith("/run/media"):
            return f"External Drive ({path.name})"
        return path.name or text

    @staticmethod
    def _mount_device(path):
        """The block device backing `path`, from /proc/mounts.

        The longest mount point that is a prefix of the path wins, which is what
        makes a library on a card mounted inside another filesystem resolve to
        the card rather than to whatever it sits in.
        """
        try:
            target = os.path.realpath(str(path))
            entries = Path("/proc/mounts").read_text(errors="replace").splitlines()
        except OSError:
            return None
        best = None
        best_len = -1
        for line in entries:
            fields = line.split()
            if len(fields) < 2:
                continue
            device = fields[0]
            # /proc/mounts escapes spaces and friends as octal.
            mount = (
                fields[1]
                .replace("\\040", " ")
                .replace("\\011", "\t")
                .replace("\\012", "\n")
                .replace("\\134", "\\")
            )
            if target == mount or target.startswith(mount.rstrip("/") + "/"):
                if len(mount) > best_len:
                    best, best_len = device, len(mount)
        return best

    @staticmethod
    def _disk_name(device):
        """`/dev/mmcblk0p1` -> `mmcblk0`: the drive, not the partition."""
        if not device or not device.startswith("/dev/"):
            return None
        name = os.path.basename(device)
        if name.startswith("mmcblk") or name.startswith("nvme"):
            # mmcblk0p1, nvme0n1p2 - the partition suffix is "p<n>".
            return name.rsplit("p", 1)[0] if "p" in name[6:] else name
        return name.rstrip("0123456789") or name

    def _is_sd_card(self, path):
        """Whether this really is the SD card, rather than any removable drive.

        The old test was the path — anything under /run/media, or with mmcblk
        anywhere in it — which labelled every USB stick and external SSD an SD
        card. The card is a property of the device, so the device is what is
        asked: an MMC drive that is not the one the system booted from. The
        exclusion matters on the 64 GB Deck, whose internal storage is eMMC and
        therefore an mmcblk device too.
        """
        device = self._mount_device(path)
        disk = self._disk_name(device)
        if not disk or not disk.startswith("mmcblk"):
            return False
        return disk != self._disk_name(self._mount_device("/"))

    async def add_custom_library(self, path, name=None):
        target = Path(path).expanduser()
        if not target.is_dir():
            return {"ok": False, "error": f"Not a directory: {target}"}
        added = await self._run(self.settings.add_library, str(target), name)
        if not added:
            return {"ok": False, "error": "That folder is already a library."}
        return {"ok": True, "path": str(target)}

    async def remove_custom_library(self, path):
        removed = await self._run(self.settings.remove_library, path)
        return {"ok": removed}

    async def browse(self, path=None):
        """Directory listing used by the custom-library folder picker."""
        def work():
            if not path:
                roots = [
                    {"path": str(self.home), "name": "Home"},
                    {"path": "/run/media", "name": "Removable media"},
                    {"path": "/", "name": "Filesystem root"},
                ]
                return {
                    "path": None,
                    "parent": None,
                    "entries": [r for r in roots if Path(r["path"]).is_dir()],
                }
            current = Path(path).expanduser()
            if not current.is_dir():
                return {"path": str(current), "parent": str(current.parent), "entries": []}
            entries = []
            try:
                for child in sorted(current.iterdir(), key=lambda p: p.name.lower()):
                    if child.is_dir() and not child.name.startswith("."):
                        entries.append({"path": str(child), "name": child.name})
            except PermissionError:
                pass
            return {
                "path": str(current),
                "parent": str(current.parent) if current.parent != current else None,
                "entries": entries,
            }

        return await self._run(work)

    # -- games -----------------------------------------------------------
    async def list_games(self, library_path, source="steam"):
        def work():
            games = (steam.steam_games(library_path) if source == "steam"
                     else steam.folder_games(library_path))
            for game in games:
                target = self.settings.get_target(game["path"])
                probe = target or game["path"]
                detection = installer.detect(probe)
                if not detection["installed"] and not target:
                    # Cheap top-level probe missed it; look one level deeper.
                    for candidate in steam.find_exe_dirs(game["path"])[:4]:
                        found = installer.detect(candidate["path"])
                        if found["installed"]:
                            detection = found
                            break
                game["installed"] = detection["installed"]
                game["filename"] = detection["filename"]
                game["install_path"] = detection["path"] if detection["installed"] else None
            return games

        return await self._run(work)

    async def list_all_games(self):
        """Every detected game across every library, as one flat list.

        The main page leads with games rather than libraries, because picking a
        game is what people came to do; libraries stay available for the cases
        where a folder has to be added by hand.
        """
        def work():
            seen = set()
            games = []
            for library in self._libraries():
                source = library["source"]
                found = (steam.steam_games(library["path"]) if source == "steam"
                         else steam.folder_games(library["path"]))
                for game in found:
                    if game["path"] in seen:
                        continue
                    seen.add(game["path"])
                    game["library"] = library["name"]
                    game["source"] = source
                    target = self.settings.get_target(game["path"])
                    probe = target or game["path"]
                    detection = installer.detect(probe)
                    if not detection["installed"] and not target:
                        for candidate in steam.find_exe_dirs(game["path"])[:4]:
                            deeper = installer.detect(candidate["path"])
                            if deeper["installed"]:
                                detection = deeper
                                break
                    game["installed"] = detection["installed"]
                    game["filename"] = detection["filename"]
                    game["install_path"] = detection["path"] if detection["installed"] else None
                    games.append(game)
            # Set-up games first, then alphabetical - the ones already managed
            # are the ones being come back to.
            games.sort(key=lambda g: (not g["installed"], g["name"].lower()))
            return games

        return await self._run(work)

    async def get_game(self, game_path, name=None):
        """Everything the game detail page needs."""
        def work():
            path = Path(game_path)
            candidates = steam.find_exe_dirs(path)
            saved_target = self.settings.get_target(str(path))

            detection = None
            for candidate in candidates:
                found = installer.detect(candidate["path"])
                if found["installed"]:
                    detection = found
                    break
            if detection is None:
                root = installer.detect(str(path))
                detection = root if root["installed"] else None

            if detection:
                target = detection["path"]
            elif saved_target:
                target = saved_target
            elif candidates:
                target = candidates[0]["path"]
            else:
                target = str(path)

            info = installer.detect(target)
            ini_info = {"present": False, "legacy": False, "keys": 0}
            ini_path = Path(target) / INI_NAME
            if ini_path.is_file():
                values = IniFile(ini_path).to_dict()
                ini_info = {
                    "present": True,
                    # v0.9-final split FGType into FGInput/FGOutput; an ini that
                    # still has FGType was written by an older tool.
                    "legacy": any("FGType" in section for section in values.values()),
                    "keys": sum(len(v) for v in values.values()),
                }
            return {
                "ini_info": ini_info,
                "wiki_entry": self.settings.get_wiki_entry(str(path)),
                "fsr4_sources": installer.find_fsr4_sources(self.home),
                "gpu": gpu_info(),
                "path": str(path),
                "name": name or path.name,
                "target": target,
                "target_is_saved": bool(saved_target),
                "candidates": candidates,
                "install": info,
                "launch_option": installer.launch_option(info["filename"] or DEFAULT_PROXY),
                "writable": os.access(target, os.W_OK) if Path(target).is_dir() else False,
            }

        return await self._run(work)

    async def find_running_game(self, appid):
        """Resolve a running Steam app id to its game folder and install state."""
        def work():
            game = steam.find_by_appid(self.home, appid)
            if not game:
                return {"found": False, "appid": str(appid)}
            return {"found": True, **game}

        game = await self._run(work)
        if not game.get("found"):
            return game
        detail = await self.get_game(game["path"], game["name"])
        return {**game, "detail": detail}

    async def verify_install(self, target_dir):
        """Confirm the bundled files really landed in the game folder."""
        try:
            payload_root = await self.ensure_payload()
            return {"ok": True, **await self._run(
                installer.verify_install, target_dir, payload_root
            )}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # -- wiki search / manual selection ----------------------------------
    async def search_wiki(self, query, limit=30):
        return await self._run(self.wiki.search, query, limit)

    async def set_wiki_entry(self, game_path, entry_name):
        """Pin a compatibility-list entry to a game, overriding name matching."""
        await self._run(self.settings.set_wiki_entry, game_path, entry_name)
        return {"ok": True}

    # -- FSR4 support files ----------------------------------------------
    async def get_fsr4_info(self, target_dir):
        """FSR4 readiness for one install, plus where the files could come from."""
        def work():
            status = installer.fsr4_status(target_dir)
            return {
                "status": status,
                "sources": installer.find_fsr4_sources(self.home),
                "gpu": gpu_info(),
            }

        return await self._run(work)

    async def import_fsr4_files(self, target_dir, source_dir):
        try:
            result = await self._run(
                installer.import_fsr4_files, target_dir, source_dir, self.log
            )
            return {"ok": True, **result}
        except Exception as exc:
            self.log.exception("FSR4 import failed for %s", target_dir)
            return {"ok": False, "error": str(exc)}

    async def get_pref(self, key, default=None):
        """One remembered UI choice, e.g. whether to set launch options."""
        return {"key": key, "value": self.settings.get_pref(key, default)}

    async def set_pref(self, key, value):
        await self._run(self.settings.set_pref, key, value)
        return {"ok": True, "key": key, "value": value}

    async def set_game_target(self, game_path, target_dir):
        await self._run(self.settings.set_target, game_path, target_dir)
        return {"ok": True}

    # -- wiki ------------------------------------------------------------
    async def get_recommendation(self, name, extra_names=None, force=False, game_path=None):
        """Wiki recommendation, honouring a manually pinned entry if there is one."""
        pinned = self.settings.get_wiki_entry(game_path) if game_path else None
        if pinned:
            entry = await self._run(self.wiki.entry_by_name, pinned)
            if entry:
                return await self._run(self.wiki.recommend_entry, entry, force)
        return await self._run(self.wiki.recommend, name, extra_names, force)

    async def refresh_wiki(self):
        entries, meta = await self._run(self.wiki.load_entries, True)
        return {"count": len(entries), "meta": meta}

    # -- automatic set-up ------------------------------------------------
    async def get_auto_plan(self, name, extra_names=None, force=False, game_path=None):
        """The wiki recommendation plus the plan built from it.

        Both together, because the plan is only meaningful next to the entry it
        was read out of: the UI shows what will be changed and cites the wiki
        row or field each item came from, so "automatic" is never a black box.
        """
        recommendation = await self.get_recommendation(name, extra_names, force, game_path)
        plan = await self._run(autoplan.build, recommendation)
        if game_path:
            plan["enabled"] = bool(self.settings.get_pref(_auto_key(game_path), False))
        return {"recommendation": recommendation, "plan": plan}

    async def set_auto_mode(self, game_path, enabled):
        """Remember whether one game's settings are driven by the wiki."""
        await self._run(self.settings.set_pref, _auto_key(game_path), bool(enabled) or None)
        return {"ok": True, "enabled": bool(enabled)}

    async def auto_install(self, target_dir, game_path=None, name=None, extra_names=None):
        """Install and configure a game the way its wiki entry describes.

        One call rather than a filename, an OptiPatcher toggle and a run of
        config writes done separately, because the ini has to exist before the
        wiki's settings can go into it, and a half-applied plan is worse than
        none. The Steam launch options are returned rather than set: only the
        frontend can talk to Steam.
        """
        planned = await self.get_auto_plan(name or Path(target_dir).name, extra_names,
                                           False, game_path)
        plan = planned["plan"]
        if not plan["available"]:
            return {"ok": False, "error": "no compatibility entry matched this game",
                    **planned}

        result = await self.install(target_dir, plan["filename"], False, plan["optipatcher"])
        if not result.get("ok"):
            return {"ok": False, "error": result.get("error"), **planned}

        changes = autoplan.setting_changes(plan) + autoplan.framegen_changes(plan)
        written = await self.write_config(target_dir, changes) if changes else {"applied": []}
        if game_path:
            await self._run(self.settings.set_target, game_path, target_dir)
            await self.set_auto_mode(game_path, True)
        return {
            "ok": True,
            "install": result,
            "applied": written.get("applied", []),
            "rejected": written.get("rejected", []),
            **planned,
        }

    async def apply_auto_settings(self, target_dir, game_path=None, name=None,
                                  extra_names=None):
        """Re-apply the wiki's settings to a game that is already installed.

        Used when automatic mode is switched on for a game set up by hand, and
        after a wiki refresh, so the ini says what the entry currently says.
        """
        planned = await self.get_auto_plan(name or Path(target_dir).name, extra_names,
                                           False, game_path)
        plan = planned["plan"]
        if not plan["available"]:
            return {"ok": False, "error": "no compatibility entry matched this game",
                    **planned}
        changes = autoplan.setting_changes(plan) + autoplan.framegen_changes(plan)
        written = await self.write_config(target_dir, changes) if changes else {"ok": True}
        if game_path:
            await self.set_auto_mode(game_path, True)
        return {"ok": True, "applied": written.get("applied", []),
                "live": written.get("live"), **planned}

    # -- install ---------------------------------------------------------
    async def install(self, target_dir, filename=DEFAULT_PROXY, preserve_ini=True,
                      optipatcher=False):
        try:
            payload_root = await self.ensure_payload()
            result = await self._run(
                installer.install, target_dir, payload_root, filename, preserve_ini,
                self.log, self.live_asi_path(),
                self.optipatcher_path() if optipatcher else None,
            )
            # OptiScaler will not look for .asi plugins unless it is told to,
            # and both our live-control module and OptiPatcher are .asi plugins.
            if result.get("live", {}).get("installed") or result.get("optipatcher", {}).get(
                "installed"
            ):
                written = await self.write_config(target_dir, live.ini_requirements())
                # Without this switch OptiScaler never even looks in the plugins
                # folder, so a failure here is the difference between working
                # live control and none - it must not pass unreported.
                result["asi_loading_enabled"] = bool(written.get("applied"))
                if not written.get("ok") or not written.get("applied"):
                    result["asi_loading_error"] = written.get(
                        "error", "LoadAsiPlugins could not be written to OptiScaler.ini")
            return {"ok": True, **result}
        except Exception as exc:  # surfaced verbatim in the UI
            self.log.exception("install failed for %s", target_dir)
            return {"ok": False, "error": str(exc)}

    async def uninstall(self, target_dir, remove_ini=True):
        try:
            result = await self._run(installer.uninstall, target_dir, remove_ini, self.log)
            return {"ok": True, **result}
        except Exception as exc:
            self.log.exception("uninstall failed for %s", target_dir)
            return {"ok": False, "error": str(exc)}

    # -- configuration ---------------------------------------------------
    async def read_config(self, target_dir):
        def work():
            path = Path(target_dir) / INI_NAME
            if not path.is_file():
                return {"ok": False, "error": "OptiScaler.ini not found", "values": {}}
            return {
                "ok": True,
                "path": str(path),
                "values": IniFile(path).to_dict(),
                "modified": path.stat().st_mtime,
            }

        return await self._run(work)

    async def write_config(self, target_dir, changes, push_live=True):
        """changes: [{section, key, value}] — value None/'' means 'auto'.

        ``push_live`` is off for writes that only record what the running game
        has already been told directly; pushing them again would re-send the
        same change through a path that does not mean the same thing.
        """
        def work():
            path = Path(target_dir) / INI_NAME
            if not path.is_file():
                return {"ok": False, "error": "OptiScaler.ini not found"}
            ini = IniFile(path)
            applied = []
            rejected = []
            for change in changes or []:
                section = change.get("section")
                key = change.get("key")
                if not section or not key:
                    continue
                value = change.get("value")
                value = "auto" if value in (None, "") else str(value)
                meta = SCHEMA.get((section, key))
                if meta and not _valid(meta, value):
                    rejected.append({"section": section, "key": key, "value": value})
                    continue
                ini.set(section, key, value)
                applied.append({"section": section, "key": key, "value": value})
            if applied:
                ini.save()
            return {"ok": True, "applied": applied, "rejected": rejected,
                    "written_at": time.time()}

        result = await self._run(work)

        # The INI is the record of intent, but OptiScaler only reads it at
        # startup. If the live-control plugin is attached, push the same change
        # into the running game so it takes effect now instead of next launch.
        if push_live and result.get("ok") and result.get("applied"):
            def push():
                # Only claim a live change when the in-game plugin is actually
                # answering; otherwise the command file would sit unread and the
                # user would be told the change took effect when it did not.
                state = live.status(target_dir)
                if not state.get("attached"):
                    return {"ok": True, "sent": False, "reason": state.get("state"),
                            "attached": False}
                outcome = live.apply_changes(target_dir, result["applied"])
                outcome["attached"] = True
                outcome["can_switch_upscaler"] = state.get("can_switch_upscaler", False)
                return outcome

            result["live"] = await self._run(push)
        return result

    async def reset_config(self, target_dir):
        """Restore the stock OptiScaler.ini shipped with the bundled release."""
        try:
            payload_root = Path(await self.ensure_payload())

            def work():
                import shutil
                destination = Path(target_dir) / INI_NAME
                shutil.copy2(payload_root / INI_NAME, destination)
                return {"ok": True, "path": str(destination)}

            return await self._run(work)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # -- live control ----------------------------------------------------
    def live_asi_path(self):
        """The compiled live-control plugin shipped inside this plugin."""
        candidate = self.plugin_dir / "bin" / live.ASI_NAME
        return str(candidate) if candidate.is_file() else None

    def optipatcher_path(self):
        """The bundled OptiPatcher build, if this package shipped with one."""
        candidate = self.plugin_dir / "bin" / OPTIPATCHER_NAME
        return str(candidate) if candidate.is_file() else None

    async def get_optipatcher_status(self, target_dir):
        """Whether OptiPatcher is available here and installed for this game."""
        installed_path = Path(target_dir) / live.PLUGIN_SUBDIR / OPTIPATCHER_NAME
        return {
            "available": self.optipatcher_path() is not None,
            "installed": installed_path.is_file(),
            "version": OPTIPATCHER_VERSION,
        }

    async def install_optipatcher(self, target_dir, enabled=True):
        """Add or remove OptiPatcher for one game without reinstalling."""
        try:
            path = Path(target_dir) / live.PLUGIN_SUBDIR / OPTIPATCHER_NAME
            if not enabled:
                if path.is_file():
                    path.unlink()
                return {"ok": True, "installed": False}
            source = self.optipatcher_path()
            if not source:
                return {"ok": False, "error": "this build does not bundle OptiPatcher"}
            result = await self._run(
                live.install_plugin_asi, target_dir, source, OPTIPATCHER_NAME, self.log
            )
            if not result.get("ok"):
                return {"ok": False, "error": result.get("error")}
            # It is loaded by the same switch our own plugin needs.
            await self.write_config(target_dir, live.ini_requirements())
            return {"ok": True, "installed": True}
        except Exception as exc:
            self.log.exception("optipatcher change failed for %s", target_dir)
            return {"ok": False, "error": str(exc)}

    async def get_live_status(self, target_dir):
        """Whether settings can currently be changed without a restart."""
        report = await self._run(live.status, target_dir)
        report["asi_available"] = self.live_asi_path() is not None
        report["live_keys"] = sorted(live.LIVE_FIELDS)
        return report

    async def install_live(self, target_dir):
        """Add live control to a game OptiScaler is already installed in."""
        source = self.live_asi_path()
        if not source:
            return {"ok": False, "error": "this build ships no live-control plugin"}
        result = await self._run(live.install_asi, target_dir, source, self.log)
        if result.get("ok"):
            await self.write_config(target_dir, live.ini_requirements())
            result["load_enabled"] = await self._run(live.load_enabled, target_dir)
        return result

    async def switch_upscaler(self, target_dir, code):
        """The overlay's "Change Upscaler" button, from here."""
        result = await self._run(live.switch_backend, target_dir, code)
        if result.get("ok"):
            # Record the choice for the next launch, but do not push it into the
            # running game: the overlay's own switch writes State::newBackend
            # and leaves Config alone until OptiScaler has rebuilt the feature,
            # and writing Config first can make the switch a no-op.
            key = {"fsr31_12": "Dx11Upscaler"}.get(code, "Dx12Upscaler")
            await self.write_config(target_dir, [
                {"section": "Upscalers", "key": key, "value": code},
            ], push_live=False)
        return result

    async def get_live_log(self, target_dir, lines=40):
        return {"lines": await self._run(live.log_tail, target_dir, lines)}

    # -- monitoring ------------------------------------------------------
    async def get_monitor(self, target_dir):
        return await self._run(monitor.status, target_dir)

    async def clear_log(self, target_dir):
        cleared = await self._run(monitor.clear_log, target_dir)
        return {"ok": cleared}

    async def set_logging(self, target_dir, enabled):
        """Toggle LogToFile, which monitoring depends on."""
        return await self.write_config(
            target_dir,
            [
                {"section": "Log", "key": "LogToFile", "value": "true" if enabled else "false"},
                {"section": "Log", "key": "LogLevel", "value": "2" if enabled else "auto"},
                {"section": "Log", "key": "SingleFile", "value": "true"},
            ],
        )


def _auto_key(game_path):
    """Preference key holding whether one game is in automatic mode."""
    return f"auto_mode:{game_path}"
