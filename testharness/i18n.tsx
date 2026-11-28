import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fixtures, invocations } from "@decky/api";
import { QuickPanel } from "../src/components/QuickPanel";
import { ManagerPage } from "../src/components/ManagerPage";
import { GameDetail } from "../src/components/GameDetail";
import { SettingsTab } from "../src/components/SettingsTab";
import {
  classifyLocaleToken,
  detectSystemLocale,
  getLanguagePref,
  getLocale,
  PREF_LANGUAGE,
  resetI18nForTests,
  setBackendLocale,
  setLanguagePref,
  subscribeLocale,
  syncLanguagePrefFromBackend,
  tLocale,
} from "../src/i18n";
import { ZH_CN } from "../src/locales/zh-CN";

const errors: string[] = [];
const warnings: string[] = [];
const origError = console.error;
const origWarn = console.warn;
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(" "));
  origError(...args);
};
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
  origWarn(...args);
};

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed += 1;
    console.log(`  [ok] ${label}`);
  } else {
    const msg = detail ? `${label} (${detail})` : label;
    failures.push(msg);
    console.log(`  [FAIL] ${msg}`);
  }
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const roots: { root: Root; host: HTMLElement }[] = [];
async function mount(element: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const entry = { root, host };
  roots.push(entry);
  await act(async () => {
    root.render(element);
  });
  await settle();
  return {
    host,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      const idx = roots.indexOf(entry);
      if (idx >= 0) roots.splice(idx, 1);
    },
  };
}

function assertNoUnresolvedPlaceholders(label: string, text: string) {
  const matches = text.match(/\{[a-zA-Z0-9_]+\}/g);
  check(`${label}: zero unresolved placeholders`, !matches, matches ? `found: ${matches.join(", ")}` : undefined);
}

const prefsStore = new Map<string, unknown>([
  ["remember_choices", true],
  [PREF_LANGUAGE, "auto"],
]);

const SAMPLE_STATUS = {
  version: "0.0.7.2-testing",
  archive_present: true,
  archive_path: "/plugin/bin/OptiScaler.7z",
  extracted: true,
  extract_path: "/plugin/runtime",
  extractor: "7z",
  optiscaler_version: "0.9.5",
  proxy_filenames: ["dxgi.dll", "winmm.dll"],
  default_proxy: "dxgi.dll",
  locale: "en_US.UTF-8",
};

const SAMPLE_DETAIL = {
  path: "/games/Cyberpunk 2077",
  name: "Cyberpunk 2077",
  target: "/games/Cyberpunk 2077/bin/x64",
  target_is_saved: false,
  candidates: [
    { path: "/games/Cyberpunk 2077/bin/x64", relative: "bin/x64", score: 100, executables: ["Cyberpunk2077.exe"], writable: true },
  ],
  ini_info: { present: true, directory_generation: "1", legacy: false, keys: 4 },
  wiki_entry: "Cyberpunk 2077",
  fsr4_sources: [],
  gpu: { names: ["AMD Custom GPU 0405"], name: "AMD Custom GPU 0405", gfx: "gfx1032", vendor: "amd", generation: "RDNA2", fsr4: "experimental", is_rdna2_apu: true },
  launch_option: 'WINEDLLOVERRIDES="dxgi=n,b" %command%',
  writable: true,
  reframework: { required: false, installed: false, dll: "dinput8.dll", path: "", revision: null, managed: false, plugin: null, plugin_installed: false, plugin_url: null, plugin_name: null, complete: true },
  install: {
    path: "/games/Cyberpunk 2077/bin/x64",
    installed: true,
    filename: "dxgi.dll",
    managed: true,
    version: "0.9.5",
    runtime_current: true,
    installed_at: 1,
    ini_present: true,
    directory_generation: "1",
    ini_path: "/games/Cyberpunk 2077/bin/x64/OptiScaler.ini",
    log_present: false,
    log_path: "",
    candidates: ["dxgi.dll"],
    extra_proxies: [],
    backup_dir: "/games/Cyberpunk 2077/bin/x64/decky_optiscaler_backup_files",
    backed_up: ["dxgi.dll"],
    launch_record: { recorded: true, value: "" },
    rollback: { available: true, version: "0.9.4", launch_pending: false, metadata: { launch_options: "" } },
    fsr4: { files: {}, ready: true, required: [], ffx: { present: true, name: "amd_fidelityfx_upscaler_dx12.dll", version: "4.1.2.0", fsr4_capable: true } },
    reframework: { installed: false, revision: null, managed: false },
  },
};

