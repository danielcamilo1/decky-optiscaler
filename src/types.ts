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
  writable?: boolean;
}

export interface GpuInfo {
  names: string[];
  name: string | null;
  gfx: string | null;
  vendor: string | null;
  generation: string | null;
  fsr4: "native" | "int8" | "experimental" | "unsupported" | "unknown";
}

export interface FfxUpscalerInfo {
  present: boolean;
  name: string;
  /** The FidelityFX version OptiScaler's overlay prints in its FFX box. */
  version: string | null;
  fsr4_capable: boolean;
}

/** Which FSR 4 upscaler build is in the game folder.
 *
 * `known` is false for a file that hashes to nothing this plugin pins: it is
 * still reported — with its hash — rather than being passed off as the one the
 * release carries. Which build it is cannot be read from a version number,
 * because the modelled 4.1.1b reports exactly what the released SDK reports. */
export interface Fsr4Build {
  known: boolean;
  id: string | null;
  label: string;
  note: string;
  /** "int8" (the override) or "upgrade" (the FSR 3 → FSR 4 path). */
  reaches_fsr4_by: string | null;
  sha256: string | null;
  bytes: number;
}

export interface Fsr4Status {
  files: Record<string, boolean>;
  ready: boolean;
  required: string[];
  ffx?: FfxUpscalerInfo;
  build?: Fsr4Build | null;
}

export interface Fsr4Source {
  path: string;
  files: string[];
}

