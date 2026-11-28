import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  fixtures,
  invocations,
  resetFilePicker,
  setFilePicker,
  toasts,
} from "@decky/api";
import { Router, shownModals } from "@decky/ui";
import { BasicPanel } from "../src/components/BasicPanel";
import { Fsr4Panel } from "../src/components/Fsr4Panel";
import { GamesList } from "../src/components/GamesList";
import { InstallPanel } from "../src/components/InstallPanel";
import { LibraryBrowser } from "../src/components/LibraryBrowser";
import { MonitorTab } from "../src/components/MonitorTab";
import { OptipatcherPanel } from "../src/components/OptipatcherPanel";
import { SettingsTab } from "../src/components/SettingsTab";
import { SetupChecklist } from "../src/components/SetupChecklist";
import { WikiSearch } from "../src/components/WikiSearch";
import { useRunningGame } from "../src/hooks/useRunningGame";
import { setAppliedLaunchMetadata } from "../src/prefs";
import type { AutoPlan, Game, GameDetail, GpuInfo, PayloadStatus, RunningGame } from "../src/types";
import { installVirtualClock } from "./virtual-clock";

const clock = installVirtualClock();
const errors: string[] = [];
const failures: string[] = [];
const originalError = console.error;
const originalWarn = console.warn;
console.error = (...args: any[]) => {
  errors.push(args.map(String).join(" "));
  originalError(...args);
};
console.warn = (...args: any[]) => {
  errors.push(args.map(String).join(" "));
  originalWarn(...args);
};

function check(label: string, cond: boolean, detail?: string) {
  if (!cond) failures.push(detail ? `${label} (${detail})` : label);
  console.log(`  [${cond ? "ok" : "FAIL"}] ${label}${!cond && detail ? ` — ${detail}` : ""}`);
}

function findAll(node: Element, selector: string) {
  return Array.from(node.querySelectorAll<HTMLElement>(selector));
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  descriptor?.set?.call(input, value);
}

async function settle(ms = 20) {
  await clock.advance(ms);
}