function setupFixtures() {
  Object.assign(fixtures, {
    get_status: () => ({ ...SAMPLE_STATUS }),
    get_pref: (key: string, fallback?: unknown) => ({
      key,
      value: prefsStore.has(key) ? prefsStore.get(key) : fallback ?? null,
    }),
    set_pref: (key: string, value: unknown) => {
      prefsStore.set(key, value);
      return { ok: true };
    },
    wiki_status: {
      url: "https://github.com/optiscaler/OptiScaler/wiki",
      entry_count: 685,
      available: true,
      source: "cache",
      fetched_at: Date.now() / 1000 - 3600 * 3,
      age: 3600 * 3,
      stale: false,
      revision: "rev-1",
      revalidating: false,
      last_attempt: null,
      error: null,
      tls: "system",
      cache_path: "/tmp/wiki.md",
    },
    list_libraries: [{ path: "/games", name: "Internal Storage", source: "steam", game_count: 1, available: true }],
    list_all_games: [{ appid: "1091500", name: "Cyberpunk 2077", path: "/games/Cyberpunk 2077", source: "steam", size_on_disk: 1, installed: true, filename: "dxgi.dll", library: "Internal Storage" }],
    find_running_game: () => ({ found: true, path: SAMPLE_DETAIL.path, name: SAMPLE_DETAIL.name, detail: SAMPLE_DETAIL }),
    get_game: () => SAMPLE_DETAIL,
    get_auto_plan: {
      plan: {
        available: true,
        game: "Cyberpunk 2077",
        filename: "dxgi.dll",
        settings: [{ section: "Spoofing", key: "Dxgi", value: "false" }],
        framegen: { input: "fsrfg", output: "fsrfg", input_label: "FSR 3.1 FG", output_label: "FSR FG", source: "wiki" },
      },
      recommendation: {
        matched: true,
        game: "Cyberpunk 2077",
        compatibility: "Works",
        filename: "dxgi.dll",
        filename_source: "wiki",
        alternatives: [],
        inputs: "DLSS, FSR2+, XeSS",
        list_available: true,
        entry_count: 685,
        detail: {},
        list_meta: { revision: "rev-1" },
      },
      auto: true,
    },
    get_live_status: {
      supported: true,
      ready: true,
      attached: true,
      asi_installed: true,
      asi_current: true,
      asi_available: true,
      load_enabled: true,
      dir_verified: true,
      dir_matches: true,
      schema: 7,
      state: "ready",
      session: "sess-1",
      active_api: "dx12",
      capability_generation: "gen-1",
      fps: 55,
      fg_enabled: false,
      telemetry_ready: true,
      telemetry_source: "core_intervals",
      present_path_fps: 54.8,
      presented_ms: 18.2,
      upscaler: { dx12: "fsr31", dx11: "fsr31", vulkan: "fsr31" },
      ffx_upscaler_versions: ["4.1.2", "3.1.5"],
      ffx_upscaler_index: 0,
      live_keys: ["FrameGen.Enabled"],
      capabilities: { "FrameGen.Enabled": true, fg_enable: true, set_scalar: true },
    },
    read_config: () => ({ ok: true, values: { Upscalers: { Dx12Upscaler: "fsr31" }, FSR: { Fsr4Update: "true" } }, runtime_current: true, fsr4_build: "bundled" }),
    get_monitor: {
      path: SAMPLE_DETAIL.target,
      log_path: `${SAMPLE_DETAIL.target}/OptiScaler.log`,
      log_present: false,
      log_size: 0,
      log_modified: null,
      logging_enabled: "false",
      state: {},
      counts: {},
      frame_generation: [],
      problems: [],
      recent: [],
      hints: [],
      configured: {},
    },
    get_launch_options: () => ({ found: true, value: 'WINEDLLOVERRIDES="dxgi=n,b" %command%', source: "harness" }),
    verify_install: () => ({
      complete: true,
      problems: [],
      ffx_upscaler: { present: true, name: "amd_fidelityfx_upscaler_dx12.dll", version: "4.1.2.0", fsr4_capable: true },
    }),
    get_fsr4_info: () => ({ status: { build: { id: "bundled", label: "Official 4.1.2", known: true } } }),
    get_optipatcher_status: () => ({ available: true, installed: false, version: "0.2.0" }),
  });
}

