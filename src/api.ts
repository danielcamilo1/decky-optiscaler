import { callable } from "@decky/api";
import type {
  AutoPlanResult,
  ConfigResult,
  Fsr4Source,
  Fsr4Status,
  GpuInfo,
  Game,
  GameDetail,
  Library,
  LiveStatus,
  OptipatcherStatus,
  MonitorReport,
  OptionChange,
  PayloadStatus,
  Recommendation,
  VerifyResult,
  WikiSearchResult,
  WriteConfigResult,
} from "./types";

export interface BrowseResult {
  path: string | null;
  parent: string | null;
  entries: { path: string; name: string }[];
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export const getStatus = callable<[], PayloadStatus>("get_status");
export const preparePayload = callable<[force?: boolean], ActionResult>("prepare_payload");

export const listLibraries = callable<[], Library[]>("list_libraries");
export const addCustomLibrary = callable<[path: string, name?: string], ActionResult>(
  "add_custom_library"
);
export const removeCustomLibrary = callable<[path: string], ActionResult>(
  "remove_custom_library"
);

export const listGames = callable<[libraryPath: string, source: string], Game[]>("list_games");
export const getGame = callable<[gamePath: string, name?: string], GameDetail>("get_game");
export const findRunningGame = callable<
  [appid: string],
  { found: boolean; appid?: string; name?: string; path?: string; detail?: GameDetail }
>("find_running_game");
export const getFsr4Info = callable<
  [targetDir: string],
  { status: Fsr4Status; sources: Fsr4Source[]; gpu: GpuInfo }
>("get_fsr4_info");
export const importFsr4Files = callable<
  [targetDir: string, sourceDir: string],
  ActionResult
>("import_fsr4_files");
export const setGameTarget = callable<[gamePath: string, targetDir: string], ActionResult>(
  "set_game_target"
);

/** Small UI answers the user asked to be remembered, e.g. launch options. */
export const getPref = callable<[key: string, fallback?: unknown], { key: string; value: unknown }>(
  "get_pref"
);
export const setPref = callable<[key: string, value: unknown], ActionResult>("set_pref");

export const getRecommendation = callable<
  [name: string, extraNames?: string[], force?: boolean, gamePath?: string],
  Recommendation
>("get_recommendation");
export const searchWiki = callable<
  [query: string, limit?: number],
  { results: WikiSearchResult[]; entry_count: number; meta: { error: string | null } }
>("search_wiki");
export const setWikiEntry = callable<[gamePath: string, entryName: string], ActionResult>(
  "set_wiki_entry"
);
export const verifyInstall = callable<[targetDir: string], VerifyResult>("verify_install");
export const refreshWiki = callable<[], { count: number }>("refresh_wiki");

export const getAutoPlan = callable<
  [name: string, extraNames?: string[], force?: boolean, gamePath?: string],
  AutoPlanResult
>("get_auto_plan");
export const setAutoMode = callable<[gamePath: string, enabled: boolean], ActionResult>(
  "set_auto_mode"
);
export const autoInstall = callable<
  [targetDir: string, gamePath?: string, name?: string, extraNames?: string[]],
  ActionResult & Partial<AutoPlanResult>
>("auto_install");
export const applyAutoSettings = callable<
  [targetDir: string, gamePath?: string, name?: string, extraNames?: string[]],
  ActionResult & Partial<AutoPlanResult>
>("apply_auto_settings");

export const listAllGames = callable<[], Game[]>("list_all_games");

export const install = callable<
  [targetDir: string, filename: string, preserveIni: boolean, optipatcher: boolean],
  ActionResult
>("install");
export const uninstall = callable<[targetDir: string, removeIni: boolean], ActionResult>(
  "uninstall"
);

export const readConfig = callable<[targetDir: string], ConfigResult>("read_config");
export const writeConfig = callable<[targetDir: string, changes: OptionChange[]], WriteConfigResult>(
  "write_config"
);
export const resetConfig = callable<[targetDir: string], ActionResult>("reset_config");

export const getOptipatcherStatus = callable<[targetDir: string], OptipatcherStatus>(
  "get_optipatcher_status"
);
export const installOptipatcher = callable<
  [targetDir: string, enabled: boolean],
  ActionResult
>("install_optipatcher");

export const getLiveStatus = callable<[targetDir: string], LiveStatus>("get_live_status");
export const installLive = callable<[targetDir: string], ActionResult>("install_live");
export const switchUpscaler = callable<[targetDir: string, code: string], ActionResult>(
  "switch_upscaler"
);
export const getLiveLog = callable<[targetDir: string, lines?: number], { lines: string[] }>(
  "get_live_log"
);

export const getMonitor = callable<[targetDir: string], MonitorReport>("get_monitor");
export const clearLog = callable<[targetDir: string], ActionResult>("clear_log");
export const setLogging = callable<[targetDir: string, enabled: boolean], ActionResult>(
  "set_logging"
);