async function mount(element: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
  });
  await settle();
  return {
    host,
    root,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

async function respondLatestModal(action: "ok" | "cancel") {
  const modalElement = shownModals[shownModals.length - 1];
  if (!modalElement) return false;
  let closed = false;
  const view = await mount(
    React.cloneElement(modalElement, { closeModal: () => { closed = true; } }),
  );
  try {
    const btn = view.host.querySelector<HTMLElement>(
      action === "ok" ? "[data-modal-ok]" : "[data-modal-cancel]",
    );
    if (btn) {
      await act(async () => {
        btn.click();
        await Promise.resolve();
      });
    }
    return closed;
  } finally {
    await view.unmount();
  }
}

const DECK_GPU: GpuInfo = {
  names: ["Van Gogh (Steam Deck)"],
  name: "Van Gogh (Steam Deck)",
  gfx: "gfx1033",
  vendor: "amd",
  generation: "RDNA2",
  fsr4: "experimental",
  is_rdna2_apu: true,
};

const BUNDLE_STATUS: PayloadStatus = {
  version: "0.9.5",
  archive_present: true,
  archive_path: "/p/bin/OptiScaler.7z",
  extracted: true,
  extract_path: "/p/payload",
  extractor: "7z",
  optiscaler_version: "0.9.5",
  proxy_filenames: ["dxgi.dll", "winmm.dll"],
  default_proxy: "dxgi.dll",
};

async function testLibraryBrowser() {
  console.log("=== 1. LibraryBrowser: error retry, add, remove ===");
  let libs = [
    { path: "/home/deck/.local/share/Steam", name: "Internal Storage", source: "steam", game_count: 10, available: true },
  ];
  let failLoad = true;
  fixtures.list_libraries = () => {
    if (failLoad) throw new Error("disk scan timeout");
    return [...libs];
  };
  fixtures.add_custom_library = (path: string) => {
    libs.push({ path, name: "Extra SSD", source: "custom", game_count: 3, available: true });
    return { ok: true };
  };
  let failRemove = true;
  fixtures.remove_custom_library = (path: string) => {
    if (failRemove) return { ok: false, error: "permission denied" };
    libs = libs.filter((item) => item.path !== path);
    return { ok: true };
  };

  const view = await mount(<LibraryBrowser />);
  check("LibraryBrowser renders error notice instead of empty state on load failure",
    view.host.textContent!.includes("Could not read your libraries") &&
    view.host.textContent!.includes("disk scan timeout") &&
    !view.host.textContent!.includes("No libraries found"));

  failLoad = false;
  const retryBtn = findAll(view.host, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("Try again"));
  check("LibraryBrowser error state exposes Try again button", Boolean(retryBtn));
  await act(async () => { retryBtn?.click(); });
  await settle();
  check("Try again recovers and lists libraries",
    view.host.textContent!.includes("Internal Storage"));

  // Add custom library via openFilePicker
  toasts.length = 0;
  setFilePicker({ path: "/run/media/extra", realpath: "/run/media/extra" });
  const addBtn = findAll(view.host, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("Add a games folder"));
  await act(async () => { addBtn?.click(); });
  await settle();
  check("LibraryBrowser adds custom folder from file picker and shows toast",
    view.host.textContent!.includes("Extra SSD") &&
    toasts.some((t) => t.title === "Library added"));

  // Remove failure shows error toast and keeps library
  toasts.length = 0;
  const removeBtn = findAll(view.host, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("Remove “Extra SSD”"));
  await act(async () => { removeBtn?.click(); });
  await settle();
  check("LibraryBrowser remove failure toasts error and retains folder",
    view.host.textContent!.includes("Extra SSD") &&
    toasts.some((t) => t.title === "Could not remove" && String(t.body).includes("permission denied")));

  // Remove success removes folder and shows toast
  failRemove = false;
  toasts.length = 0;
  const removeBtn2 = findAll(view.host, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("Remove “Extra SSD”"));
  await act(async () => { removeBtn2?.click(); });
  await settle();
  check("LibraryBrowser remove success removes folder and toasts confirmation",
    !view.host.textContent!.includes("Extra SSD") &&
    toasts.some((t) => t.title === "Library removed"));

  resetFilePicker();
  await view.unmount();
}

async function testWikiSearch() {
  console.log("=== 2. WikiSearch: search, pin, error ===");
  let searchMode: "ok" | "error" = "ok";
  fixtures.search_wiki = (query: string) => {
    if (searchMode === "error") {
      return { results: [], entry_count: 0, meta: { error: "wiki offline" } };
    }
    return {
      results: [
        { name: `${query} Remastered`, page: "Remastered", compatibility: "✅", inputs: "DLSS, FSR3", score: 1 },
      ],
      entry_count: 685,
      meta: { error: null },
    };
  };

  let pickedEntry: string | null = null;
  const view = await mount(
    <WikiSearch
      initialQuery="Cyberpunk"
      current="Cyberpunk 2077"
      onPick={(name) => { pickedEntry = name; }}
    />,
  );
  check("WikiSearch shows initial search results and current pin",
    view.host.textContent!.includes("Cyberpunk Remastered") &&
    view.host.textContent!.includes("Pinned to Cyberpunk 2077"));

  // Search new query
  const input = view.host.querySelector<HTMLInputElement>('input[data-text-input]')!;
  await act(async () => {
    setNativeInputValue(input, "Alan Wake");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  const searchBtn = findAll(view.host, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("Search"));
  await act(async () => { searchBtn?.click(); });
  await settle();
  check("WikiSearch runs updated search query",
    view.host.textContent!.includes("Alan Wake Remastered"));

  // Pin result
  const resultRow = findAll(view.host, '[data-mock="Field"]')
    .find((node) => node.textContent?.includes("Alan Wake Remastered"));
  await act(async () => { resultRow?.click(); });
  check("WikiSearch calls onPick with selected entry name",
    pickedEntry === "Alan Wake Remastered");

  // Error display
  searchMode = "error";
  await act(async () => { searchBtn?.click(); });
  await settle();
  check("WikiSearch surfaces backend search error",
    view.host.textContent!.includes("wiki offline"));

  await view.unmount();
}

async function testFsr4Panel() {
  console.log("=== 3. Fsr4Panel: Restore bundled, legacy 4.1.1b, driver import, running-disabled ===");
  let currentBuildId = "4.1.2-lite-exact-20261122";
  fixtures.verify_install = () => ({
    ok: true,
    complete: true,
    problems: [],
    ffx_upscaler: { present: true, name: "amd_fidelityfx_upscaler_dx12.dll", version: "4.1.1.2740", fsr4_capable: true },
  });
  fixtures.get_fsr4_info = () => ({
    status: {
      files: {},
      ready: false,
      required: [],
      build: {
        known: true,
        id: currentBuildId,
        label: currentBuildId === "bundled" ? "Bundled (Official 4.1.2)" : currentBuildId,
        note: "",
        reaches_fsr4_by: "int8",
        sha256: "a".repeat(64),
        bytes: 1000,
      },
    },
    sources: [],
    gpu: DECK_GPU,
  });
  fixtures.restore_fsr4_build = () => {
    currentBuildId = "bundled";
    return { ok: true };
  };
  fixtures.set_fsr4_build = (_dir: string, buildId: string) => {
    currentBuildId = buildId;
    return { ok: true };
  };
  fixtures.import_fsr4_files = () => ({ ok: true, imported: ["amdxcffx64.dll"] });

  const sources = [{ path: "/home/deck/fgmod/fsr4", files: ["amdxcffx64.dll"] }];

  // Running state disables all 3 DLL mutation actions ([PD-06]/[UI-06]) while keeping Re-check enabled
  const runningView = await mount(
    <Fsr4Panel targetDir="/games/fsr4-flow" sources={sources} gpu={DECK_GPU} running onChanged={() => {}} />,
  );
  const runningBtns = findAll(runningView.host, '[data-mock="ButtonItem"]');
  const dllBtns = runningBtns.filter((b) => !b.textContent?.includes("Re-check installed files"));
  check("Fsr4Panel disables Restore, Legacy 4.1.1b, and Import buttons while running",
    dllBtns.length === 3 && dllBtns.every((b) => b.getAttribute("data-disabled") === "true"),
    `dllBtns=${dllBtns.length}`);
  await runningView.unmount();

  // Stopped state allows Legacy 4.1.1b, Restore bundled, and Driver import with toasts
  let changedCalls = 0;
  const view = await mount(
    <Fsr4Panel
      targetDir="/games/fsr4-flow"
      sources={sources}
      gpu={DECK_GPU}
      running={false}
      onChanged={() => { changedCalls += 1; }}
    />,
  );
  toasts.length = 0;
  const legacyBtn = findAll(view.host, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("Use legacy 4.1.1b"));
  await act(async () => { legacyBtn?.click(); });
  await settle();
  check("Fsr4Panel Use legacy 4.1.1b installs legacy build and shows toast",
    currentBuildId === "4.1.1b" &&
    toasts.some((t) => t.title === "Legacy upscaler installed") &&
    changedCalls === 1);

  toasts.length = 0;
  const restoreBtn = findAll(view.host, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("Restore bundled upscaler"));
  await act(async () => { restoreBtn?.click(); });
  await settle();
  check("Fsr4Panel Restore bundled upscaler restores official DLL and shows toast",
    currentBuildId === "bundled" &&
    toasts.some((t) => t.title === "Bundled upscaler restored") &&
    changedCalls === 2);

  toasts.length = 0;
  const importCallsBefore = invocations.filter((c) => c.name === "import_fsr4_files").length;
  const importBtn = findAll(view.host, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("fgmod/fsr4"));
  await act(async () => { importBtn?.click(); });
  await settle();
  check("Fsr4Panel driver import calls import_fsr4_files and toasts success",
    invocations.filter((c) => c.name === "import_fsr4_files").length === importCallsBefore + 1 &&
    toasts.some((t) => t.title === "Copied into game folder"));

  await view.unmount();
}

async function testOptipatcherPanel() {
  console.log("=== 4. OptipatcherPanel: init error, toggle, running/readOnly ===");
  // Init error renders error card instead of returning null ([UI-15])
  fixtures.get_optipatcher_status = () => {
    throw new Error("optipatcher probe failed");
  };
  const errView = await mount(<OptipatcherPanel targetDir="/games/op" />);
  check("OptipatcherPanel renders error Notice when initial status query fails",
    errView.host.textContent!.includes("Could not check OptiPatcher") &&
    errView.host.textContent!.includes("optipatcher probe failed"));
  await errView.unmount();

  const opState = { installed: false };
  fixtures.get_optipatcher_status = () => ({
    available: true,
    installed: opState.installed,
    version: "0.7.7",
    path: "/games/op/plugins/OptiPatcher.asi",
  });
  fixtures.install_optipatcher = (_dir: string, enabled: boolean) => {
    opState.installed = enabled;
    return { ok: true };
  };

  // Running & readOnly disable toggle ([PD-06])
  const roView = await mount(<OptipatcherPanel targetDir="/games/op" readOnly />);
  const roToggle = roView.host.querySelector('[data-mock="ToggleField"]');
  check("OptipatcherPanel disables toggle when readOnly",
    roToggle?.getAttribute("data-disabled") === "true");
  await roView.unmount();

  const runView = await mount(<OptipatcherPanel targetDir="/games/op" running />);
  const runToggle = runView.host.querySelector('[data-mock="ToggleField"]');
  check("OptipatcherPanel disables toggle when running",
    runToggle?.getAttribute("data-disabled") === "true");
  await runView.unmount();

  // Normal toggle on & off
  let changed = 0;
  const view = await mount(
    <OptipatcherPanel targetDir="/games/op" onChanged={() => { changed += 1; }} />,
  );
  const toggleSpan = view.host.querySelector<HTMLElement>('[data-mock="ToggleField"] [data-toggle]');
  await act(async () => { toggleSpan?.click(); });
  await settle();
  check("OptipatcherPanel toggles install on and invokes onChanged",
    opState.installed === true && changed === 1);
  const toggleSpan2 = view.host.querySelector<HTMLElement>('[data-mock="ToggleField"] [data-toggle]');
  await act(async () => { toggleSpan2?.click(); });
  await settle();
  check("OptipatcherPanel toggles install off", opState.installed === false && changed === 2);

  await view.unmount();
}

async function testMonitorTab() {
  console.log("=== 5. MonitorTab: log toggle, clear, readOnly ===");
  const monState = { loggingOn: false, logPresent: true };
  fixtures.get_monitor = () => ({
    path: "/games/mon",
    log_path: "/games/mon/OptiScaler.log",
    log_present: monState.logPresent,
    log_size: monState.logPresent ? 1024 : 0,
    log_modified: monState.logPresent ? 1700000000 : null,
    logging_enabled: monState.loggingOn ? "true" : "false",
    state: { upscaler: "FSR 4.1.2", proxy: "dxgi.dll" },
    counts: { info: 5, warning: 0, error: 0 },
    frame_generation: [],
    problems: [],
    recent: [{ time: "12:00:00", level: "info", message: "ready" }],
    hints: [],
    configured: {},
    total_lines: 5,
  });
  fixtures.set_logging = (_dir: string, enabled: boolean) => {
    monState.loggingOn = enabled;
    return { ok: true };
  };
  fixtures.clear_log = () => {
    monState.logPresent = false;
    return { ok: true };
  };

  // readOnly disables log toggle ([UI-14])
  const roView = await mount(
    <MonitorTab targetDir="/games/mon" live={false} readOnly onNeedsRestart={() => {}} />,
  );
  const roToggle = roView.host.querySelector('[data-mock="ToggleField"]');
  check("MonitorTab disables Write OptiScaler log when readOnly",
    roToggle?.getAttribute("data-disabled") === "true");
  await roView.unmount();

  let restartNotified = 0;
  const view = await mount(
    <MonitorTab
      targetDir="/games/mon"
      live={false}
      readOnly={false}
      onNeedsRestart={() => { restartNotified += 1; }}
    />,
  );
  const logToggle = view.host.querySelector<HTMLElement>('[data-mock="ToggleField"] [data-toggle]');
  await act(async () => { logToggle?.click(); });
  await settle();
  check("MonitorTab toggling logging calls set_logging and onNeedsRestart",
    monState.loggingOn === true && restartNotified === 1);

  const clearBtn = findAll(view.host, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("Clear log"));
  check("MonitorTab exposes Clear log button when log is present", Boolean(clearBtn));
  await act(async () => { clearBtn?.click(); });
  await settle();
  check("MonitorTab Clear log calls clear_log and refreshes to empty log state",
    monState.logPresent === false && view.host.textContent!.includes("No log yet"));

  await view.unmount();
}

async function testSettingsTab() {
  console.log("=== 6. SettingsTab: prefs, forget, refreshWiki error vs ok ===");
  const prefs = new Map<string, unknown>([
    ["remember_choices", true],
    ["remove_launch_options", "restore"],
  ]);
  fixtures.get_pref = (key: string, fallback?: unknown) => ({
    key,
    value: prefs.has(key) ? prefs.get(key) : fallback ?? null,
  });
  fixtures.set_pref = (key: string, value: unknown) => {
    if (value === null || value === undefined) prefs.delete(key);
    else prefs.set(key, value);
    return { ok: true };
  };
  let wikiErr: string | null = null;
  fixtures.wiki_status = () => ({
    url: "https://example.invalid/wiki",
    entry_count: 685,
    available: true,
    source: "cache",
    fetched_at: 1700000000,
    age: 3600,
    stale: false,
    revision: "rev1",
    revalidating: false,
    last_attempt: 1700000000,
    error: wikiErr,
    tls: "default",
    cache_path: "/tmp/cache.json",
  });
  let refreshMode: "error" | "ok" = "error";
  fixtures.refresh_wiki = () => {
    if (refreshMode === "error") {
      wikiErr = "network unreachable";
      return { ok: false, count: 685, meta: { source: "cache", fetched_at: 1, error: "network unreachable" } };
    }
    wikiErr = null;
    return { ok: true, count: 700, meta: { source: "network", fetched_at: 2, error: null } };
  };

  const view = await mount(<SettingsTab status={BUNDLE_STATUS} />);
  // [CD-07]: refreshWiki failing with cached count > 0 must toast failure, NOT "Compatibility list downloaded"
  toasts.length = 0;
  const refreshBtn = findAll(view.host, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("Download it again"));
  await act(async () => { refreshBtn?.click(); });
  await settle();
  check("SettingsTab refreshWiki error toasts failure even when cached count > 0",
    toasts.some((t) => t.title === "Could not refresh compatibility list") &&
    !toasts.some((t) => t.title === "Compatibility list downloaded"));

  refreshMode = "ok";
  toasts.length = 0;
  await act(async () => { refreshBtn?.click(); });
  await settle();
  check("SettingsTab refreshWiki ok toasts Compatibility list downloaded",
    toasts.some((t) => t.title === "Compatibility list downloaded"));

  // Forget individual remembered answer
  const forgetRow = view.host.querySelector<HTMLElement>('[data-forget="remove_launch_options"]');
  check("SettingsTab lists remembered question", Boolean(forgetRow));
  await act(async () => { forgetRow?.click(); });
  await settle();
  check("Clicking remembered question forgets it",
    !view.host.querySelector('[data-forget="remove_launch_options"]'));

  // Toggle remembering off
  const remToggle = view.host.querySelector<HTMLElement>(
    '[data-mock="ToggleField"][data-label="Remember my choices"] [data-toggle]',
  );
  await act(async () => { remToggle?.click(); });
  await settle();
  check("SettingsTab Remember my choices toggle persists false",
    prefs.get("remember_choices") === false);

  await view.unmount();
}

async function testGamesList() {
  console.log("=== 7. GamesList: error retry, pagination, Recent filter, Running now card ===");
  const prevAppStore = (globalThis as any).appStore;
  const mockGames: Game[] = Array.from({ length: 25 }, (_, i) => ({
    appid: String(400000 + i),
    name: `Sample Game ${String(i + 1).padStart(2, "0")}`,
    path: `/games/sample-${i + 1}`,
    source: "steam",
    size_on_disk: 1,
    installed: i === 0,
    filename: i === 0 ? "dxgi.dll" : null,
    install_path: i === 0 ? `/games/sample-1/bin` : null,
    library: "Internal Storage",
  }));

  // Provide last-played timestamps so Recent filter activates
  (globalThis as any).appStore = {
    GetAppOverviewByAppID: (id: number) =>
      id === 400024 ? { rt_last_played: 1700005000 }
      : id === 400000 ? { rt_last_played: 1700001000 }
      : undefined,
  };

  let failScan = true;
  fixtures.list_all_games = () => {
    if (failScan) throw new Error("library scan error");
    return mockGames;
  };
  fixtures.find_running_game = () => ({
    found: true,
    appid: "400099",
    name: "Unlisted Running Game",
    path: "/games/unlisted-running",
  });

  const opened: Game[] = [];
  const runningGame: RunningGame = { appid: 400099, name: "Unlisted Running Game", gameid: "400099" };
  const view = await mount(
    <GamesList runningGame={runningGame} onOpenGame={(g) => opened.push(g)} />,
  );
  check("GamesList renders scan error with Try again button",
    view.host.textContent!.includes("Could not read your libraries") &&
    view.host.textContent!.includes("Try again"));

  // Running now card works even during/after scan and carries appid ([UI-01]/[UI-07])
  const runningCard = findAll(view.host, '[data-mock="Field"]')
    .find((node) => node.textContent?.includes("Running now · Unlisted Running Game"));
  check("GamesList renders Running now card", Boolean(runningCard));
  await act(async () => { runningCard?.click(); });
  await settle();
  check("GamesList Running now card passes explicit appid to onOpenGame",
    opened.length === 1 && opened[0].appid === "400099" && opened[0].path === "/games/unlisted-running");

  // Retry scan recovers
  failScan = false;
  const retryBtn = findAll(view.host, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("Try again"));
  await act(async () => { retryBtn?.click(); });
  await settle();
  check("GamesList Try again recovers and opens on Recent filter when Steam provides play times",
    view.host.querySelector('[data-filter="recent"][data-active="true"]') !== null &&
    view.host.textContent!.includes("Sample Game 25"));

  // Switch to All and test pagination forward + Back to the first 20 click ([UI-15])
  const allFilter = view.host.querySelector<HTMLElement>('[data-filter="all"]');
  await act(async () => { allFilter?.click(); });
  await settle();
  check("All filter initially shows first 20 games",
    view.host.textContent!.includes("Sample Game 20") &&
    !view.host.textContent!.includes("Sample Game 25"));
  const nextBtn = findAll(view.host, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("Show next"));
  await act(async () => { nextBtn?.click(); });
  await settle();
  check("Show next reveals remaining games", view.host.textContent!.includes("Sample Game 25"));
  const backTop = findAll(view.host, '[data-mock="Focusable"]')
    .find((node) => node.textContent?.includes("Back to the first 20"));
  check("Back to the first 20 row is clickable via onClick", Boolean(backTop));
  await act(async () => { backTop?.click(); });
  await settle();
  check("Clicking Back to the first 20 collapses list back to 20",
    !view.host.textContent!.includes("Sample Game 25"));

  await view.unmount();
  (globalThis as any).appStore = prevAppStore;
}

async function testBasicPanelSymmetricFsr4Restore() {
  console.log("=== 8. BasicPanel: symmetric official FSR4 restore confirmation ([PD-07]) ===");
  const liteValues = {
    Upscalers: { Dx12Upscaler: "fsr31" },
    FSR: { Fsr4ForceEnableInt8: "1", Fsr4Update: "true", UpscalerIndex: "0" },
  };
  let restoreOfficialCalls = 0;

  // Running state blocks returning to official FSR 3.X/4 ([PD-07]/[UI-06])
  toasts.length = 0;
  shownModals.length = 0;
  const runView = await mount(
    <BasicPanel
      values={liteValues}
      running
      gpu={DECK_GPU}
      fsr4Build="4.1.2-lite-exact-20261122"
      onRestoreOfficialFsr4={async () => { restoreOfficialCalls += 1; }}
      onApply={() => {}}
    />,
  );
  const runFsr4Opt = runView.host.querySelector<HTMLElement>(
    '[data-mock="DropdownItem"][data-label="Override upscaler with"] [data-opt-value="fsr4"]',
  );
  await act(async () => { runFsr4Opt?.click(); });
  await settle();
  check("BasicPanel blocks switching from community Lite back to official FSR 3.X/4 while running",
    restoreOfficialCalls === 0 &&
    shownModals.length === 0 &&
    toasts.some((t) => t.title === "Close the game first"));
  await runView.unmount();

  // Stopped state opens ConfirmModal; Cancel does nothing, OK invokes onRestoreOfficialFsr4
  shownModals.length = 0;
  const stopView = await mount(
    <BasicPanel
      values={liteValues}
      running={false}
      gpu={DECK_GPU}
      fsr4Build="4.1.2-lite-exact-20261122"
      onRestoreOfficialFsr4={async () => { restoreOfficialCalls += 1; }}
      onApply={() => {}}
    />,
  );
  const stopFsr4Opt = stopView.host.querySelector<HTMLElement>(
    '[data-mock="DropdownItem"][data-label="Override upscaler with"] [data-opt-value="fsr4"]',
  );
  await act(async () => { stopFsr4Opt?.click(); });
  await settle();
  check("BasicPanel opens ConfirmModal before restoring official FSR 4.1.2 DLL",
    shownModals.length === 1);
  await respondLatestModal("cancel");
  await settle();
  check("ConfirmModal Cancel leaves community Lite untouched", restoreOfficialCalls === 0);

  shownModals.length = 0;
  const stopFsr4Opt2 = stopView.host.querySelector<HTMLElement>(
    '[data-mock="DropdownItem"][data-label="Override upscaler with"] [data-opt-value="fsr4"]',
  );
  await act(async () => { stopFsr4Opt2?.click(); });
  await settle();
  await respondLatestModal("ok");
  await settle();
  check("ConfirmModal OK invokes onRestoreOfficialFsr4", restoreOfficialCalls === 1);
  await stopView.unmount();

  // Prior 2026-11-05 Lite build also opens ConfirmModal before restoring official FSR 3.X/4
  shownModals.length = 0;
  const priorView = await mount(
    <BasicPanel
      values={liteValues}
      running={false}
      gpu={DECK_GPU}
      fsr4Build="4.1.2-lite-exact-20261105"
      onRestoreOfficialFsr4={async () => { restoreOfficialCalls += 1; }}
      onApply={() => {}}
    />,
  );
  const priorFsr4Opt = priorView.host.querySelector<HTMLElement>(
    '[data-mock="DropdownItem"][data-label="Override upscaler with"] [data-opt-value="fsr4"]',
  );
  await act(async () => { priorFsr4Opt?.click(); });
  await settle();
  check("BasicPanel opens ConfirmModal when returning to official FSR 3.X/4 from prior 2026-11-05 Lite",
    shownModals.length === 1);
  await respondLatestModal("ok");
  await settle();
  check("ConfirmModal OK from prior 2026-11-05 Lite invokes onRestoreOfficialFsr4", restoreOfficialCalls === 2);
  await priorView.unmount();

  // Prior schema-7 ASI (supported=false, can_install=true, asi_current=false) shows update guidance
  const outdatedLiveView = await mount(
    <BasicPanel
      values={{}}
      running={false}
      gpu={DECK_GPU}
      live={{
        supported: false,
        can_install: true,
        asi_installed: true,
        asi_current: false,
        attached: false,
        state: "outdated",
        load_enabled: true,
        asi_available: true,
      } as any}
      onApply={() => {}}
    />,
  );
  check("BasicPanel shows actionable update notice for prior schema-7 live ASI",
    outdatedLiveView.host.textContent!.includes("Live control update available") &&
    !outdatedLiveView.host.textContent!.includes("Live control is unavailable"));
  await outdatedLiveView.unmount();
}

async function testUseRunningGameLifecycle() {
  console.log("=== 9. useRunningGame lifecycle ===");
  const prevSteam = (globalThis as any).SteamClient;
  const prevAppStore = (globalThis as any).appStore;
  const prevMain = Router.MainRunningApp;

  let lifetimeCb: ((n: { unAppID: number; bRunning: boolean }) => void) | null = null;
  const regState = { unregistered: false };
  (globalThis as any).SteamClient = {
    GameSessions: {
      RegisterForAppLifetimeNotifications: (cb: (n: { unAppID: number; bRunning: boolean }) => void) => {
        lifetimeCb = cb;
        return { unregister: () => { regState.unregistered = true; } };
      },
    },
  };
  (globalThis as any).appStore = {
    GetAppOverviewByAppID: (id: number) =>
      id === 777001 ? { appid: 777001, display_name: "Lifetime Game", gameid: "777001" } : undefined,
  };
  Router.MainRunningApp = { appid: 1091500, display_name: "Cyberpunk 2077", gameid: "1091500" };

  let observed: RunningGame | null = null;
  function Probe() {
    observed = useRunningGame();
    return <div data-running={observed ? `${observed.appid}:${observed.name}` : "none"} />;
  }

  const view = await mount(<Probe />);
  check("useRunningGame reads initial Router.MainRunningApp on mount",
    observed !== null && (observed as RunningGame).appid === 1091500);

  // App start lifetime notification updates running game
  await act(async () => {
    lifetimeCb?.({ unAppID: 777001, bRunning: true });
  });
  check("useRunningGame updates on bRunning=true lifetime notification",
    observed !== null && (observed as RunningGame).appid === 777001 &&
    (observed as RunningGame).name === "Lifetime Game");

  // App stop clears running game when Router.MainRunningApp is empty
  Router.MainRunningApp = undefined;
  await act(async () => {
    lifetimeCb?.({ unAppID: 777001, bRunning: false });
  });
  check("useRunningGame clears on bRunning=false lifetime notification", observed === null);

  // Polling safety net picks up Router.MainRunningApp after 4000ms
  Router.MainRunningApp = { appid: 888002, display_name: "Polled Game", gameid: "888002" };
  await clock.advance(4100);
  check("useRunningGame poll safety net detects running app",
    observed !== null && (observed as RunningGame).appid === 888002);

  await view.unmount();
  check("useRunningGame unregisters lifetime listener on unmount", regState.unregistered === true);

  Router.MainRunningApp = prevMain;
  (globalThis as any).SteamClient = prevSteam;
  (globalThis as any).appStore = prevAppStore;
}

async function testSetupChecklistReapplyLaunchFlags() {
  console.log("=== 10. SetupChecklist reapply(): stale launch flag reconciliation ===");
  const prevSteam = (globalThis as any).SteamClient;
  const prefs = new Map<string, unknown>([["remember_choices", true]]);
  const steamLaunch = new Map<number, string>();

  (globalThis as any).SteamClient = {
    Apps: {
      GetAppLaunchOptions: async (id: number) => steamLaunch.get(id) ?? "",
      SetAppLaunchOptions: (id: number, value: string) => {
        steamLaunch.set(id, value);
      },
    },
  };

  fixtures.get_pref = (key: string, fallback?: unknown) => ({
    key,
    value: prefs.has(key) ? prefs.get(key) : fallback ?? null,
  });
  fixtures.set_pref = (key: string, value: unknown) => {
    if (value === null || value === undefined) prefs.delete(key);
    else prefs.set(key, value);
    return { ok: true };
  };
  fixtures.get_monitor = () => ({
    path: "/games/reapply/bin",
    log_path: "/games/reapply/bin/OptiScaler.log",
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
  });
  fixtures.create_restore_point = () => ({ ok: true });
  fixtures.get_launch_options = (appid: string) => ({
    found: true,
    value: steamLaunch.get(Number(appid)) ?? "",
    source: "harness",
  });

  const makeDetail = (recordedOriginal: string): GameDetail => ({
    path: "/games/reapply",
    name: "Reapply Game",
    target: "/games/reapply/bin",
    target_is_saved: true,
    candidates: [],
    ini_info: { present: true, legacy: false, keys: 1 },
    wiki_entry: "Reapply Game",
    fsr4_sources: [],
    gpu: DECK_GPU,
    launch_option: 'WINEDLLOVERRIDES="dxgi=n,b" %command%',
    writable: true,
    reframework: {
      required: false,
      installed: false,
      dll: "dinput8.dll",
      path: "/games/reapply/bin/dinput8.dll",
      revision: null,
      plugin: null,
      plugin_installed: false,
      plugin_url: null,
      plugin_name: null,
      complete: true,
    },
    install: {
      path: "/games/reapply/bin",
      installed: true,
      filename: "dxgi.dll",
      managed: true,
      version: "0.9.5",
      runtime_current: true,
      installed_at: 1,
      ini_present: true,
      ini_path: "/games/reapply/bin/OptiScaler.ini",
      log_present: false,
      log_path: "",
      candidates: ["dxgi.dll"],
      extra_proxies: [],
      backup_dir: "/games/reapply/bin/backup",
      backed_up: [],
      launch_record: { recorded: true, value: recordedOriginal },
      fsr4: { files: {}, ready: true, required: [] },
      reframework: { installed: false, revision: null, managed: false },
    },
  });

  const makePlan = (launchFlags: string[], refOverride?: string): AutoPlan => ({
    available: true,
    game: "Reapply Game",
    source: "wiki entry",
    wiki_url: "https://example.invalid/wiki/Reapply",
    filename: "dxgi.dll",
    filename_source: "wiki",
    launch_flags: launchFlags,
    launch_options: `WINEDLLOVERRIDES="dxgi=n,b" %command%${launchFlags.length ? ` ${launchFlags.join(" ")}` : ""}`,
    reframework: refOverride
      ? {
          required: true,
          variant: "nightly",
          source: "wiki",
          detail: "wiki",
          dll: refOverride,
          override: refOverride,
          asset: null,
          url: null,
          page: "https://example.invalid/ref",
          plugin: null,
          plugin_name: null,
          plugin_url: null,
          automatic: true,
          reason: null,
        }
      : null,
    optipatcher: false,
    settings: [],
    framegen: null,
    hotkey: null,
    unresolved: [],
    warnings: [],
  });

  try {
    // Case A: in-session wiki update (filenameChanged === false, -dx11 -> -dx12, user has -myflag)
    prefs.clear();
    prefs.set("remember_choices", true);
    const appidA = 510001;
    await setAppliedLaunchMetadata(String(appidA), ["-dx11"], []);
    steamLaunch.set(appidA, 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11 -myflag');
    fixtures.auto_install = () => ({ ok: true, plan: makePlan(["-dx12"]) });

    const viewA = await mount(
      <SetupChecklist
        detail={makeDetail("")}
        appid={String(appidA)}
        plan={makePlan(["-dx11"])}
        recommendation={null}
        loadingWiki={false}
        auto
        live={null}
        running={false}
        onSetAuto={() => {}}
        onManual={() => {}}
        onLogs={() => {}}
        onChanged={() => {}}
        onReloadPlan={() => {}}
        onResetConfig={() => {}}
      />,
    );
    const reapplyBtnA = findAll(viewA.host, '[data-mock="DialogButton"]')
      .find((node) => node.textContent?.trim() === "Set up again");
    check("SetupChecklist exposes Set up again button", Boolean(reapplyBtnA));
    await act(async () => { reapplyBtnA?.click(); });
    await settle();
    const afterA = steamLaunch.get(appidA) ?? "";
    check(
      "reapply() replaces stale -dx11 with -dx12 while preserving user -myflag (filename unchanged)",
      afterA === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx12 -myflag',
      `got: ${JSON.stringify(afterA)}`,
    );
    await viewA.unmount();

    // Case B: wiki refreshed BEFORE clicking Re-apply (planned already has -dx12, persisted pref has -dx11 + dinput8.dll)
    prefs.clear();
    prefs.set("remember_choices", true);
    const appidB = 510002;
    await setAppliedLaunchMetadata(String(appidB), ["-dx11"], ["dinput8.dll"]);
    steamLaunch.set(appidB, 'WINEDLLOVERRIDES="dxgi=n,b;dinput8=n,b" %command% -dx11 -myflag');
    fixtures.auto_install = () => ({ ok: true, plan: makePlan(["-dx12"]) });

    const viewB = await mount(
      <SetupChecklist
        detail={makeDetail("")}
        appid={String(appidB)}
        plan={makePlan(["-dx12"])}
        recommendation={null}
        loadingWiki={false}
        auto
        live={null}
        running={false}
        onSetAuto={() => {}}
        onManual={() => {}}
        onLogs={() => {}}
        onChanged={() => {}}
        onReloadPlan={() => {}}
        onResetConfig={() => {}}
      />,
    );
    const reapplyBtnB = findAll(viewB.host, '[data-mock="DialogButton"]')
      .find((node) => node.textContent?.trim() === "Set up again");
    await act(async () => { reapplyBtnB?.click(); });
    await settle();
    const afterB = steamLaunch.get(appidB) ?? "";
    check(
      "reapply() strips stale persisted -dx11 and extra override even after wiki already updated planned",
      afterB === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx12 -myflag',
      `got: ${JSON.stringify(afterB)}`,
    );
    const updatedMeta = prefs.get(`applied_launch:${appidB}`) as { flags?: string[]; extraOverrides?: string[] } | undefined;
    check(
      "reapply() updates persisted applied launch metadata to the new plan flags",
      JSON.stringify(updatedMeta) === JSON.stringify({ flags: ["-dx12"], extraOverrides: [] }),
      `got: ${JSON.stringify(updatedMeta)}`,
    );
    await viewB.unmount();

    // Case C: user originally had -dx11 in recordedOriginal -> -dx11 must be preserved
    prefs.clear();
    prefs.set("remember_choices", true);
    const appidC = 510003;
    await setAppliedLaunchMetadata(String(appidC), ["-dx11"], []);
    steamLaunch.set(appidC, 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11 -myflag');
    fixtures.auto_install = () => ({ ok: true, plan: makePlan(["-dx12"]) });

    const viewC = await mount(
      <SetupChecklist
        detail={makeDetail("%command% -dx11")}
        appid={String(appidC)}
        plan={makePlan(["-dx12"])}
        recommendation={null}
        loadingWiki={false}
        auto
        live={null}
        running={false}
        onSetAuto={() => {}}
        onManual={() => {}}
        onLogs={() => {}}
        onChanged={() => {}}
        onReloadPlan={() => {}}
        onResetConfig={() => {}}
      />,
    );
    const reapplyBtnC = findAll(viewC.host, '[data-mock="DialogButton"]')
      .find((node) => node.textContent?.trim() === "Set up again");
    await act(async () => { reapplyBtnC?.click(); });
    await settle();
    const afterC = steamLaunch.get(appidC) ?? "";
    check(
      "reapply() preserves -dx11 when user originally had -dx11 in recordedOriginal",
      afterC.includes("-dx12") && afterC.includes("-dx11") && afterC.includes("-myflag"),
      `got: ${JSON.stringify(afterC)}`,
    );
    await viewC.unmount();

    // Case D (Comment 4726805911): Wiki changes -dx11 -> -dx12, user toggles "Launch options" switch ON/OFF in SetupChecklist
    prefs.clear();
    prefs.set("remember_choices", true);
    const appidD = 510004;
    await setAppliedLaunchMetadata(String(appidD), ["-dx11"], []);
    steamLaunch.set(appidD, 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11 -myflag');

    const viewD = await mount(
      <SetupChecklist
        detail={makeDetail("")}
        appid={String(appidD)}
        plan={makePlan(["-dx12"])}
        recommendation={null}
        loadingWiki={false}
        auto
        live={null}
        running={false}
        onSetAuto={() => {}}
        onManual={() => {}}
        onLogs={() => {}}
        onChanged={() => {}}
        onReloadPlan={() => {}}
        onResetConfig={() => {}}
      />,
    );
    const launchToggleD = findAll(viewD.host, '[data-mock="ToggleField"]')
      .find((node) => node.textContent?.includes("Launch options"))
      ?.querySelector<HTMLElement>("[data-toggle]");
    check("SetupChecklist renders Launch options toggle when wiki changes flag", Boolean(launchToggleD));
    await act(async () => { launchToggleD?.click(); });
    await settle();
    const afterDOn = steamLaunch.get(appidD) ?? "";
    const metaDOn = prefs.get(`applied_launch:${appidD}`) as { flags?: string[]; extraOverrides?: string[] } | undefined;
    check(
      "SetupChecklist applyLaunch(true) strips stale -dx11 and sets -dx12 while keeping -myflag",
      afterDOn === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx12 -myflag',
      `got: ${JSON.stringify(afterDOn)}`,
    );
    check(
      "SetupChecklist applyLaunch(true) updates persisted applied_launch metadata to ['-dx12']",
      JSON.stringify(metaDOn) === JSON.stringify({ flags: ["-dx12"], extraOverrides: [] }),
      `got: ${JSON.stringify(metaDOn)}`,
    );

    // Toggle OFF strips proxy and persisted -dx12, keeps -myflag, clears applied_launch
    const launchToggleDOff = findAll(viewD.host, '[data-mock="ToggleField"]')
      .find((node) => node.textContent?.includes("Launch options"))
      ?.querySelector<HTMLElement>("[data-toggle]");
    await act(async () => { launchToggleDOff?.click(); });
    await settle();
    const afterDOff = steamLaunch.get(appidD) ?? "";
    check(
      "SetupChecklist applyLaunch(false) strips proxy and persisted -dx12 while keeping -myflag",
      afterDOff === "%command% -myflag",
      `got: ${JSON.stringify(afterDOff)}`,
    );
    check(
      "SetupChecklist applyLaunch(false) clears persisted applied_launch metadata on success",
      !prefs.has(`applied_launch:${appidD}`),
      `got: ${JSON.stringify(prefs.get(`applied_launch:${appidD}`))}`,
    );

    // Failed Steam write must not overwrite or clear persisted applied_launch metadata
    await setAppliedLaunchMetadata(String(appidD), ["-dx11"], []);
    steamLaunch.set(appidD, 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11');
    const prevSetterD = (globalThis as any).SteamClient.Apps.SetAppLaunchOptions;
    (globalThis as any).SteamClient.Apps.SetAppLaunchOptions = () => {
      throw new Error("steam rejected");
    };
    const launchToggleDFail = findAll(viewD.host, '[data-mock="ToggleField"]')
      .find((node) => node.textContent?.includes("Launch options"))
      ?.querySelector<HTMLElement>("[data-toggle]");
    await act(async () => { launchToggleDFail?.click(); });
    await settle();
    const metaDFail = prefs.get(`applied_launch:${appidD}`) as { flags?: string[]; extraOverrides?: string[] } | undefined;
    check(
      "SetupChecklist keeps previous applied_launch metadata intact when Steam write fails",
      JSON.stringify(metaDFail) === JSON.stringify({ flags: ["-dx11"], extraOverrides: [] }),
      `got: ${JSON.stringify(metaDFail)}`,
    );
    (globalThis as any).SteamClient.Apps.SetAppLaunchOptions = prevSetterD;
    await viewD.unmount();

    // Case E (Comment 4726805916): InstallPanel manual apply writes -dx11 and records metadata;
    // later Wiki changes to -dx12 and SetupChecklist Re-apply strips -dx11 (no duplicate flags)
    prefs.clear();
    prefs.set("remember_choices", true);
    const appidE = 510005;
    steamLaunch.set(appidE, "");
    fixtures.install = () => ({ ok: true });
    fixtures.get_fsr4_info = () => ({
      status: { files: {}, ready: true, required: [] },
      sources: [],
      gpu: DECK_GPU,
    });
    fixtures.verify_install = () => ({ ok: true, complete: true, problems: [] });
    fixtures.get_optipatcher_status = () => ({
      available: false,
      installed: false,
      version: null,
      path: "",
    });

    const installViewE = await mount(
      <InstallPanel
        detail={makeDetail("")}
        status={BUNDLE_STATUS}
        appid={String(appidE)}
        live={null}
        running={false}
        autoPlan={{
          plan: makePlan(["-dx11"]),
          recommendation: null,
          loading: false,
          reload: async () => {},
        }}
        onChanged={async () => {}}
      />,
    );
    const setLaunchBtnE = findAll(installViewE.host, '[data-mock="ButtonItem"]')
      .find((node) => node.textContent?.includes("Set launch options for me"));
    check("InstallPanel exposes Set launch options for me button", Boolean(setLaunchBtnE));
    await act(async () => { setLaunchBtnE?.click(); });
    await settle();
    const afterManualE = steamLaunch.get(appidE) ?? "";
    const metaManualE = prefs.get(`applied_launch:${appidE}`) as { flags?: string[]; extraOverrides?: string[] } | undefined;
    check(
      "InstallPanel applies -dx11 and records applied_launch metadata",
      afterManualE === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11' &&
        JSON.stringify(metaManualE) === JSON.stringify({ flags: ["-dx11"], extraOverrides: [] }),
      `steam=${JSON.stringify(afterManualE)} meta=${JSON.stringify(metaManualE)}`,
    );
    await installViewE.unmount();

    // Verify InstallPanel offerLaunchOptions confirmation modal previews reconciled -dx12 (without stale -dx11)
    shownModals.length = 0;
    const installPreviewE = await mount(
      <InstallPanel
        detail={makeDetail("")}
        status={BUNDLE_STATUS}
        appid={String(appidE)}
        live={null}
        running={false}
        autoPlan={{
          plan: makePlan(["-dx12"]),
          recommendation: null,
          loading: false,
          reload: async () => {},
        }}
        onChanged={async () => {}}
      />,
    );
    const reinstallBtnE = findAll(installPreviewE.host, '[data-mock="ButtonItem"]')
      .find((node) => node.textContent?.includes("Reinstall as dxgi.dll"));
    await act(async () => { reinstallBtnE?.click(); });
    await settle();
    const latestModalE = shownModals[shownModals.length - 1];
    check(
      "InstallPanel offerLaunchOptions modal previews reconciled -dx12 without stale -dx11",
      Boolean(latestModalE) &&
        (latestModalE.props as { launchOption?: string }).launchOption ===
          'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx12',
      `got: ${JSON.stringify((latestModalE?.props as { launchOption?: string } | undefined)?.launchOption)}`,
    );
    await respondLatestModal("cancel");
    await installPreviewE.unmount();

    // Now open SetupChecklist with Wiki updated to -dx12 and click Re-apply
    fixtures.auto_install = () => ({ ok: true, plan: makePlan(["-dx12"]) });
    const checklistViewE = await mount(
      <SetupChecklist
        detail={makeDetail("")}
        appid={String(appidE)}
        plan={makePlan(["-dx12"])}
        recommendation={null}
        loadingWiki={false}
        auto
        live={null}
        running={false}
        onSetAuto={() => {}}
        onManual={() => {}}
        onLogs={() => {}}
        onChanged={() => {}}
        onReloadPlan={() => {}}
        onResetConfig={() => {}}
      />,
    );
    const reapplyBtnE = findAll(checklistViewE.host, '[data-mock="DialogButton"]')
      .find((node) => node.textContent?.trim() === "Set up again");
    await act(async () => { reapplyBtnE?.click(); });
    await settle();
    const afterReapplyE = steamLaunch.get(appidE) ?? "";
    check(
      "SetupChecklist reapply() strips -dx11 previously written by InstallPanel and leaves only -dx12",
      afterReapplyE === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx12',
      `got: ${JSON.stringify(afterReapplyE)}`,
    );
    await checklistViewE.unmount();

    // Case F (Comment 4726805919): Launch writes disabled during install -> user manually sets
    // "%command% -vulkan -custom" in Steam -> Wiki drops -vulkan -> Re-apply preserves BOTH flags
    prefs.clear();
    prefs.set("remember_choices", true);
    const appidF = 510006;
    // No applied_launch metadata because launch-option writes were disabled at install time
    steamLaunch.set(appidF, "%command% -vulkan -custom");
    fixtures.auto_install = () => ({ ok: true, plan: makePlan([]) });

    const viewF = await mount(
      <SetupChecklist
        detail={makeDetail("")}
        appid={String(appidF)}
        plan={makePlan(["-vulkan"])}
        recommendation={null}
        loadingWiki={false}
        auto
        live={null}
        running={false}
        onSetAuto={() => {}}
        onManual={() => {}}
        onLogs={() => {}}
        onChanged={() => {}}
        onReloadPlan={() => {}}
        onResetConfig={() => {}}
      />,
    );
    const reapplyBtnF = findAll(viewF.host, '[data-mock="DialogButton"]')
      .find((node) => node.textContent?.trim() === "Set up again");
    await act(async () => { reapplyBtnF?.click(); });
    await settle();
    const afterF = steamLaunch.get(appidF) ?? "";
    check(
      "reapply() preserves player's manually added -vulkan and -custom when plugin never owned -vulkan",
      afterF === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -vulkan -custom',
      `got: ${JSON.stringify(afterF)}`,
    );
    await viewF.unmount();

    // Case G (Comment 4726888105): With dxgi.dll installed, selecting winmm.dll in InstallPanel
    // dropdown and clicking "Set launch options for me" directly MUST target installed dxgi.dll!
    prefs.clear();
    prefs.set("remember_choices", true);
    const appidG = 510007;
    steamLaunch.set(appidG, 'WINEDLLOVERRIDES="dxgi=n,b" %command%');
    const statusWithAsi: PayloadStatus = {
      ...BUNDLE_STATUS,
      proxy_filenames: ["dxgi.dll", "winmm.dll", "OptiScaler.asi"],
    };
    const installViewG = await mount(
      <InstallPanel
        detail={makeDetail("")}
        status={statusWithAsi}
        appid={String(appidG)}
        live={null}
        running={false}
        autoPlan={{
          plan: makePlan([]),
          recommendation: null,
          loading: false,
          reload: async () => {},
        }}
        onChanged={async () => {}}
      />,
    );
    const winmmOpt = installViewG.host.querySelector<HTMLElement>(
      '[data-mock="DropdownItem"][data-label="Filename override"] [data-opt-value="winmm.dll"]',
    );
    check("InstallPanel Filename override dropdown exposes winmm.dll", Boolean(winmmOpt));
    await act(async () => { winmmOpt?.click(); });
    await settle();
    check(
      "InstallPanel launch preview still targets installed dxgi.dll while dropdown holds uncommitted winmm.dll",
      installViewG.host.textContent!.includes('WINEDLLOVERRIDES="dxgi=n,b" %command%') &&
        !installViewG.host.textContent!.includes("winmm=n,b"),
    );
    const setLaunchBtnG = findAll(installViewG.host, '[data-mock="ButtonItem"]')
      .find((node) => node.textContent?.includes("Set launch options for me"));
    await act(async () => { setLaunchBtnG?.click(); });
    await settle();
    const afterG = steamLaunch.get(appidG) ?? "";
    check(
      "Clicking 'Set launch options for me' directly keeps installed dxgi=n,b instead of uncommitted winmm=n,b",
      afterG === 'WINEDLLOVERRIDES="dxgi=n,b" %command%',
      `got: ${JSON.stringify(afterG)}`,
    );
    await installViewG.unmount();

    // Case H (Comment 4726888109): Switching from installed dxgi.dll to OptiScaler.asi
    // (1) with NO wiki flags -> strips old dxgi=n,b from Steam and clears applied_launch
    prefs.clear();
    prefs.set("remember_choices", true);
    const appidH1 = 510008;
    steamLaunch.set(appidH1, 'WINEDLLOVERRIDES="dxgi=n,b" %command% -myflag');
    await setAppliedLaunchMetadata(String(appidH1), ["-dx11"], []);
    steamLaunch.set(appidH1, 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11 -myflag');
    shownModals.length = 0;
    const installViewH1 = await mount(
      <InstallPanel
        detail={makeDetail("")}
        status={statusWithAsi}
        appid={String(appidH1)}
        live={null}
        running={false}
        autoPlan={{
          plan: makePlan([]),
          recommendation: null,
          loading: false,
          reload: async () => {},
        }}
        onChanged={async () => {}}
      />,
    );
    const asiOpt1 = installViewH1.host.querySelector<HTMLElement>(
      '[data-mock="DropdownItem"][data-label="Filename override"] [data-opt-value="OptiScaler.asi"]',
    );
    await act(async () => { asiOpt1?.click(); });
    await settle();
    const switchAsiBtn1 = findAll(installViewH1.host, '[data-mock="ButtonItem"]')
      .find((node) => node.textContent?.includes("Switch to OptiScaler.asi"));
    check("InstallPanel exposes Switch to OptiScaler.asi button", Boolean(switchAsiBtn1));
    await act(async () => { switchAsiBtn1?.click(); });
    await settle();
    check(
      "Switching dxgi.dll -> OptiScaler.asi (no flags) prompts to clean up old dxgi=n,b and stale -dx11",
      shownModals.length === 1 &&
        (shownModals[0].props as { launchOption?: string }).launchOption === "%command% -myflag",
      `modals=${shownModals.length} preview=${JSON.stringify((shownModals[0]?.props as { launchOption?: string } | undefined)?.launchOption)}`,
    );
    await respondLatestModal("ok");
    await settle();
    const afterH1 = steamLaunch.get(appidH1) ?? "";
    check(
      "Accepting cleanup after switching to OptiScaler.asi strips dxgi=n,b and -dx11 while keeping -myflag and clearing pref",
      afterH1 === "%command% -myflag" && !prefs.has(`applied_launch:${appidH1}`),
      `steam=${JSON.stringify(afterH1)} pref=${JSON.stringify(prefs.get(`applied_launch:${appidH1}`))}`,
    );
    await installViewH1.unmount();

    // (2) Switching from installed dxgi.dll to OptiScaler.asi WITH wiki launch_flags: ["-dx12"]
    // -> strips dxgi=n,b and applies -dx12; standalone button also shown for installed .asi with wiki flags
    prefs.clear();
    prefs.set("remember_choices", true);
    const appidH2 = 510009;
    steamLaunch.set(appidH2, 'WINEDLLOVERRIDES="dxgi=n,b" %command%');
    shownModals.length = 0;
    const installViewH2 = await mount(
      <InstallPanel
        detail={makeDetail("")}
        status={statusWithAsi}
        appid={String(appidH2)}
        live={null}
        running={false}
        autoPlan={{
          plan: {
            ...makePlan(["-dx12"]),
            filename: "OptiScaler.asi",
            launch_options: "%command% -dx12",
          },
          recommendation: null,
          loading: false,
          reload: async () => {},
        }}
        onChanged={async () => {}}
      />,
    );
    const asiOpt2 = installViewH2.host.querySelector<HTMLElement>(
      '[data-mock="DropdownItem"][data-label="Filename override"] [data-opt-value="OptiScaler.asi"]',
    );
    await act(async () => { asiOpt2?.click(); });
    await settle();
    const switchAsiBtn2 = findAll(installViewH2.host, '[data-mock="ButtonItem"]')
      .find((node) => node.textContent?.includes("Switch to OptiScaler.asi"));
    await act(async () => { switchAsiBtn2?.click(); });
    await settle();
    check(
      "Switching dxgi.dll -> OptiScaler.asi with wiki -dx12 previews stripped proxy + -dx12",
      shownModals.length === 1 &&
        (shownModals[0].props as { launchOption?: string }).launchOption === "%command% -dx12",
      `modals=${shownModals.length} preview=${JSON.stringify((shownModals[0]?.props as { launchOption?: string } | undefined)?.launchOption)}`,
    );
    await respondLatestModal("ok");
    await settle();
    const afterH2 = steamLaunch.get(appidH2) ?? "";
    const metaH2 = prefs.get(`applied_launch:${appidH2}`) as { flags?: string[]; extraOverrides?: string[] } | undefined;
    check(
      "Accepting prompt after switching to OptiScaler.asi with wiki -dx12 strips dxgi=n,b and sets -dx12",
      afterH2 === "%command% -dx12" &&
        JSON.stringify(metaH2) === JSON.stringify({ flags: ["-dx12"], extraOverrides: [] }),
      `steam=${JSON.stringify(afterH2)} meta=${JSON.stringify(metaH2)}`,
    );
    await installViewH2.unmount();

    // Installed OptiScaler.asi with wiki -dx12 still offers standalone "Set launch options for me"
    const asiInstalledDetail = makeDetail("");
    asiInstalledDetail.install.filename = "OptiScaler.asi";
    steamLaunch.set(appidH2, "");
    const installViewH3 = await mount(
      <InstallPanel
        detail={asiInstalledDetail}
        status={statusWithAsi}
        appid={String(appidH2)}
        live={null}
        running={false}
        autoPlan={{
          plan: {
            ...makePlan(["-dx12"]),
            filename: "OptiScaler.asi",
            launch_options: "%command% -dx12",
          },
          recommendation: null,
          loading: false,
          reload: async () => {},
        }}
        onChanged={async () => {}}
      />,
    );
    const setLaunchBtnH3 = findAll(installViewH3.host, '[data-mock="ButtonItem"]')
      .find((node) => node.textContent?.includes("Set launch options for me"));
    check(
      "Installed OptiScaler.asi with wiki launch flags still exposes 'Set launch options for me'",
      Boolean(setLaunchBtnH3),
    );
    await act(async () => { setLaunchBtnH3?.click(); });
    await settle();
    check(
      "Clicking 'Set launch options for me' on installed OptiScaler.asi applies wiki -dx12",
      steamLaunch.get(appidH2) === "%command% -dx12",
      `got: ${JSON.stringify(steamLaunch.get(appidH2))}`,
    );
    await installViewH3.unmount();
  } finally {
    (globalThis as any).SteamClient = prevSteam;
  }
}

(async () => {
  try {
    await testLibraryBrowser();
    await testWikiSearch();
    await testFsr4Panel();
    await testOptipatcherPanel();
    await testMonitorTab();
    await testSettingsTab();
    await testGamesList();
    await testBasicPanelSymmetricFsr4Restore();
    await testUseRunningGameLifecycle();
    await testSetupChecklistReapplyLaunchFlags();
  } catch (exc) {
    failures.push(`uncaught error: ${exc instanceof Error ? exc.stack ?? exc.message : String(exc)}`);
  } finally {
    clock.restore();
  }

  console.log(`\n=== React errors/warnings: ${errors.length} ===`);
  errors.slice(0, 10).forEach((e) => console.log("  ! " + e.slice(0, 300)));
  if (failures.length) {
    console.log(`\n=== UI flow checks failed: ${failures.length} ===`);
    failures.forEach((f) => console.log("  ! " + f));
  } else {
    console.log("\nall UI flow checks passed");
  }
  process.exit(errors.length > 0 || failures.length > 0 ? 1 : 0);
})();