function testLocaleDetection() {
  console.log("=== 1. Locale classification & fallback priority ===");
  for (const token of ["schinese", "zh-CN", "zh_CN.UTF-8", "zh-Hans", "zh-Hans-CN", "zh-SG", "zh"]) {
    check(`classifyLocaleToken("${token}") === "zh-CN"`, classifyLocaleToken(token) === "zh-CN");
  }
  for (const token of ["zh-TW", "zh_TW.UTF-8", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW", "tchinese", "en-US", "ja-JP", "ko-KR"]) {
    check(`classifyLocaleToken("${token}") === "en"`, classifyLocaleToken(token) === "en");
  }
  for (const token of ["", "C", "POSIX", "C.UTF-8"]) {
    check(`classifyLocaleToken("${token}") === null`, classifyLocaleToken(token) === null);
  }

  const win = window as any;
  const prevLocMgr = win.LocalizationManager;
  const prevGStr = win.g_strLanguage;
  const prevDocLang = document.documentElement.lang;
  const prevNavLang = Object.getOwnPropertyDescriptor(navigator, "language");
  const prevNavLangs = Object.getOwnPropertyDescriptor(navigator, "languages");

  try {
    // 1. Steam UI schinese wins over browser en-US
    win.LocalizationManager = { m_rgLocalesToUse: ["schinese"] };
    win.g_strLanguage = "english";
    document.documentElement.lang = "en-US";
    Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
    Object.defineProperty(navigator, "languages", { value: ["en-US"], configurable: true });
    check("Steam LocalizationManager schinese overrides browser en-US", detectSystemLocale("en_US.UTF-8") === "zh-CN");

    // 2. Steam tchinese explicitly resolves to "en" (never zh-CN)
    win.LocalizationManager = { m_rgLocalesToUse: ["tchinese"] };
    win.g_strLanguage = "schinese";
    check("Steam tchinese resolves to en (does not fall through to g_strLanguage)", detectSystemLocale("zh_CN.UTF-8") === "en");

    // 3. Steam g_strLanguage schinese works when LocalizationManager absent
    win.LocalizationManager = undefined;
    win.g_strLanguage = "schinese";
    check("Steam g_strLanguage schinese resolves to zh-CN", detectSystemLocale("en_US.UTF-8") === "zh-CN");

    // 4. Browser navigator.languages zh-CN works when Steam globals absent
    win.g_strLanguage = undefined;
    document.documentElement.lang = "";
    Object.defineProperty(navigator, "languages", { value: ["zh-CN", "en-US"], configurable: true });
    check("navigator.languages zh-CN resolves to zh-CN", detectSystemLocale("en_US.UTF-8") === "zh-CN");

    // 5. Browser zh-TW stays en and blocks backend zh_CN fallback
    Object.defineProperty(navigator, "languages", { value: ["zh-TW"], configurable: true });
    Object.defineProperty(navigator, "language", { value: "zh-TW", configurable: true });
    check("navigator zh-TW resolves to en even with zh_CN backend locale", detectSystemLocale("zh_CN.UTF-8") === "en");

    // 6. Backend OS locale fallback applies ONLY when Steam & browser report nothing explicit
    Object.defineProperty(navigator, "languages", { value: [], configurable: true });
    Object.defineProperty(navigator, "language", { value: "", configurable: true });
    check("backend zh_CN.UTF-8 fallback applies when Steam & browser are empty", detectSystemLocale("zh_CN.UTF-8") === "zh-CN");
    check("backend ja_JP.UTF-8 fallback resolves to en", detectSystemLocale("ja_JP.UTF-8") === "en");
    check("empty fallback defaults to en", detectSystemLocale(null) === "en");
  } finally {
    win.LocalizationManager = prevLocMgr;
    win.g_strLanguage = prevGStr;
    document.documentElement.lang = prevDocLang;
    if (prevNavLang) Object.defineProperty(navigator, "language", prevNavLang);
    if (prevNavLangs) Object.defineProperty(navigator, "languages", prevNavLangs);
  }

  // Dictionary sanity: placeholders in every zh-CN value match English key placeholders
  let placeholderMismatches = 0;
  for (const [en, zh] of Object.entries(ZH_CN)) {
    const enVars = Array.from(new Set(en.match(/\{[a-zA-Z0-9_]+\}/g) ?? [])).sort().join(",");
    const zhVars = Array.from(new Set(zh.match(/\{[a-zA-Z0-9_]+\}/g) ?? [])).sort().join(",");
    if (enVars !== zhVars) {
      placeholderMismatches += 1;
      console.log(`  [WARN] placeholder mismatch: "${en}" (${enVars}) -> "${zh}" (${zhVars})`);
    }
  }
  check("all ZH_CN dictionary entries preserve exact placeholder keys", placeholderMismatches === 0);
  check("tLocale interpolates variables in zh-CN",
    tLocale("zh-CN", "{count} games on the list", { count: 42 }) === "列表已收录 42 款游戏");
}

async function testZhCnRenderingAndSwitcher() {
  console.log("=== 2. Simplified Chinese UI rendering & language switcher ===");
  setupFixtures();
  resetI18nForTests("zh-CN", null);
  prefsStore.set(PREF_LANGUAGE, "zh-CN");

  // QuickPanel in zh-CN
  const qp = await mount(
    <QuickPanel
      runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
      onOpenManager={() => {}}
    />,
  );
  const qpText = qp.host.textContent ?? "";
  check("QuickPanel renders natural zh-CN labels",
    qpText.includes("正在游玩") &&
    qpText.includes("游戏列表") &&
    qpText.includes("帧生成") &&
    qpText.includes("超分辨率") &&
    qpText.includes("预估帧率") &&
    qpText.includes("全部设置与日志"));
  assertNoUnresolvedPlaceholders("QuickPanel zh-CN", qpText);
  await qp.unmount();

  // ManagerPage in zh-CN
  const mp = await mount(<ManagerPage />);
  const mpText = mp.host.textContent ?? "";
  check("ManagerPage renders zh-CN top-level tabs",
    mpText.includes("游戏列表") && mpText.includes("游戏库") && mpText.includes("插件设置"));
  assertNoUnresolvedPlaceholders("ManagerPage zh-CN", mpText);
  await mp.unmount();

  // GameDetail in zh-CN: Basic, Setup, Manual setup, Logs, and Advanced
  const gd = await mount(
    <GameDetail
      gamePath={SAMPLE_DETAIL.path}
      gameName={SAMPLE_DETAIL.name}
      appid="1091500"
      status={SAMPLE_STATUS}
      runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
      onBack={() => {}}
    />,
  );
  const basicText = gd.host.textContent ?? "";
  check("GameDetail Basic renders zh-CN",
    basicText.includes("安装向导") &&
    basicText.includes("基础设置") &&
    basicText.includes("基础") &&
    basicText.includes("高级") &&
    basicText.includes("呈现路径帧率") &&
    basicText.includes("全部 OptiScaler 高级选项"));
  assertNoUnresolvedPlaceholders("GameDetail Basic zh-CN", basicText);

  // Switch to Setup tab
  const setupTabBtn = gd.host.querySelector<HTMLElement>('[data-tab-button="install"]');
  await act(async () => { setupTabBtn?.click(); });
  await settle();
  const setupText = gd.host.textContent ?? "";
  check("GameDetail Setup renders zh-CN",
    setupText.includes("还原至升级前版本") &&
    setupText.includes("按 Wiki 重新配置") &&
    setupText.includes("彻底移除") &&
    setupText.includes("手动安装") &&
    setupText.includes("运行日志"));
  assertNoUnresolvedPlaceholders("GameDetail Setup zh-CN", setupText);

  // Open Logs view
  const logsField = [...gd.host.querySelectorAll<HTMLElement>('[data-mock="Field"]')]
    .find((node) => node.getAttribute("data-label") === "运行日志");
  await act(async () => { logsField?.click(); });
  await settle();
  const logsText = gd.host.textContent ?? "";
  check("GameDetail Logs renders zh-CN",
    logsText.includes("运行监控") && logsText.includes("写入 OptiScaler 日志"));
  assertNoUnresolvedPlaceholders("GameDetail Logs zh-CN", logsText);

  // Return to checklist and open Manual setup
  const backBtn = gd.host.querySelector<HTMLElement>('[data-back="setup"]');
  await act(async () => { backBtn?.click(); });
  await settle();
  const manualField = [...gd.host.querySelectorAll<HTMLElement>('[data-mock="Field"]')]
    .find((node) => node.getAttribute("data-label") === "手动安装");
  await act(async () => { manualField?.click(); });
  await settle();
  const manualText = gd.host.textContent ?? "";
  check("GameDetail Manual setup renders zh-CN",
    manualText.includes("已安装文件与 FSR 4") &&
    manualText.includes("游戏内实时调节") &&
    manualText.includes("安装 OptiPatcher"));
  assertNoUnresolvedPlaceholders("GameDetail Manual zh-CN", manualText);

  // Switch to Advanced mode
  const modeSwitch = gd.host.querySelector<HTMLElement>('[data-mode-switch]');
  await act(async () => { modeSwitch?.click(); });
  await settle();
  const advText = gd.host.textContent ?? "";
  check("GameDetail Advanced tabs render zh-CN",
    advText.includes("帧生成") &&
    advText.includes("超分辨率") &&
    advText.includes("HUD 修复") &&
    advText.includes("画质调节") &&
    advText.includes("兼容性") &&
    advText.includes("游戏内浮层"));
  assertNoUnresolvedPlaceholders("GameDetail Advanced zh-CN", advText);
  await gd.unmount();

  // Plugin Settings language switcher live re-render + persistence
  invocations.length = 0;
  resetI18nForTests("auto", null);
  prefsStore.set(PREF_LANGUAGE, "auto");
  const st = await mount(<SettingsTab status={SAMPLE_STATUS} />);
  check("SettingsTab starts in English under auto/en",
    (st.host.textContent ?? "").includes("Remembered answers") &&
    (st.host.textContent ?? "").includes("Language / 语言") &&
    st.host.querySelector('[data-mock="DropdownItem"][data-label="Language / 语言"]')?.getAttribute("data-selected") === "auto");

  // Switching auto -> same-locale manual ("en") must re-render DropdownItem selectedOption
  const sameEnOpt = st.host.querySelector<HTMLElement>(
    '[data-mock="DropdownItem"][data-label="Language / 语言"] [data-opt-value="en"]',
  );
  await act(async () => { sameEnOpt?.click(); });
  await settle();
  check("Switching auto -> en (same effective locale) re-renders selected pref immediately",
    getLanguagePref() === "en" &&
    st.host.querySelector('[data-mock="DropdownItem"][data-label="Language / 语言"]')?.getAttribute("data-selected") === "en");

  // Pick zh-CN from dropdown
  const zhOpt = st.host.querySelector<HTMLElement>(
    '[data-mock="DropdownItem"][data-label="Language / 语言"] [data-opt-value="zh-CN"]',
  );
  check("Language / 语言 dropdown offers 简体中文 option", Boolean(zhOpt));
  await act(async () => { zhOpt?.click(); });
  await settle();
  check("Selecting 简体中文 switches UI immediately and persists pref",
    getLanguagePref() === "zh-CN" &&
    getLocale() === "zh-CN" &&
    (st.host.textContent ?? "").includes("已记住的选择") &&
    (st.host.textContent ?? "").includes("兼容性列表") &&
    invocations.some((c) => c.name === "set_pref" && c.args[0] === PREF_LANGUAGE && c.args[1] === "zh-CN"));
  assertNoUnresolvedPlaceholders("SettingsTab zh-CN", st.host.textContent ?? "");

  // Pick English back
  const enOpt = st.host.querySelector<HTMLElement>(
    '[data-mock="DropdownItem"][data-label="Language / 语言"] [data-opt-value="en"]',
  );
  await act(async () => { enOpt?.click(); });
  await settle();
  check("Selecting English switches UI back immediately",
    getLocale() === "en" &&
    (st.host.textContent ?? "").includes("Remembered answers") &&
    invocations.some((c) => c.name === "set_pref" && c.args[0] === PREF_LANGUAGE && c.args[1] === "en"));

  await st.unmount();

  // Verify setBackendLocale triggers reactive re-render when pref === "auto"
  resetI18nForTests("auto", null);
  setBackendLocale(null);
  await setLanguagePref("en", false);
  check("explicit en pref ignores backend zh_CN locale", getLocale() === "en");
}

async function testSyncLanguagePrefRace() {
  console.log("=== 3. syncLanguagePrefFromBackend stale response race ===");
  setupFixtures();
  resetI18nForTests("auto", null);
  prefsStore.set(PREF_LANGUAGE, "en");

  let resolveGetPref!: (result: { key: string; value: unknown }) => void;
  const deferredGetPref = new Promise<{ key: string; value: unknown }>((resolve) => {
    resolveGetPref = resolve;
  });
  fixtures.get_pref = (key: string, fallback?: unknown) => {
    if (key === PREF_LANGUAGE) return deferredGetPref;
    return { key, value: prefsStore.has(key) ? prefsStore.get(key) : fallback ?? null };
  };

  // Start initial backend sync before user switches language
  const syncPromise = syncLanguagePrefFromBackend(true);

  // User changes language to zh-CN while getPref is still in flight
  await setLanguagePref("zh-CN");
  check("setLanguagePref updates state immediately while backend sync is pending",
    getLanguagePref() === "zh-CN" &&
    getLocale() === "zh-CN" &&
    window.localStorage.getItem("decky-optiscaler:language") === "zh-CN");

  let staleNotified = false;
  const unsubscribe = subscribeLocale(() => {
    staleNotified = true;
  });

  // Stale getPref response ("en") arrives after user's explicit zh-CN change
  resolveGetPref({ key: PREF_LANGUAGE, value: "en" });
  const syncedResult = await syncPromise;
  unsubscribe();

  check("stale syncLanguagePrefFromBackend response does not overwrite user's newer languagePref",
    syncedResult === "zh-CN" &&
    getLanguagePref() === "zh-CN" &&
    getLocale() === "zh-CN" &&
    window.localStorage.getItem("decky-optiscaler:language") === "zh-CN" &&
    !staleNotified);

  // Overlapping syncLanguagePrefFromBackend(true) calls resolving out of order:
  // newer sync ("zh-CN") resolves first, older slower sync ("en") resolves later and must be ignored.
  resetI18nForTests("auto", null);
  const deferredResolvers: Array<(result: { key: string; value: unknown }) => void> = [];
  fixtures.get_pref = (key: string, fallback?: unknown) => {
    if (key === PREF_LANGUAGE) {
      return new Promise<{ key: string; value: unknown }>((resolve) => {
        deferredResolvers.push(resolve);
      });
    }
    return { key, value: prefsStore.has(key) ? prefsStore.get(key) : fallback ?? null };
  };

  const olderSync = syncLanguagePrefFromBackend(true);
  const newerSync = syncLanguagePrefFromBackend(true);
  check("overlapping force syncs dispatch two concurrent get_pref requests",
    deferredResolvers.length === 2);

  // Newer sync resolves first with "zh-CN"
  deferredResolvers[1]({ key: PREF_LANGUAGE, value: "zh-CN" });
  const newerResult = await newerSync;
  check("newer concurrent sync updates languagePref to zh-CN",
    newerResult === "zh-CN" &&
    getLanguagePref() === "zh-CN" &&
    window.localStorage.getItem("decky-optiscaler:language") === "zh-CN");

  let olderNotified = false;
  const unsubOlder = subscribeLocale(() => {
    olderNotified = true;
  });

  // Older slower sync resolves afterward with stale "en"
  deferredResolvers[0]({ key: PREF_LANGUAGE, value: "en" });
  const olderResult = await olderSync;
  unsubOlder();

  check("older overlapping syncLanguagePrefFromBackend(true) does not overwrite newer sync result",
    olderResult === "zh-CN" &&
    getLanguagePref() === "zh-CN" &&
    getLocale() === "zh-CN" &&
    window.localStorage.getItem("decky-optiscaler:language") === "zh-CN" &&
    !olderNotified);

  // setLanguagePref() before initial syncLanguagePrefFromBackend():
  // even if setPref fails/has not flushed yet and backend still holds "en", initial sync must not clobber user choice.
  resetI18nForTests("auto", null);
  let getPrefCallsAfterSet = 0;
  fixtures.set_pref = () => {
    throw new Error("simulated backend save failure");
  };
  fixtures.get_pref = (key: string, fallback?: unknown) => {
    if (key === PREF_LANGUAGE) {
      getPrefCallsAfterSet += 1;
      return { key, value: "en" };
    }
    return { key, value: prefsStore.has(key) ? prefsStore.get(key) : fallback ?? null };
  };

  await setLanguagePref("zh-CN");
  const initialSyncAfterSet = await syncLanguagePrefFromBackend();
  check("initial syncLanguagePrefFromBackend() after setLanguagePref() does not overwrite explicit choice",
    initialSyncAfterSet === "zh-CN" &&
    getLanguagePref() === "zh-CN" &&
    getLocale() === "zh-CN" &&
    window.localStorage.getItem("decky-optiscaler:language") === "zh-CN" &&
    getPrefCallsAfterSet === 0);

  setupFixtures();
}

async function main() {
  testLocaleDetection();
  await testZhCnRenderingAndSwitcher();
  await testSyncLanguagePrefRace();

  for (const entry of [...roots]) {
    await act(async () => {
      entry.root.unmount();
    });
    entry.host.remove();
  }
  console.log(`\n=== React errors/warnings: ${errors.length + warnings.length} ===`);
  if (errors.length) console.log("Errors:\n" + errors.join("\n"));
  if (warnings.length) console.log("Warnings:\n" + warnings.join("\n"));
  console.log(`=== i18n checks passed: ${passed}, failed: ${failures.length} ===`);
  if (failures.length || errors.length || warnings.length) {
    for (const f of failures) console.log(`  ! ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  origError(err);
  process.exit(1);
});
