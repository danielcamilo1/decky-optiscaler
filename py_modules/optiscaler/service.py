"""Facade tying the backend modules into the API the frontend calls."""

import asyncio
import os
import stat
import time
from pathlib import Path

from . import autoplan, constants, fsr4build, gameprofiles, installer, live, monitor, reframework, restorepoint, steam
from .constants import (
    DEFAULT_PROXY,
    LIVE_CONTROL_SUPPORTED,
    LIVE_CONTROL_REASON,
    INI_NAME,
    OPTIPATCHER_NAME,
    OPTIPATCHER_SHA256,
    OPTIPATCHER_VERSION,
    OPTISCALER_VERSION,
    PAYLOAD_ARCHIVE,
    PROXY_FILENAMES,
    REFRAMEWORK_DLL,
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
        # The bundled copy is the floor: a Deck that has never reached the wiki
        # still gets a compatibility list rather than "no entry matched" for
        # every game it owns.
        self.wiki = WikiClient(
            self.runtime_dir / "wiki-cache",
            self.plugin_dir / "defaults" / "compat-list.json",
        )
        self._payload_lock = asyncio.Lock()
        self._mutation_lock = asyncio.Lock()
        # Background wiki refreshes in flight, by key. Answers come from cache
        # and the network never sits in front of one; this is what keeps the
        # cache current behind them, single-flight so a page opened three times
        # does not download three times.
        self._wiki_jobs = set()

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

    # -- keeping the wiki cache current ----------------------------------
    def _start_wiki_job(self, key, work):
        """Run one refresh behind whatever answer was just given.

        Failure is deliberately quiet here: the caller has already been served
        from cache, and a refresh that could not happen is reported by
        `wiki_status` rather than by interrupting something the user is doing.
        """
        if key in self._wiki_jobs:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._wiki_jobs.add(key)

        async def run():
            try:
                result = await self._run(work)
                if isinstance(result, dict) and result.get("changed"):
                    self.log.info("compatibility list updated: %s entries",
                                  result.get("count"))
            except Exception:
                self.log.exception("background wiki refresh failed (%s)", key)
            finally:
                self._wiki_jobs.discard(key)

        loop.create_task(run())

    def refresh_wiki_if_stale(self):
        """Start a list refresh when the cached one is old enough to matter."""
        if self.wiki.is_stale():
            self._start_wiki_job("list", self.wiki.revalidate)

    def refresh_page_if_stale(self, page):
        """Fetch one game's wiki page behind the answer, if it is worth trying.

        `page_needs_fetch` rather than `page_is_stale`: a page the wiki will not
        serve must not be re-attempted on every question, or a refresh is
        permanently in flight and the UI never stops waiting for one that is
        never going to arrive.
        """
        if self.wiki.page_needs_fetch(page):
            self._start_wiki_job(f"page:{page}", lambda: self.wiki.fetch_page(page))

    def prime_wiki(self):
        """Called at plugin start, so the list is current before it is asked for."""
        self.refresh_wiki_if_stale()

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
            for candidate in candidates:
                candidate["writable"] = Path(candidate["path"]).is_dir() and os.access(candidate["path"], os.W_OK)
            saved_target = self.settings.get_target(str(path))
            pinned_wiki_entry = self.settings.get_wiki_entry(str(path))
            pbz_identity = gameprofiles.has_pbz_identity(path, name, pinned_wiki_entry)
            pbz_target = gameprofiles.target_for(path, name, pinned_wiki_entry)

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
            elif pbz_target:
                # With no installed or saved target, honor the selected PBZ
                # wiki identity even when the folder and shortcut are renamed.
                target = pbz_target
            elif candidates:
                target = candidates[0]["path"]
            else:
                target = str(path)

            info = installer.detect(target)
            info["runtime_current"] = installer.runtime_current(target)
            info["runtime_recovery_needed"] = installer.pending_target_transaction(target)
            info["runtime_upgrade_held"] = self.settings.get_pref(
                _runtime_hold_key(target)) == constants.RUNTIME_DLL_SHA256
            info["rollback"] = restorepoint.info(target)
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
                "wiki_entry": pinned_wiki_entry,
                "fsr4_sources": installer.find_fsr4_sources(self.home),
                "gpu": gpu_info(),
                "path": str(path),
                "name": name or path.name,
                "target": target,
                "pbz_identity": pbz_identity,
                "pbz_target": pbz_target,
                "target_is_saved": bool(saved_target),
                "candidates": candidates,
                "install": info,
                "launch_option": installer.launch_option(info["filename"] or DEFAULT_PROXY),
                "reframework": reframework.status(target),
                "writable": os.access(target, os.W_OK) if Path(target).is_dir() else False,
            }

        return await self._run(work)

    async def find_running_game(self, appid, shortcut=None):
        """Resolve an app id to its game folder and install state.

        ``shortcut`` is what the Steam client said about a non-Steam entry —
        its target, its start directory and its name — or None for a game
        Steam has a manifest for. A shortcut has no install directory anywhere
        in Steam's records, so without this a game added by hand answered "no
        install folder" and could not be opened at all: the Quick Access panel,
        Now Playing and the library context menu all come through here.
        """
        shortcut = shortcut or {}

        def work():
            game = steam.find_by_appid(self.home, appid, shortcut.get("exe"),
                                       shortcut.get("start_dir"), shortcut.get("name"))
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
        self.refresh_wiki_if_stale()
        return await self._run(self.wiki.search, query, limit)

    async def set_wiki_entry(self, game_path, entry_name):
        """Pin a compatibility-list entry to a game, overriding name matching."""
        await self._run(self.settings.set_wiki_entry, game_path, entry_name)
        return {"ok": True}

    # -- FSR4 support files ----------------------------------------------
    def fsr4_build_cache(self):
        """Where downloaded FSR 4 builds live. Shared by every game, so a second
        game is a copy rather than a second download."""
        cache = self.runtime_dir / "fsr4-builds"
        # The experimental package can carry the exact same pinned archive as the downloader.
        # Seed only a verified archive; fetch() still verifies the extracted DLL independently.
        for build in fsr4build.FSR4_BUILDS:
            for source in build["sources"]:
                bundled = self.plugin_dir / "bin" / source["asset"]
                if bundled.is_file() and fsr4build.digest(bundled) == source["archive_sha256"]:
                    destination = cache / build["id"] / source["asset"]
                    if not destination.is_file() or fsr4build.digest(destination) != source["archive_sha256"]:
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        installer.atomic_copy(bundled, destination)
                    break
        return cache

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

    async def set_fsr4_build(self, target_dir, build_id):
        """Enable the pinned community upscaler and INT8 settings together."""
        try:
            build = fsr4build.find(build_id)
            if build is None:
                raise ValueError("Unsupported Steam Deck FSR 4 build")
            async with self._mutation_lock:
                await self._run(installer.require_stopped_install, target_dir)
                if not await self._run(installer.runtime_current, target_dir):
                    raise ValueError("Upgrade the game runtime before choosing this FSR preset.")
                point = await self._run(restorepoint.info, target_dir)
                if not point.get("available"):
                    raise ValueError("Create a restore point before changing the FSR build.")
                self._validate_restore_metadata(point.get("metadata"))
                dll = await self._run(fsr4build.fetch, build, self.fsr4_build_cache(), self.log)
                # Installer checks again: the game may have started during download.
                result = await self._run(
                    installer.install_fsr4_build, target_dir, dll, build, self.log, True
                )
            return {"ok": True, **result}
        except Exception as exc:
            self.log.exception("FSR 4 setup failed for %s", target_dir)
            return {"ok": False, "error": str(exc)}

    async def restore_fsr4_build(self, target_dir):
        try:
            payload_root = await self.ensure_payload()
            async with self._mutation_lock:
                result = await self._run(
                    installer.restore_fsr4_build, target_dir, payload_root, self.log
                )
            return {"ok": True, **result}
        except Exception as exc:
            self.log.exception("FSR 4 restore failed for %s", target_dir)
            return {"ok": False, "error": str(exc)}

    async def import_fsr4_files(self, target_dir, source_dir):
        try:
            async with self._mutation_lock:
                result = await self._run(installer.import_fsr4_files, target_dir, source_dir, self.log)
            return {"ok": True, **result}
        except Exception as exc:
            self.log.exception("FSR4 import failed for %s", target_dir)
            return {"ok": False, "error": str(exc)}

    async def get_launch_options(self, appid):
        """What Steam passes a game, read out of its own config on disk.

        The frontend asks the client first, because that is live and this file
        is only flushed periodically. But `GetAppLaunchOptions` is missing from
        some client builds entirely, and on those the plugin could previously
        neither report the launch options nor undo them — so this is the answer
        of last resort rather than a nicety.
        """
        return await self._run(steam.launch_options, self.home, appid)

    async def record_launch_options(self, target_dir, options=None, appid=None):
        """Keep this game's launch options as they were before the install.

        ``options`` is what the frontend read from the Steam client, which is
        the freshest source; ``None`` means it could not read them, and Steam's
        own config file is then asked instead. Recording nothing is the last
        resort, because a missing record is what makes removing OptiScaler
        unable to put anything back.

        Written once, next to the install it belongs to, beside the manifest
        and the backup folder.
        """
        try:
            if options is None and appid is not None:
                found = await self._run(steam.launch_options, self.home, appid)
                if not found["found"]:
                    return {"ok": False, "error": "Steam would not report the launch options",
                            "recorded": False, "value": "", "written": False}
                options = found["value"]
            if options is None:
                return {"ok": False, "error": "no launch options to record",
                        "recorded": False, "value": "", "written": False}
            async with self._mutation_lock:
                if not await self._run(installer.read_manifest, target_dir):
                    raise ValueError("Set up this game with the plugin before changing its Steam launch options.")
                record = await self._run(installer.record_launch_options, target_dir, options, self.log)
            return {"ok": True, **record}
        except Exception as exc:
            self.log.exception("could not record launch options for %s", target_dir)
            return {"ok": False, "error": str(exc)}

    async def get_pref(self, key, default=None):
        """One remembered UI choice, e.g. whether to set launch options."""
        return {"key": key, "value": self.settings.get_pref(key, default)}

    async def set_pref(self, key, value):
        await self._run(self.settings.set_pref, key, value)
        return {"ok": True, "key": key, "value": value}

    async def set_game_target(self, game_path, target_dir):
        async with self._mutation_lock:
            await self._run(self.settings.set_target, game_path, target_dir)
        return {"ok": True}

    # -- wiki ------------------------------------------------------------
    async def get_recommendation(self, name, extra_names=None, force=False, game_path=None):
        """Wiki recommendation, honouring a manually pinned entry if there is one.

        Answered from the cache; anything out of date is refreshed behind the
        answer, both the list and this game's own detail page.
        """
        if not force:
            self.refresh_wiki_if_stale()
        pinned = self.settings.get_wiki_entry(game_path) if game_path else None
        if pinned:
            entry = await self._run(self.wiki.entry_by_name, pinned)
            if entry:
                result = await self._run(self.wiki.recommend_entry, entry, force)
                if not force:
                    self.refresh_page_if_stale(entry.get("page"))
                return gameprofiles.recommendation(result, name, extra_names, pinned, game_path)
            if gameprofiles.is_pbz(pinned):
                # A selected PBZ row can disappear from the cached list while
                # offline. Start with the wiki's standard unmatched response
                # so no guessed title contributes settings or detail, then
                # apply only the reviewed PBZ fallback profile.
                result = await self._run(self.wiki.recommend, "", [], force)
                result["searched"] = [n for n in [name, *(extra_names or [])] if n]
                result["manual"] = True
                return gameprofiles.recommendation(result, pinned, game_path=game_path)
        result = await self._run(self.wiki.recommend, name, extra_names, force)
        if not force:
            self.refresh_page_if_stale(result.get("page"))
        return gameprofiles.recommendation(result, name, extra_names, game_path=game_path)

    async def refresh_wiki(self):
        entries, meta = await self._run(self.wiki.load_entries, True)
        return {"count": len(entries), "meta": meta}

    async def wiki_status(self, force=False):
        """Is the compatibility list usable, how old is it, and what last failed?"""
        if not force:
            self.refresh_wiki_if_stale()
        status = await self._run(self.wiki.status, force)
        # What the UI watches to know a background refresh is worth waiting a
        # moment for: while this is true, the revision it holds may change.
        status["revalidating"] = bool(self._wiki_jobs)
        return status

    # -- automatic set-up ------------------------------------------------
    async def get_auto_plan(self, name, extra_names=None, force=False, game_path=None):
        """The wiki recommendation plus the plan built from it.

        Both together, because the plan is only meaningful next to the entry it
        was read out of: the UI shows what will be changed and cites the wiki
        row or field each item came from, so "automatic" is never a black box.
        """
        recommendation = await self.get_recommendation(name, extra_names, force, game_path)
        plan = gameprofiles.constrain(await self._run(autoplan.build, recommendation), recommendation)
        if game_path:
            plan["enabled"] = bool(self.settings.get_pref(_auto_key(game_path), False))
        return {"recommendation": recommendation, "plan": plan}

    async def set_auto_mode(self, game_path, enabled):
        """Remember whether one game's settings are driven by the wiki."""
        async with self._mutation_lock:
            await self._run(self.settings.set_pref, _auto_key(game_path), bool(enabled) or None)
        return {"ok": True, "enabled": bool(enabled)}

    async def auto_install(self, target_dir, game_path=None, name=None, extra_names=None, launch_options=None):
        planned = await self.get_auto_plan(name or Path(target_dir).name, extra_names, False, game_path)
        plan = planned["plan"]
        if not plan["available"] or plan.get("runtime_supported") is False:
            return {"ok": False, "error": plan.get("blocked_reason") or "No supported compatibility entry matched this game", **planned}
        if plan.get("required_target"):
            pinned = self.settings.get_wiki_entry(game_path) if game_path else None
            expected = gameprofiles.target_for(game_path, name, pinned, extra_names) if game_path else None
            if not expected or Path(expected).resolve() != Path(target_dir).resolve():
                return {"ok": False, "error": "Choose the main PBZ.exe folder at PBZ/platform/steam in Manual setup before installing.", **planned}
        result = await self.install(target_dir, plan["filename"], True, plan["optipatcher"],
                                    plan.get("reframework"), autoplan.setting_changes(plan),
                                    game_path, launch_options, True,
                                    framegen_changes=autoplan.framegen_changes(plan))
        if not result.get("ok"):
            return {"ok": False, "error": result.get("error"), **planned}
        return {"ok": True, "install": result, "applied": result.get("applied", []),
                "rejected": [], **planned}

    async def apply_auto_settings(self, target_dir, game_path=None, name=None, extra_names=None):
        planned = await self.get_auto_plan(name or Path(target_dir).name, extra_names, False, game_path)
        plan = planned["plan"]
        if not plan["available"] or plan.get("runtime_supported") is False:
            return {"ok": False, "error": plan.get("blocked_reason") or "No supported compatibility entry matched this game", **planned}
        if plan.get("required_target"):
            pinned = self.settings.get_wiki_entry(game_path) if game_path else None
            expected = gameprofiles.target_for(game_path, name, pinned, extra_names) if game_path else None
            if not expected or Path(expected).resolve() != Path(target_dir).resolve():
                return {"ok": False, "error": "Choose the main PBZ.exe folder at PBZ/platform/steam before applying settings.", **planned}
        try:
            async with self._mutation_lock:
                def work():
                    with self._config_transaction(target_dir):
                        changes = autoplan.setting_changes(plan)
                        if not _keeps_no_framegen(target_dir):
                            changes += autoplan.framegen_changes(plan)
                        written = self._write_config_sync(target_dir, changes)
                        if not written.get("ok") or written.get("rejected"):
                            raise ValueError(written.get("error") or "Some automatic settings were rejected")
                        if game_path:
                            self.settings.set_pref(_auto_key(game_path), True)
                        return written
                written = await self._run(work)
            return {**planned, **written, "ok": True}
        except Exception as exc:
            return {**planned, "ok": False, "error": str(exc)}

    @staticmethod
    def _validate_restore_metadata(metadata):
        return restorepoint.validate_metadata(metadata)

    async def create_restore_point(self, target_dir, game_path=None, launch_options=None):
        try:
            async with self._mutation_lock:
                metadata = {"game_path": game_path, "launch_options": launch_options,
                            "game_settings": self.settings.snapshot_game(game_path) if game_path else None}
                self._validate_restore_metadata(metadata)
                result = await self._run(restorepoint.create, target_dir, metadata)
                if result.get("available"):
                    self._validate_restore_metadata(result.get("metadata"))
                    if game_path and result["metadata"].get("game_path") != game_path:
                        raise ValueError("Restore point belongs to a different game.")
            return {"ok": True, **result}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    async def rollback_install(self, target_dir, game_path=None):
        try:
            async with self._mutation_lock:
                def work():
                    info = restorepoint.info(target_dir)
                    if not info.get("available"):
                        raise ValueError("No pre-experiment restore point exists for this install.")
                    metadata = info.get("metadata") or {}
                    self._validate_restore_metadata(metadata)
                    saved_game = metadata.get("game_path")
                    if saved_game and game_path and saved_game != game_path:
                        raise ValueError("Restore point belongs to a different game.")
                    before = self.settings.snapshot_game(saved_game) if saved_game else None
                    hold_key = _runtime_hold_key(target_dir)
                    before_hold = self.settings.get_pref(hold_key)
                    preferences_changed = False
                    # Keep the restore point until Remove so a Steam setter failure can be retried.
                    try:
                        with installer.target_transaction(target_dir, require_stopped=True):
                            restored = restorepoint.restore(target_dir)
                            if saved_game and metadata.get("game_settings") is not None:
                                self.settings.restore_game(saved_game, metadata["game_settings"],
                                    runtime_hold=(hold_key, constants.RUNTIME_DLL_SHA256))
                                preferences_changed = True
                    except Exception:
                        if preferences_changed:
                            self.settings.restore_game(saved_game, before,
                                runtime_hold=(hold_key, before_hold))
                        raise
                    return {"ok": True, **restored, "launch_options": metadata.get("launch_options"),
                            "restart_required": True}
                return await self._run(work)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    async def setup_deck_experiment(self, target_dir, game_path=None, game_name=None):
        """Explicit opt-in: community FSR4.1 INT8 with OptiScaler FG disabled."""
        try:
            if not game_path:
                raise ValueError("This experiment is only defined for Phantom Blade Zero.")
            wiki_identity = self.settings.get_wiki_entry(game_path)
            expected = gameprofiles.target_for(game_path, game_name, wiki_identity)
            if not expected or Path(expected).resolve() != Path(target_dir).resolve():
                raise ValueError("Choose the main PBZ.exe folder at PBZ/platform/steam before starting the experiment.")
            build = fsr4build.find("4.1.1b")
            async with self._mutation_lock:
                dll = await self._run(fsr4build.fetch, build, self.fsr4_build_cache(), self.log)
                def work():
                    installer.require_stopped_install(target_dir)
                    if not installer.runtime_current(target_dir):
                        raise ValueError("Upgrade the game's runtime before starting the experiment.")
                    point = restorepoint.info(target_dir)
                    if not point.get("available"):
                        raise ValueError("Create a restore point before starting the experiment.")
                    self._validate_restore_metadata(point.get("metadata"))
                    if point["metadata"].get("game_path") != game_path:
                        raise ValueError("Restore point belongs to a different game.")
                    before = self.settings.snapshot_game(game_path)
                    preferences_changed = False
                    try:
                        with installer.target_transaction(target_dir, require_stopped=True):
                            result = installer.install_fsr4_build(target_dir, dll, build, self.log, True)
                            written = self._write_config_sync(target_dir, [
                                {"section": "FrameGen", "key": "Enabled", "value": "false"},
                                {"section": "FrameGen", "key": "FGInput", "value": "nofg"},
                                {"section": "FrameGen", "key": "FGOutput", "value": "nofg"},
                            ])
                            if not written.get("ok") or written.get("rejected"):
                                raise ValueError(written.get("error") or "Could not disable OptiScaler frame generation")
                            self.settings.set_pref(_experiment_key(game_path), True)
                            preferences_changed = True
                    except Exception:
                        if preferences_changed:
                            self.settings.restore_game(game_path, before)
                        raise
                    return {"ok": True, **result, "restart_required": True,
                            "manual_steps": list(gameprofiles.PBZ_STEPS)}
                return await self._run(work)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # -- install ---------------------------------------------------------
    async def upgrade_runtime(self, target_dir, game_path, launch_options=None, name=None):
        return await self.install(target_dir, game_path=game_path,
                                  launch_options=launch_options, upgrade_only=True, upgrade_name=name)

    async def install(self, target_dir, filename=DEFAULT_PROXY, preserve_ini=True,
                      optipatcher=False, reframework_plan=None, config_changes=None, game_path=None,
                      launch_options=None, auto_mode=False, framegen_changes=None,
                      upgrade_only=False, upgrade_name=None):
        """Install OptiScaler, and REFramework first when the plan calls for it.

        A failed REFramework download does not fail the install. The two are
        separate mods and the OptiScaler half is still worth having on disk;
        what matters is that the failure is *reported*, because for these games
        an install without REF is one that will do nothing and say nothing.

        Which is also why the requirement is still carried through here with
        automatic installation switched off: the plan says the game needs REF,
        the checklist says where to get it, and only the download is gone.
        """
        ref_result = {"required": False, "installed": False, "error": None}
        ref_files = None
        ref_revision = None
        if reframework_plan and reframework_plan.get("required"):
            ref_result["required"] = True
        # `automatic` is the whole gate: a game with no known build has never
        # had one, and since 0.0.5.3-testing no game does, because downloading
        # a third-party engine hook into somebody's game folder is not a
        # promise this plugin makes any more. The requirement still travelled
        # here and is still reported — the checklist says what the game needs
        # and where to get it — so this is a step left to the user, not an
        # error to put in front of them.
        if reframework_plan and reframework_plan.get("automatic"):
            try:
                ref_files = await self._run(
                    reframework.fetch, reframework_plan, self.reframework_cache(), self.log
                )
                ref_revision = await self._run(reframework.revision_of, ref_files)
            except Exception as exc:
                self.log.warning("REFramework download failed for %s: %s", target_dir, exc)
                ref_result["error"] = str(exc)
        try:
            payload_root = await self.ensure_payload()
            async with self._mutation_lock:
                def work():
                    if upgrade_only:
                        target = Path(target_dir).resolve()
                        root = Path(game_path).resolve() if game_path else None
                        saved = self.settings.get_target(game_path) if game_path else None
                        if (root is None or (saved and Path(saved).resolve() != target)
                                or (not saved and not target.is_relative_to(root))):
                            raise ValueError("This target belongs to a different game.")
                        wiki_identity = self.settings.get_wiki_entry(game_path)
                        if gameprofiles.has_pbz_identity(game_path, upgrade_name, wiki_identity):
                            pbz = gameprofiles.target_for(game_path, upgrade_name, wiki_identity)
                            if not pbz or Path(pbz).resolve() != target:
                                raise ValueError("Choose the main PBZ.exe folder before upgrading this install.")
                        point = restorepoint.info(target)
                        if point.get("available") and point.get("metadata", {}).get("game_path") != game_path:
                            raise ValueError("Restore point belongs to a different game.")
                        installer.require_stopped_target(target_dir)
                    live_source = self.live_asi_path()
                    patcher_source = self.optipatcher_path() if optipatcher else None
                    if optipatcher and not patcher_source:
                        raise ValueError("This build does not bundle a usable OptiPatcher.")
                    installer.preflight_install_sources(
                        payload_root, live_source, ref_files, self.plugin_dir,
                        patcher_source,
                    )
                    installer.recover_target_transactions(target_dir)
                    before = self.settings.snapshot_game(game_path) if game_path else None
                    hold_key = _runtime_hold_key(target_dir)
                    before_hold = self.settings.get_pref(hold_key)
                    existing = installer.read_manifest(target_dir) or {}
                    if game_path and existing.get("game_path") not in (None, game_path):
                        raise ValueError("This install belongs to a different game.")
                    selected_filename = filename
                    if upgrade_only:
                        if not game_path or not existing:
                            raise ValueError("Automatic upgrade requires a managed game install.")
                        if installer.runtime_current(target_dir):
                            return {"upgraded": False}
                        if self.settings.get_pref(_runtime_hold_key(target_dir)) == constants.RUNTIME_DLL_SHA256:
                            return {"upgraded": False, "held": True}
                        selected_filename = existing.get("filename")
                        if selected_filename not in PROXY_FILENAMES:
                            raise ValueError("The installed proxy filename is unknown.")
                        expected = constants.UPGRADE_RUNTIME_HASHES.get(existing.get("optiscaler_version"))
                        proxy = installer._safe_path(target_dir, selected_filename)
                        if not expected or not proxy.is_file() or installer._sha256_file(proxy) != expected:
                            raise ValueError("The installed runtime is not a recognized upgrade source. Use Manual setup to review it.")
                        point = restorepoint.create(target_dir, {
                            "game_path": game_path, "game_settings": before,
                            "launch_options": launch_options,
                        })
                        if not point.get("available") or point.get("metadata", {}).get("game_path") != game_path:
                            raise ValueError("A matching restore point is required before upgrading.")
                    try:
                        with installer.target_transaction(target_dir, require_stopped=True):
                            result = installer.install(
                                target_dir, payload_root, selected_filename, preserve_ini, self.log,
                                live_source, patcher_source,
                                ref_files, ref_revision, self.plugin_dir)
                            # Migrate only the changed option; preserve comments and every other value.
                            ini = IniFile(Path(target_dir) / INI_NAME)
                            value = str(ini.get("FSR", "Fsr4ForceEnableInt8", "auto")).lower()
                            if value in ("true", "false"):
                                ini.set("FSR", "Fsr4ForceEnableInt8", "1" if value == "true" else "0")
                                self._save_ini(ini)
                            changes = list(config_changes or [])
                            if not _keeps_no_framegen(target_dir):
                                changes += list(framegen_changes or [])
                            if not upgrade_only and (result.get("live", {}).get("installed")
                                    or result.get("optipatcher", {}).get("installed")):
                                changes += live.ini_requirements()
                            written = self._write_config_sync(target_dir, changes, push_live=False)
                            if not written.get("ok") or written.get("rejected"):
                                raise ValueError(written.get("error") or "Automatic settings were rejected")
                            result["applied"] = written.get("applied", [])
                            if not upgrade_only and launch_options is not None:
                                if not isinstance(launch_options, str):
                                    raise ValueError("Launch options must be a string or unknown (null).")
                                installer.record_launch_options(target_dir, launch_options, self.log)
                            if game_path:
                                manifest = installer.read_manifest(target_dir)
                                manifest.setdefault("game_path", game_path)
                                manifest.setdefault("game_settings_before", before)
                                self._save_manifest(target_dir, manifest)
                                if not upgrade_only:
                                    self.settings.configure_game(game_path, target_dir, bool(auto_mode))
                            return {**result, **({"upgraded": True} if upgrade_only else {})}
                    except Exception:
                        if game_path and before is not None:
                            self.settings.restore_game(game_path, before,
                                runtime_hold=(hold_key, before_hold))
                        raise
                result = await self._run(work)
            if (result.get("live", {}).get("installed")
                    or result.get("optipatcher", {}).get("installed")):
                result["asi_loading_enabled"] = await self._run(
                    live.load_enabled, target_dir
                )
            if ref_result["required"]:
                installed = result.get("reframework", {})
                ref_result["installed"] = bool(installed.get("installed"))
                ref_result["error"] = ref_result["error"] or installed.get("error")
                result["reframework"] = {**installed, **ref_result}
            return {"ok": True, **result}
        except Exception as exc:  # surfaced verbatim in the UI
            if upgrade_only:
                cause = exc
                while cause is not None:
                    if isinstance(cause, installer.GameRunningError):
                        return {"ok": True, "deferred": True, "upgraded": False}
                    cause = cause.__cause__
            self.log.exception("install failed for %s", target_dir)
            return {"ok": False, "error": str(exc)}

    async def uninstall(self, target_dir, remove_ini=True):
        try:
            async with self._mutation_lock:
                def work():
                    installer.recover_target_transactions(target_dir)
                    manifest = installer.read_manifest(target_dir) or {}
                    game_path = manifest.get("game_path")
                    before = self.settings.snapshot_game(game_path) if game_path else None
                    hold_key = _runtime_hold_key(target_dir)
                    before_hold = self.settings.get_pref(hold_key)
                    preferences_changed = False
                    try:
                        with installer.target_transaction(target_dir, extra_names=(restorepoint.RESTORE_DIR,), require_stopped=True):
                            result = installer.uninstall(target_dir, remove_ini, self.log)
                            if game_path and manifest.get("game_settings_before") is not None:
                                self.settings.restore_game(game_path, manifest["game_settings_before"],
                                    runtime_hold=(hold_key, None))
                                preferences_changed = True
                            elif before_hold is not None:
                                self.settings.set_pref(hold_key, None)
                    except Exception:
                        if preferences_changed:
                            self.settings.restore_game(game_path, before,
                                runtime_hold=(hold_key, before_hold))
                        elif before_hold is not None:
                            self.settings.set_pref(hold_key, before_hold)
                        raise
                    return result
                result = await self._run(work)
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
                "runtime_current": bool(installer.read_manifest(target_dir)) and installer.runtime_current(target_dir),
                "modified": path.stat().st_mtime,
                "fsr4_build": (fsr4build.identify(path.parent / installer.FFX_UPSCALER_DLL) or {}).get("id"),
            }

        return await self._run(work)

    def _config_transaction(self, target_dir):
        from contextlib import contextmanager
        @contextmanager
        def transaction():
            target = Path(target_dir).resolve()
            installer.recover_target_transactions(target)
            error = self._config_preflight_error(target, self.plugin_dir)
            if error:
                raise ValueError(error)
            with installer.target_transaction(
                    target, extra_names=(INI_NAME, installer.MANIFEST_NAME),
                    include_known=False,
                    intent=installer.TRANSACTION_INTENT_MANAGED_INI):
                yield
        return transaction()

    @staticmethod
    def _config_preflight_error(target_dir, plugin_root=None):
        """Check the managed config contract before creating a live-safe journal."""
        target = Path(target_dir).resolve()
        if not installer.read_manifest(target):
            return "Set up this game with the plugin first so its original configuration can be restored."
        if not installer.runtime_current(target):
            return "Upgrade this game's OptiScaler runtime in Setup before editing settings."
        ini_path = target / INI_NAME
        mode = installer._existing_mode(ini_path)
        if mode is None:
            return "OptiScaler.ini not found"
        if not stat.S_ISREG(mode):
            raise ValueError(f"OptiScaler.ini is not a regular file: {ini_path}")
        if installer._preflight_live_control(target, plugin_root=plugin_root):
            return "Remove the legacy Decky live ASI by upgrading this game while it is stopped before changing settings."
        return None

    @staticmethod
    def _save_ini(ini, plugin_root=None):
        import tempfile
        import shutil
        target = ini.path.parent.resolve()
        active = getattr(installer._TRANSACTIONS, "targets", {}).get(str(target))
        if active is None:
            raise RuntimeError("INI save is outside an active managed transaction")
        stage_root = Path(active["journal"]) / "ini-staging"
        stage_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="change-", dir=stage_root) as stage:
            destination = ini.path
            staged_ini = Path(stage) / INI_NAME
            try:
                shutil.copy2(destination, staged_ini)
                ini.path = staged_ini
                ini.save()
                installer._preflight_live_control(destination.parent, ini_path=ini.path,
                                                  plugin_root=plugin_root)
                installer.atomic_copy(ini.path, destination)
            finally:
                ini.path = destination

    @staticmethod
    def _save_manifest(target_dir, manifest):
        installer._atomic_json(Path(target_dir) / installer.MANIFEST_NAME, manifest)

    def _write_config_sync(self, target_dir, changes, push_live=False, live_context=None):
        target = Path(target_dir).resolve()
        active = getattr(installer._TRANSACTIONS, "targets", {})
        if str(target) not in active:
            installer.recover_target_transactions(target)
        preflight_error = self._config_preflight_error(target, self.plugin_dir)
        if preflight_error:
            return {"ok": False, "error": preflight_error}
        with installer.target_transaction(
                target, extra_names=(INI_NAME, installer.MANIFEST_NAME),
                include_known=False,
                intent=installer.TRANSACTION_INTENT_MANAGED_INI):
            # Recover first, then validate install/runtime/path ownership, then
            # read and edit the INI. A stale journal must never reintroduce an
            # older setting after this request has already been constructed.
            preflight_error = self._config_preflight_error(target, self.plugin_dir)
            if preflight_error:
                raise ValueError(preflight_error)
            path = Path(target) / INI_NAME
            ini = IniFile(path)
            applied, rejected = [], []
            for change in changes or []:
                section, key = change.get("section"), change.get("key")
                if not section or not key:
                    continue
                value = "auto" if change.get("value") in (None, "") else str(change["value"])
                meta = SCHEMA.get((section, key))
                if not meta or not _valid(meta, value):
                    rejected.append({"section": section, "key": key, "value": value})
                    continue
                ini.set(section, key, value)
                entry = {"section": section, "key": key, "value": value}
                if isinstance(change.get("live_context"), dict):
                    entry["live_context"] = change["live_context"]
                applied.append(entry)
            if rejected:
                return {"ok": False, "error": "Some settings were rejected; nothing was written.",
                        "applied": [], "rejected": rejected}
            if applied:
                self._save_ini(ini, self.plugin_dir)
        public_applied = [
            {key: value for key, value in item.items() if key != "live_context"}
            for item in applied
        ]
        applied_keys = [f"{item['section']}.{item['key']}" for item in applied]
        live_changes = [item for item in applied if live.is_live_key(item["section"], item["key"])]
        live_keys = [f"{item['section']}.{item['key']}" for item in live_changes]
        if push_live and live_changes:
            try:
                live_result = live.apply_changes(
                    target_dir, live_changes, live_context=live_context,
                    source=self.live_asi_path(), plugin_root=self.plugin_dir,
                )
            except Exception as exc:
                live_result = {
                    "ok": False, "sent": False, "confirmed": False, "ack": None,
                    "session": None, "seq": None,
                    "accepted_keys": [], "sent_keys": [], "context": None,
                    "deferred": live_keys,
                    "failed_keys": [], "error": str(exc), "reason": str(exc),
                }
        else:
            reason = None if push_live else "Live sending was disabled for this config write."
            live_result = {
                "ok": False, "sent": False, "confirmed": False, "ack": None,
                "session": None, "seq": None,
                "accepted_keys": [], "sent_keys": [], "context": None,
                "deferred": live_keys,
                "failed_keys": [], "error": None, "reason": reason,
            }
        return {"ok": True, "applied": public_applied, "rejected": rejected,
                "written_at": time.time(), "live": live_result,
                "persisted_keys": applied_keys}

    async def write_config(self, target_dir, changes, push_live=True, live_context=None):
        try:
            async with self._mutation_lock:
                return await self._run(self._write_config_sync, target_dir, changes,
                                       push_live, live_context)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    async def reset_config(self, target_dir):
        """Restore the stock OptiScaler.ini shipped with the bundled release."""
        try:
            payload_root = Path(await self.ensure_payload())

            def work():
                target = Path(target_dir).resolve()
                installer.recover_target_transactions(target)
                preflight_error = self._config_preflight_error(target, self.plugin_dir)
                if preflight_error:
                    raise ValueError(preflight_error)
                with installer.target_transaction(
                        target, extra_names=(INI_NAME, installer.MANIFEST_NAME),
                        include_known=False,
                        intent=installer.TRANSACTION_INTENT_MANAGED_INI):
                    preflight_error = self._config_preflight_error(target, self.plugin_dir)
                    if preflight_error:
                        raise ValueError(preflight_error)
                    legacy_asi = installer._preflight_live_control(
                        target, ini_path=payload_root / INI_NAME,
                        plugin_root=self.plugin_dir
                    )
                    if legacy_asi:
                        raise ValueError("Upgrade this game's legacy live ASI while it is stopped before resetting settings.")
                    destination = Path(target) / INI_NAME
                    original_mode = destination.stat().st_mode
                    state = installer._TRANSACTIONS.targets[str(target)]
                    stage_root = Path(state["journal"]) / "ini-staging"
                    stage_root.mkdir(exist_ok=True)
                    temporary = stage_root / "reset.ini"
                    import shutil
                    shutil.copy2(payload_root / INI_NAME, temporary)
                    os.chmod(temporary, stat.S_IMODE(original_mode))
                    installer.atomic_copy(temporary, destination)
                return {"ok": True, "path": str(destination)}

            async with self._mutation_lock:
                return await self._run(work)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # -- live control ----------------------------------------------------
    def live_asi_path(self):
        """The compiled live-control plugin shipped inside this plugin."""
        if not LIVE_CONTROL_SUPPORTED:
            return None
        candidate = self.plugin_dir / "bin" / live.ASI_NAME
        try:
            candidate.lstat()
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise ValueError(f"Cannot inspect packaged live ASI: {exc}") from exc
        # Only an absent optional component is offline-only. A symlink,
        # directory, or corrupted artifact must reach validate_live_source and
        # fail before any game-target recovery or mutation.
        return str(candidate)

    def reframework_cache(self):
        """Where downloaded REFramework builds are kept between installs.

        Under the runtime directory, so setting up a second Resident Evil game
        is a copy rather than a second 13 MB download on a handheld connection —
        and so it goes when the plugin does.
        """
        return self.runtime_dir / "reframework"

    async def get_reframework_status(self, target_dir, game_path=None, name=None,
                                     extra_names=None):
        """Whether this game needs REFramework, and whether it has it.

        Both halves in one answer, because either alone is unreadable: "present"
        means nothing for a game that does not want it, and "required" means
        nothing without knowing whether it is already there.
        """
        wanted = None
        if name or game_path:
            planned = await self.get_auto_plan(name or Path(target_dir).name, extra_names,
                                               False, game_path)
            wanted = planned["plan"].get("reframework")
        manifest = await self._run(installer.read_manifest, target_dir) or {}
        return await self._run(reframework.status, target_dir, wanted or {},
                               manifest.get("reframework_revision"))

    async def install_reframework(self, target_dir, game_path=None, name=None,
                                  extra_names=None):
        """Add REFramework to a game that is already set up, or retry a failure.

        Separate from the install for the same reason OptiPatcher is: a download
        over a handheld's connection is the part that fails, and having to
        reinstall OptiScaler to retry it would be a poor answer to a flaky
        network.
        """
        try:
            planned = await self.get_auto_plan(name or Path(target_dir).name, extra_names,
                                               False, game_path)
            wanted = planned["plan"].get("reframework")
            if not wanted or not wanted.get("required"):
                return {"ok": False, "error": "this game's wiki entry does not ask for "
                                              "REFramework"}
            if not wanted.get("automatic"):
                return {"ok": False, "error": wanted.get("reason") or
                        "REFramework cannot be downloaded for this game",
                        "page": wanted.get("page")}
            files = await self._run(reframework.fetch, wanted, self.reframework_cache(),
                                    self.log)
            revision = await self._run(reframework.revision_of, files)
            async with self._mutation_lock:
                result = await self._run(installer.add_files, target_dir, files, self.log, revision)
            if not result.get("ok"):
                return {"ok": False, "error": result.get("error")}
            return {"ok": True, "installed": True, "files": result["files"],
                    "status": await self._run(reframework.status, target_dir, wanted,
                                              revision)}
        except Exception as exc:
            self.log.exception("REFramework install failed for %s", target_dir)
            return {"ok": False, "error": str(exc)}

    async def remove_reframework(self, target_dir):
        """Take REFramework back out without touching OptiScaler.

        The isolation test a game that will not boot needs. Two mods went into
        that folder and either could be the one at fault; being able to remove
        one of them is the difference between a bug report and an answer.
        """
        try:
            async with self._mutation_lock:
                result = await self._run(installer.remove_files, target_dir, [REFRAMEWORK_DLL], self.log)
            return {"ok": True, **result}
        except Exception as exc:
            self.log.exception("REFramework removal failed for %s", target_dir)
            return {"ok": False, "error": str(exc)}

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
        try:
            async with self._mutation_lock:
                def work():
                    source = self.optipatcher_path() if enabled else None
                    if enabled:
                        if not source:
                            raise ValueError("This build does not bundle OptiPatcher")
                        source_path = Path(source)
                        if source_path.is_symlink() or not source_path.is_file():
                            raise FileNotFoundError(
                                f"required install source missing or unsafe: {source_path}"
                            )
                        if installer._sha256_file(source_path) != OPTIPATCHER_SHA256:
                            raise ValueError("The bundled OptiPatcher checksum does not match.")
                    installer.recover_target_transactions(target_dir)
                    installer.require_stopped_install(target_dir)
                    with installer.target_transaction(target_dir, require_stopped=True):
                        relative = f"{live.PLUGIN_SUBDIR}/{OPTIPATCHER_NAME}"
                        if not enabled:
                            installer.remove_files(target_dir, [relative], self.log)
                        else:
                            if installer._preflight_live_control(
                                    target_dir, plugin_root=self.plugin_dir):
                                raise ValueError("Upgrade this game's legacy live ASI while it is stopped before enabling OptiPatcher.")
                            # add_files accepts destination names through a relative source mapping.
                            installer.install_plugin_file(target_dir, source, relative, self.log)
                            written = self._write_config_sync(target_dir, live.ini_requirements())
                            if not written.get("ok") or written.get("rejected"):
                                raise ValueError(written.get("error") or "Could not enable ASI loading")
                    return {"ok": True, "installed": bool(enabled)}
                return await self._run(work)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    async def get_live_status(self, target_dir):
        """Whether settings can currently be changed without a restart."""
        source = self.live_asi_path()
        report = await self._run(live.status, target_dir, source, self.plugin_dir)
        report["asi_available"] = source is not None
        return report

    async def install_live(self, target_dir):
        source = self.live_asi_path()
        if not source:
            return {"ok": False, "error": "This package has no verified live-control ASI."}
        try:
            async with self._mutation_lock:
                result = await self._run(
                    installer.install_live_component, target_dir, source, self.log,
                    self.plugin_dir,
                )
            result["asi_loading_enabled"] = await self._run(
                live.load_enabled, target_dir
            )
            return {"ok": True, **result}
        except Exception as exc:
            self.log.exception("live-control install failed for %s", target_dir)
            return {"ok": False, "error": str(exc)}

    async def switch_upscaler(self, target_dir, code, live_context=None):
        try:
            async with self._mutation_lock:
                result = await self._run(
                    live.switch_backend, target_dir, code, live_context,
                    self.live_asi_path(), self.plugin_dir,
                )
            return {"ok": bool(result.get("confirmed")), "live": result,
                    **({"error": result.get("error")} if not result.get("confirmed") else {})}
        except Exception as exc:
            return {"ok": False, "error": str(exc),
                    "live": {"ok": False, "sent": False, "confirmed": False,
                             "ack": None, "session": None, "seq": None,
                             "accepted_keys": [],
                             "sent_keys": [], "context": None, "deferred": [],
                             "failed_keys": [], "error": str(exc), "reason": str(exc)}}

    async def get_live_log(self, target_dir, lines=40):
        return {"lines": await self._run(live.log_tail, target_dir, lines)}

    # -- monitoring ------------------------------------------------------
    async def get_monitor(self, target_dir):
        return await self._run(monitor.status, target_dir)

    async def clear_log(self, target_dir):
        try:
            async with self._mutation_lock:
                if not await self._run(installer.read_manifest, target_dir):
                    raise ValueError("Set up this game with the plugin before clearing its runtime log.")
                cleared = await self._run(monitor.clear_log, target_dir)
            return {"ok": cleared}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

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


def _experiment_key(game_path):
    return f"deck-experiment:{game_path}"


def _runtime_hold_key(target_dir):
    return f"runtime-upgrade-hold:{Path(target_dir).resolve()}"


def _keeps_no_framegen(target_dir):
    ini = IniFile(Path(target_dir) / INI_NAME)
    return any(str(ini.get("FrameGen", key, "auto")).lower() == "nofg"
               for key in ("FGInput", "FGOutput"))