/** The Steam launch options a game had before OptiScaler was installed. */
export interface LaunchRecord {
  /** False when nothing was kept — an older install, or Steam would not say. */
  recorded: boolean;
  /** Recorded and empty means the game genuinely had none. */
  value: string;
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
  launch_record: LaunchRecord;
  /** True only when the installed OptiScaler proxy matches this plugin's pinned runtime hash. */
  runtime_current?: boolean;
  /** Explicit rollback retains the old install for this bundled runtime. */
  runtime_upgrade_held?: boolean;
  runtime_recovery_needed?: boolean;
  /** A preserved pre-upgrade snapshot that can still be restored. */
  rollback?: {
    available: boolean;
    version?: string;
    metadata?: Record<string, unknown>;
  };
  fsr4: Fsr4Status;
  /**
   * Whether REFramework's dll is next to the executable, and whether this
   * plugin is the one that put it there. Read from the folder rather than the
   * manifest: the step is "is REF present", not "did we install REF", and
   * somebody's own working copy counts.
   */
  reframework: { installed: boolean; revision: string | null; managed: boolean };
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
  /** Backend-confirmed canonical PBZ.exe folder, null if missing. */
  pbz_target?: string | null;
  pbz_identity?: boolean;
  candidates: ExeCandidate[];
  install: InstallInfo;
  launch_option: string;
  reframework: ReframeworkStatus;
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

/** Why the compatibility list is or is not answering. */
export interface WikiStatus {
  url: string;
  entry_count: number;
  available: boolean;
  /** "cache" (last good fetch), "bundled" (shipped with the plugin), or "none". */
  source: string | null;
  fetched_at: number | null;
  /** Seconds since it was fetched, or null when there is no list at all. */
  age: number | null;
  stale: boolean;
  /** Content fingerprint; changes when a background refresh brought something new. */
  revision: string;
  /** True while a refresh is running behind the answer already given. */
  revalidating: boolean;
  last_attempt: number | null;
  /** The failure verbatim — the sentence that says which problem this is. */
  error: string | null;
  /** Which CA source the last successful fetch used. */
  tls: string | null;
  cache_path: string;
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
  /** The wiki detail page behind this answer, when there is one. */
  page?: string | null;
  /**
   * True when this game has a wiki page that is not cached yet. The answer is
   * the compatibility-list row; a fuller one is being fetched behind it.
   */
  detail_pending?: boolean;
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
  list_meta: {
    source: string;
    fetched_at: number | null;
    error: string | null;
    /** Whether a background refresh is worth waiting a moment for. */
    stale?: boolean;
    /** Content fingerprint: when this changes, the list behind the answer did. */
    revision?: string;
  };
}

/** One INI key the wiki asked for, with where in the entry it was stated. */
export interface PlannedSetting {
  section: string;
  key: string;
  value: string;
  label: string;
  source: string;
}

/**
 * REFramework, for the RE Engine games that cannot host OptiScaler without it.
 *
 * `automatic` is the whole question: when it is true this plugin can fetch the
 * right build itself, and when it is false `reason` says why not and `page` is
 * where to get it by hand. `plugin` is the one file that is never automatic —
 * PureDark's UpscalerBasePlugin lives behind a Nexus Mods login — so the pd
 * entries name it and link it instead of pretending it has been handled.
 */
export interface PlannedReframework {
  required: boolean;
  /** "nightly" (praydog's unified build) or "pd-upscaler" (per game). */
  variant: string;
  dll: string;
  /** The WINEDLLOVERRIDES stem REFramework needs from Proton. */
  override: string;
  source: string;
  detail: string;
  asset: string | null;
  url: string | null;
  page: string;
  plugin: string | null;
  plugin_name: string | null;
  plugin_url: string | null;
  automatic: boolean;
  reason: string | null;
}

/** What is actually next to the executable, against what the entry asked for. */
export interface ReframeworkStatus {
  required: boolean;
  installed: boolean;
  dll: string;
  path: string;
  revision: string | null;
  plugin: string | null;
  plugin_installed: boolean;
  plugin_url: string | null;
  plugin_name: string | null;
  /**
   * Whether everything this game needs is actually present. REFramework in and
   * OptiScaler in is not the same as "this game will do anything": the
   * pd-upscaler games do not upscale at all until PDPerfPlugin.dll is there,
   * and without this the panel reports a live, connected, entirely inert
   * install as working.
   */
  complete: boolean;
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
  /**
   * The overlay shortcut this plan changes, when an entry asks for one. Several
   * REFramework games do, because REF's overlay uses Insert too — and applying
   * that without saying so is how "Insert does nothing" gets reported as the
   * overlay being broken, when it had simply moved.
   */
  hotkey: { value: string; name: string | null; source: string } | null;
  /** Set only for the games whose entry says OptiScaler needs REFramework. */
  reframework: PlannedReframework | null;
  /** Things the wiki named that could not be turned into a setting. */
  unresolved: { text: string; source: string }[];
  warnings: string[];
  /** Whether the bundled runtime can satisfy this game's stated minimum. */
  runtime_supported?: boolean;
  required_version?: string | null;
  required_target?: string | null;
  manual_steps?: string[];
  blocked_reason?: string | null;
}

export interface AutoPlanResult {
  recommendation: Recommendation;
  plan: AutoPlan;
}

export type ConfigValues = Record<string, Record<string, string>>;

export interface ConfigResult {
  fsr4_build?: string | null;
  ok: boolean;
  error?: string;
  path?: string;
  values: ConfigValues;
  modified?: number;
  /** Writes are allowed only when true; false or missing capability metadata is read-only. */
  runtime_current?: boolean;
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
  /** Identity captured when a live-capable value was picked. */
  live_context?: LiveContext;
}

export type LiveApi = "dx11" | "dx12" | "vulkan";

/** Snapshot identity a dynamic live choice was made against. */
export interface LiveContext {
  target: string;
  session: string;
  /** Scalar actions can be safe before OptiScaler has identified an API. */
  active_api: LiveApi | "unknown";
  capability_generation: string;
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
  /** Explicit false means this runtime is not allowed to use the legacy live ABI. */
  supported?: boolean;
  reason?: string | null;
  /** Whether safe Add/Reinstall is possible for this managed target. */
  can_install?: boolean;
  /** The native module is still running, including unsupported legacy builds. */
  legacy_running?: boolean;
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
  /** Schema 7 session identity. Missing on legacy status is never permission to write. */
  session?: string | null;
  /** Terminal state of the last command mailbox entry, when reported. */
  ack?: "pending" | "config_request_accepted" | "rejected" | "timeout" | string;
  /** The graphics API currently used by the running game. */
  active_api?: LiveApi | "unknown";
  /** Changes when the selected API or either ordered FFX list changes. */
  capability_generation?: string | null;
  /** Identity retained for the last configuration request, independent of current capabilities. */
  request_session?: string | null;
  request_api?: LiveApi | "unknown" | null;
  request_generation?: string | null;
  /** Keys accepted for the current session/sequence only. */
  accepted_keys?: string[];
  /** Keys the native plugin could not apply for the current session/sequence. */
  failed_keys?: string[];
  /** Explicit per-target field and action capabilities. */
  capabilities?: Record<string, boolean>;
  can_change_opti_fg?: boolean;
  can_change_hud_fix?: boolean;
  can_change_fsr_debug_view?: boolean;
  can_switch_upscaler: boolean;
  switchable_backends?: string[];
  can_override_sharpness?: boolean;
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
  /** Whether this snapshot contains fresh frame telemetry, independent of command readiness. */
  telemetry_ready?: boolean;
  /** How telemetry was measured; core intervals alone do not reveal an FG multiplier. */
  telemetry_source?: "state_present_counter" | "core_intervals" | "unknown" | string;
  /** FPS derived from the presented interval. This is a present path rate, not scanout or FG total. */
  present_path_fps?: number | null;
  /** Configured setting, separate from runtime FG object activity in `fg_enabled`. */
  configured_fg_enabled?: boolean | null;
  /** Configured FidelityFX FG index, separate from the runtime-observed `fg_index`. */
  configured_fg_index?: number | null;
  /** Configured FidelityFX upscaler index, separate from the runtime-observed index. */
  configured_ffx_upscaler_index?: number | null;
  /** Configured backend IDs, separate from the runtime-observed `upscaler` values. */
  configured_upscaler?: { dx12: string | null; dx11: string | null; vulkan: string | null } | null;
  /** Age of the last runtime feature progress sample, in milliseconds. */
  feature_progress_age_ms?: number | null;
  /** The raw counter value behind that rate, for diagnostics. */
  frames?: number | null;
  /**
   * How many upscalers OptiScaler has registered. 0 means a switch has nothing
   * to act on yet; null means the count could not be read at all.
   */
  backend_entries?: number | null;
  /** Whether the running game has an active frame-generator object, not its INI setting. */
  fg_enabled: boolean | null;
  /**
   * Whether the in-game plugin located the two State flags that make OptiScaler
   * rebuild its frame generator. Without them the FFX FG version can still be
   * recorded, but only the next launch will use it.
   */
  can_change_fg?: boolean;
  /** Native proved enabling this FG path can succeed without a restart. */
  can_enable_fg?: boolean;
  /** The active FFX FG version observed in the running game, as an index. */
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
  /** Runtime IDs aligned with `ffx_upscaler_versions`, when available. */
  ffx_upscaler_ids?: string[];
  /** Exact runtime IDs that cannot be changed until the next game launch. */
  /** Which FFX upscaler the running game is actually using, as an index. */
  ffx_upscaler_index?: number | null;
  /**
   * Whether the FSR version can be changed without a restart. It needs no flags
   * of its own — the same rebuild that switches upscaler re-reads it — so this
   * is really "there is a list to pick from and an upscaler to rebuild".
   */
  can_change_ffx_upscaler?: boolean;
  /** Which status-file format the installed plugin speaks; older ones say less. */
  schema?: number | null;
  /** Whether native code verified the live-control directory identity. */
  dir_verified?: boolean;
  /** Wine prefix that owns the live-control directory, if reported. */
  wine_prefix?: string | null;
  /** Native target-directory generation used to bind commands to an install. */
  directory_generation?: string | null;
  /** Runtime FFX FG identities aligned with `ffx_fg_versions`. */
  ffx_fg_ids?: string[];
  upscaler: { dx12: string | null; dx11: string | null; vulkan: string | null } | null;
  /** A switch handed over but not yet consumed by OptiScaler. */
  pending_backend: string | null;
  /** Verified canonical Linux folder used by RPC contexts. */
  dir?: string | null;
  /** Original Windows folder reported by the ASI, for diagnostics. */
  native_dir?: string | null;
  /** Whether that is the folder being managed. false means it is writing where nobody reads. */
  dir_matches?: boolean | null;
}

/** Outcome of pushing a config write into the running game. */
export interface LiveApplyResult {
  ok?: boolean;
  sent: boolean;
  /** Exact Section.Key IDs included in the native wire command. */
  sent_keys?: string[];
  /** Selection-independent identity of the command as it was actually sent. */
  context?: LiveContext | null;
  /** Physical directory authorization under which this request was accepted. */
  directory_generation?: string | null;
  /** True only when the matching session and decimal sequence reached a terminal ACK. */
  confirmed?: boolean;
  ack?: "pending" | "config_request_accepted" | "rejected" | "timeout" | string;
  session?: string | null;
  seq?: string | null;
  /** Exact Section.Key IDs accepted as configuration requests by the native plugin. */
  accepted_keys?: string[];
  attached?: boolean;
  reason?: string;
  deferred?: string[];
  failed_keys?: string[];
  backend_change?: boolean;
  can_switch_upscaler?: boolean;
  error?: string;
}
