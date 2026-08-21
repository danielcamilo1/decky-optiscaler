export type OptionType = "bool" | "enum" | "int" | "float" | "string" | "keycode";

export interface OptionMeta {
  section: string;
  key: string;
  label: string;
  description: string;
  type: OptionType;
  default: string;
  options?: string[];
  optionLabels?: Record<string, string>;
  min?: number;
  max?: number;
  inheritedFrom?: string;
}

export interface PayloadStatus {
  version: string;
  archive_present: boolean;
  archive_path: string;
  extracted: boolean;
  extract_path: string;
  extractor: string | null;
  optiscaler_version: string;
  proxy_filenames: string[];
  default_proxy: string;
}

export interface Library {
  path: string;
  name: string;
  source: "steam" | "custom";
  game_count: number;
  available: boolean;
}

export interface Game {
  appid: string | null;
  name: string;
  path: string;
  source: "steam" | "custom";
  size_on_disk: number;
  installed?: boolean;
  filename?: string | null;
  install_path?: string | null;
  /** Which library it was found in; only set by the flat all-games list. */
  library?: string;
}

export interface ExeCandidate {
  path: string;
  relative: string;
  score: number;
  executables: string[];
}

export interface GpuInfo {
  names: string[];
  name: string | null;
  gfx: string | null;
  vendor: string | null;
  generation: string | null;
  fsr4: "native" | "int8" | "unsupported" | "unknown";
}

export interface FfxUpscalerInfo {
  present: boolean;
  name: string;
  /** The FidelityFX version OptiScaler's overlay prints in its FFX box. */
  version: string | null;
  fsr4_capable: boolean;
}

export interface Fsr4Status {
  files: Record<string, boolean>;
  ready: boolean;
  required: string[];
  ffx?: FfxUpscalerInfo;
}

export interface Fsr4Source {
  path: string;
  files: string[];
}

export interface InstallInfo {
  path: string;
  installed: boolean;
  filename: string | null;
  managed: boolean;
  version: string | null;
  installed_at: number | null;
  ini_present: boolean;
  ini_path: string;
  log_present: boolean;
  log_path: string;
  candidates: string[];
  extra_proxies: string[];
  backup_dir: string;
  backed_up: string[];
  fsr4: Fsr4Status;
}

export interface IniInfo {
  present: boolean;
  legacy: boolean;
  keys: number;
}

export interface GameDetail {
  path: string;
  name: string;
  ini_info: IniInfo;
  wiki_entry: string | null;
  fsr4_sources: Fsr4Source[];
  gpu: GpuInfo;
  target: string;
  target_is_saved: boolean;
  candidates: ExeCandidate[];
  install: InstallInfo;
  launch_option: string;
  writable: boolean;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  path: string;
  files: {
    name: string;
    present: boolean;
    matches_payload: boolean;
    size: number;
    expected_size: number;
  }[];
  problems: string[];
  complete: boolean;
  ffx_upscaler: { present: boolean; version: string | null; fsr4_capable: boolean };
}

export interface WikiSearchResult {
  name: string;
  page: string | null;
  compatibility: string;
  inputs: string;
  score: number;
}

export interface Recommendation {
  matched: boolean;
  searched: string[];
  entry_count: number;
  list_available: boolean;
  near_misses: { name: string; page: string | null; score: number }[];
  manual?: boolean;
  game: string | null;
  filename: string;
  filename_source: string;
  alternatives: string[];
  compatibility: string | null;
  inputs: string | null;
  notes: string | null;
  optipatcher: boolean;
  wiki_url: string | null;
  detail: Record<string, string>;
  match_score: number | null;
  list_meta: { source: string; fetched_at: number | null; error: string | null };
}

/** One INI key the wiki asked for, with where in the entry it was stated. */
export interface PlannedSetting {
  section: string;
  key: string;
  value: string;
  label: string;
  source: string;
}

/** The frame-generation pairing a wiki entry recommends. */
export interface PlannedFrameGen {
  input: string;
  output: string;
  input_label: string;
  output_label: string;
  source: string;
  detail: string;
}

/**
 * Everything the wiki says about setting one game up, as instructions.
 *
 * `available` is false when no compatibility entry matched, which is what the
 * whole automatic path is gated on: with no entry there is nothing to be
 * automatic about, and the UI offers manual setup alone.
 */
export interface AutoPlan {
  available: boolean;
  /** Whether this game's settings are currently driven by the wiki. */
  enabled?: boolean;
  game: string | null;
  /** "wiki entry" (a page written for this game) or "compatibility list". */
  source: string | null;
  wiki_url: string | null;
  filename: string;
  filename_source: string;
  optipatcher: boolean;
  /** Game arguments to append after %command%, e.g. -dx12. */
  launch_flags: string[];
  /** The complete Steam launch options string, override and arguments. */
  launch_options: string;
  settings: PlannedSetting[];
  framegen: PlannedFrameGen | null;
  /** Things the wiki named that could not be turned into a setting. */
  unresolved: { text: string; source: string }[];
  warnings: string[];
}

export interface AutoPlanResult {
  recommendation: Recommendation;
  plan: AutoPlan;
}

export type ConfigValues = Record<string, Record<string, string>>;

