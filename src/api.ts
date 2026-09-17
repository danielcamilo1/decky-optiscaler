import { callable } from "@decky/api";
import type {
  AutoPlanResult,
  ConfigResult,
  Fsr4BuildOption,
  Fsr4Source,
  Fsr4Status,
  GpuInfo,
  Game,
  GameDetail,
  Library,
  LiveStatus,
  OptipatcherStatus,
  ReframeworkStatus,
  MonitorReport,
  OptionChange,
  PayloadStatus,
  Recommendation,
  VerifyResult,
  WikiSearchResult,
  WikiStatus,
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
/* `shortcut` carries what the Steam client said about a non-Steam entry, which
   is the only place a shortcut's install folder can come from. Call it through
   `resolveGame` in shortcuts.ts rather than directly. */
export const findRunningGame = callable<
  [appid: string, shortcut?: { exe?: string; start_dir?: string; name?: string }],
  { found: boolean; appid?: string; name?: string; path?: string; detail?: GameDetail }
>("find_running_game");
export const getFsr4Info = callable<
  [targetDir: string],
  { status: Fsr4Status; sources: Fsr4Source[]; gpu: GpuInfo; builds: Fsr4BuildOption[] }
>("get_fsr4_info");
export const importFsr4Files = callable<
  [targetDir: string, sourceDir: string],
  ActionResult
>("import_fsr4_files");
/** Download a pinned FSR 4 upscaler build and put it in the game folder. */
export const setFsr4Build = callable<[targetDir: string, buildId: string], ActionResult>(
  "set_fsr4_build"
);
/** Put the build that ships inside the OptiScaler release back. */
export const restoreFsr4Build = callable<[targetDir: string], ActionResult>(
  "restore_fsr4_build"
);
export const setGameTarget = callable<[gamePath: string, targetDir: string], ActionResult>(
  "set_game_target"
);

/**
 * Keep this game's Steam launch options as they were before the install, so
 * removing OptiScaler can put them back. Written once per install.
 */
export const recordLaunchOptions = callable<
  [targetDir: string, options: string | null, appid?: string | null],
  ActionResult & { recorded: boolean; value: string; written: boolean }
>("record_launch_options");

/**
 * What Steam passes a game, read out of its own config file. The fallback for
 * client builds with no `GetAppLaunchOptions`, where nothing else can tell.
 */
export const getLaunchOptions = callable<
  [appid: string],
  { found: boolean; value: string; source: string | null }
>("get_launch_options");

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
export const refreshWiki = callable<
  [],
  { count: number; meta: { source: string; fetched_at: number | null; error: string | null } }
>("refresh_wiki");

/** Whether the compatibility list is reachable at all, and what failed if not. */
export const getWikiStatus = callable<[force?: boolean], WikiStatus>("wiki_status");

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

export const getReframeworkStatus = callable<
  [targetDir: string, gamePath?: string, name?: string, extraNames?: string[]],
  ReframeworkStatus
>("get_reframework_status");
export const installReframework = callable<
  [targetDir: string, gamePath?: string, name?: string, extraNames?: string[]],
  ActionResult & { installed?: boolean; files?: string[]; page?: string }
>("install_reframework");

export const removeReframework = callable<[targetDir: string], ActionResult>(
  "remove_reframework"
);

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
