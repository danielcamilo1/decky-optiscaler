"""Decky OptiScaler — manage OptiScaler per game from the Steam Deck UI."""

import os
import sys

import decky

sys.path.append(os.path.join(os.path.dirname(__file__), "py_modules"))

from optiscaler.service import OptiScalerService  # noqa: E402


class Plugin:
    service: OptiScalerService = None

    async def _main(self):
        decky.logger.info("Decky OptiScaler starting")
        self.service = OptiScalerService(
            plugin_dir=decky.DECKY_PLUGIN_DIR,
            settings_dir=decky.DECKY_PLUGIN_SETTINGS_DIR,
            runtime_dir=decky.DECKY_PLUGIN_RUNTIME_DIR,
            home=decky.HOME,
            logger=decky.logger,
        )
        decky.logger.info("payload status: %s", self.service.payload.status())

    async def _unload(self):
        decky.logger.info("Decky OptiScaler unloading")

    async def _uninstall(self):
        decky.logger.info("Decky OptiScaler uninstalled")

    # -- status ----------------------------------------------------------
    async def get_status(self) -> dict:
        return await self.service.get_status()

    async def prepare_payload(self, force: bool = False) -> dict:
        try:
            root = await self.service.ensure_payload(force)
            return {"ok": True, "path": root}
        except Exception as exc:
            decky.logger.exception("payload extraction failed")
            return {"ok": False, "error": str(exc)}

    # -- libraries -------------------------------------------------------
    async def list_libraries(self) -> list:
        return await self.service.list_libraries()

    async def add_custom_library(self, path: str, name: str = None) -> dict:
        return await self.service.add_custom_library(path, name)

    async def remove_custom_library(self, path: str) -> dict:
        return await self.service.remove_custom_library(path)

    async def browse(self, path: str = None) -> dict:
        return await self.service.browse(path)

    # -- games -----------------------------------------------------------
    async def list_all_games(self) -> list:
        return await self.service.list_all_games()

    async def list_games(self, library_path: str, source: str = "steam") -> list:
        return await self.service.list_games(library_path, source)

    async def get_game(self, game_path: str, name: str = None) -> dict:
        return await self.service.get_game(game_path, name)

    async def find_running_game(self, appid: str) -> dict:
        return await self.service.find_running_game(appid)

    async def get_fsr4_info(self, target_dir: str) -> dict:
        return await self.service.get_fsr4_info(target_dir)

    async def import_fsr4_files(self, target_dir: str, source_dir: str) -> dict:
        return await self.service.import_fsr4_files(target_dir, source_dir)

    async def get_pref(self, key: str, default=None) -> dict:
        return await self.service.get_pref(key, default)

    async def set_pref(self, key: str, value=None) -> dict:
        return await self.service.set_pref(key, value)

    async def set_game_target(self, game_path: str, target_dir: str) -> dict:
        return await self.service.set_game_target(game_path, target_dir)

    # -- wiki ------------------------------------------------------------
    async def get_recommendation(self, name: str, extra_names: list = None,
                                 force: bool = False, game_path: str = None) -> dict:
        return await self.service.get_recommendation(name, extra_names, force, game_path)

    async def search_wiki(self, query: str, limit: int = 30) -> dict:
        return await self.service.search_wiki(query, limit)

    async def set_wiki_entry(self, game_path: str, entry_name: str) -> dict:
        return await self.service.set_wiki_entry(game_path, entry_name)

    async def verify_install(self, target_dir: str) -> dict:
        return await self.service.verify_install(target_dir)

    async def refresh_wiki(self) -> dict:
        return await self.service.refresh_wiki()

    # -- automatic set-up ------------------------------------------------
    async def get_auto_plan(self, name: str, extra_names: list = None,
                            force: bool = False, game_path: str = None) -> dict:
        return await self.service.get_auto_plan(name, extra_names, force, game_path)

    async def set_auto_mode(self, game_path: str, enabled: bool) -> dict:
        return await self.service.set_auto_mode(game_path, enabled)

    async def auto_install(self, target_dir: str, game_path: str = None,
                           name: str = None, extra_names: list = None) -> dict:
        return await self.service.auto_install(target_dir, game_path, name, extra_names)

    async def apply_auto_settings(self, target_dir: str, game_path: str = None,
                                  name: str = None, extra_names: list = None) -> dict:
        return await self.service.apply_auto_settings(target_dir, game_path, name, extra_names)

    # -- install ---------------------------------------------------------
    async def install(self, target_dir: str, filename: str = "dxgi.dll",
                      preserve_ini: bool = True, optipatcher: bool = False) -> dict:
        return await self.service.install(target_dir, filename, preserve_ini, optipatcher)

    async def get_optipatcher_status(self, target_dir: str) -> dict:
        return await self.service.get_optipatcher_status(target_dir)

    async def install_optipatcher(self, target_dir: str, enabled: bool = True) -> dict:
        return await self.service.install_optipatcher(target_dir, enabled)

    async def uninstall(self, target_dir: str, remove_ini: bool = True) -> dict:
        return await self.service.uninstall(target_dir, remove_ini)

    # -- configuration ---------------------------------------------------
    async def read_config(self, target_dir: str) -> dict:
        return await self.service.read_config(target_dir)

    async def write_config(self, target_dir: str, changes: list) -> dict:
        return await self.service.write_config(target_dir, changes)

    async def reset_config(self, target_dir: str) -> dict:
        return await self.service.reset_config(target_dir)

    # -- monitoring ------------------------------------------------------
    async def get_live_status(self, target_dir: str) -> dict:
        return await self.service.get_live_status(target_dir)

    async def install_live(self, target_dir: str) -> dict:
        return await self.service.install_live(target_dir)

    async def switch_upscaler(self, target_dir: str, code: str) -> dict:
        return await self.service.switch_upscaler(target_dir, code)

    async def get_live_log(self, target_dir: str, lines: int = 40) -> dict:
        return await self.service.get_live_log(target_dir, lines)

    async def get_monitor(self, target_dir: str) -> dict:
        return await self.service.get_monitor(target_dir)

    async def clear_log(self, target_dir: str) -> dict:
        return await self.service.clear_log(target_dir)

    async def set_logging(self, target_dir: str, enabled: bool) -> dict:
        return await self.service.set_logging(target_dir, enabled)