export interface ConfigResult {
  ok: boolean;
  error?: string;
  path?: string;
  values: ConfigValues;
  modified?: number;
}

/** Result of writing config keys, including what the running game adopted. */
export interface WriteConfigResult {
  ok: boolean;
  error?: string;
  applied?: OptionChange[];
  rejected?: OptionChange[];
  written_at?: number;
  live?: LiveApplyResult;
}

export interface LogEntry {
  time: string | null;
  level: string;
  message: string;
}

export interface MonitorReport {
  path: string;
  log_path: string;
  log_present: boolean;
  log_size: number;
  log_modified: number | null;
  logging_enabled: string | null;
  state: Record<string, string | null>;
  counts: Record<string, number>;
  frame_generation: string[];
  problems: LogEntry[];
  recent: LogEntry[];
  hints: string[];
  configured: Record<string, string>;
  total_lines?: number;
  error?: string;
}

export interface OptionChange {
  section: string;
  key: string;
  value: string;
}

export interface RunningGame {
  appid: number;
  name: string;
  gameid: string;
}

/** Whether OptiPatcher is bundled here and installed for one game. */
export interface OptipatcherStatus {
  available: boolean;
  installed: boolean;
  version: string;
}

/** What the in-game live-control plugin reports about itself. */
export interface LiveStatus {
  asi_installed: boolean;
  asi_available: boolean;
  /**
   * Whether the game's copy of the in-game plugin is the one this build ships.
   * Updating the Decky plugin leaves every game on the ASI it was set up with,
   * and an old one attaches and answers normally — it just has nothing to say
   * about anything added since.
   */
  asi_current: boolean | null;
  /** Whether OptiScaler.ini switches ASI loading on at all (defaults to off). */
  load_enabled: boolean | null;
  /** Whether OptiScaler's own log says it loaded the plugin. null = unknown. */
  loaded_by_optiscaler: boolean | null;
  attached: boolean;
  /** Attached *and* finished finding what it needs. */
  ready?: boolean;
  state: string;
  error: string | null;
  seq: string | null;
  can_switch_upscaler: boolean;
  age: number | null;
  live_keys: string[];
  /**
   * Sampled from OptiScaler's own frame counter. Which of the two rates it
   * counts is not fixed, which is why `base_fps` and `total_fps` are derived
   * rather than one of them simply being this.
   */
  fps: number | null;
  /**
   * The rate the game itself renders at, and the rate that reaches the screen.
   * Equal to each other until frame generation is actually inserting frames,
   * and both null when the two intervals could not be matched to the counter.
   */
  base_fps?: number | null;
  total_fps?: number | null;
  /**
   * The two frame intervals it measured, in milliseconds, named after the
   * `State` slots they came out of rather than after a role — which of them is
   * the presented one is decided from the numbers, not from the name.
   */
  rendered_ms?: number | null;
  presented_ms?: number | null;
  /** The raw counter value behind that rate, for diagnostics. */
  frames?: number | null;
  /**
   * How many upscalers OptiScaler has registered. 0 means a switch has nothing
   * to act on yet; null means the count could not be read at all.
   */
  backend_entries?: number | null;
  fg_enabled: boolean | null;
  /**
   * Whether the in-game plugin located the two State flags that make OptiScaler
   * rebuild its frame generator. Without them the FFX FG version can still be
   * recorded, but only the next launch will use it.
   */
  can_change_fg?: boolean;
  /** The FFX FG version the running game is configured for, as an index. */
  fg_index?: number | null;
  /**
   * The frame generators this game's FidelityFX runtime reported, in the order
   * FfxFGIndex numbers them. Empty until the game has asked the SDK.
   */
  ffx_fg_versions?: string[];
  /**
   * The FSR versions this game's FidelityFX runtime reported, in the order
   * FfxUpscalerIndex numbers them — "4.1.1 *", "3.1.5" and so on. This is where
   * the exact version comes from: OptiScaler's own feature parses its name out
   * of this same list, which is why the overlay's title bar can be specific
   * where the backend id ("fsr31") cannot.
   */
  ffx_upscaler_versions?: string[];
  /** Which of them the running game is configured for, as an index. */
  ffx_upscaler_index?: number | null;
  /**
   * Whether the FSR version can be changed without a restart. It needs no flags
   * of its own — the same rebuild that switches upscaler re-reads it — so this
   * is really "there is a list to pick from and an upscaler to rebuild".
   */
  can_change_ffx_upscaler?: boolean;
  /** Which status-file format the installed plugin speaks; older ones say less. */
  schema?: number | null;
  upscaler: { dx12: string | null; dx11: string | null; vulkan: string | null } | null;
  /** A switch handed over but not yet consumed by OptiScaler. */
  pending_backend: string | null;
  /** Where the in-game plugin decided to put its control files. */
  dir?: string | null;
  /** Whether that is the folder being managed. false means it is writing where nobody reads. */
  dir_matches?: boolean | null;
}

/** Outcome of pushing a config write into the running game. */
export interface LiveApplyResult {
  ok?: boolean;
  sent: boolean;
  attached?: boolean;
  reason?: string;
  applied?: string[];
  deferred?: string[];
  backend_change?: boolean;
  can_switch_upscaler?: boolean;
  error?: string;
}
