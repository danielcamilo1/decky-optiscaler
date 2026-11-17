import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { fixtures, invocations } from "@decky/api";
import { GENERATED_OPTIONS } from "../src/config/generatedSchema";
import { GameDetail } from "../src/components/GameDetail";

const failures: string[] = [];
const reactErrors: string[] = [];
const originalConsoleError = console.error;
console.error = (...args: any[]) => {
  const message = args.map(String).join(" ");
  if (!message.includes("not wrapped in act") && !message.includes("ReactDOMTestUtils.act")) {
    reactErrors.push(message);
  }
  originalConsoleError(...args);
};

function check(label: string, passed: boolean) {
  if (!passed) failures.push(label);
  console.log(`  [${passed ? "ok" : "FAIL"}] ${label}`);
}

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  }
}

function findAll(root: Element, selector: string) {
  return Array.from(root.querySelectorAll(selector));
}

const values: Record<string, Record<string, string>> = {};
for (const option of GENERATED_OPTIONS) {
  values[option.section] = values[option.section] ?? {};
  values[option.section][option.key] = "auto";
}
values.FrameGen.Enabled = "true";
values.FrameGen.FGInput = "fsrfg";
values.FrameGen.FGOutput = "fsrfg";
values.Upscalers.Dx12Upscaler = "fsr31";

interface UpgradeCase {
  gamePath: string;
  gameName: string;
  target: string;
  appid: string | null;
  current: boolean;
  held: boolean;
  getLiveStatus?: (target: string) => unknown;
}

const cases = new Map<string, UpgradeCase>();

function makeCase(
  suffix: string,
  options: Partial<Pick<UpgradeCase, "appid" | "current" | "held" | "getLiveStatus">> = {},
): UpgradeCase {
  const gamePath = `/games/auto-upgrade-${suffix}`;
  const item: UpgradeCase = {
    gamePath,
    gameName: `Upgrade test ${suffix}`,
    target: `${gamePath}/bin`,
    appid: null,
    current: false,
    held: false,
    ...options,
  };
  cases.set(item.gamePath, item);
  return item;
}

function gameDetail(item: UpgradeCase) {
  return {
    path: item.gamePath,
    name: item.gameName,
    target: item.target,
    target_is_saved: true,
    candidates: [{ path: item.target, relative: "bin", score: 80, executables: ["game.exe"], writable: true }],
    install: {
      path: item.target,
      installed: true,
      filename: "dxgi.dll",
      managed: true,
      version: item.current ? "0.9.5" : "0.9.4",
      runtime_current: item.current,
      runtime_upgrade_held: item.held,
      rollback: { available: false },
      installed_at: 1700000000,
      ini_present: true,
      directory_generation: "1",
      ini_path: `${item.target}/OptiScaler.ini`,
      log_present: false,
      log_path: `${item.target}/OptiScaler.log`,
      candidates: ["dxgi.dll"],
      extra_proxies: [],
      backup_dir: `${item.target}/decky_optiscaler_backup_files`,
      backed_up: ["dxgi.dll"],
      launch_record: { recorded: false, value: null },
      fsr4: { files: {}, ready: false, required: [], ffx: null },
      reframework: { installed: false, revision: null, managed: false },
    },
    reframework: {
      required: false,
      installed: false,
      dll: "dinput8.dll",
      path: `${item.target}/dinput8.dll`,
      revision: null,
      plugin: null,
      plugin_installed: false,
      plugin_url: null,
      plugin_name: null,
      complete: true,
    },
    fsr4_sources: [],
    ini_info: { present: true, legacy: false, keys: GENERATED_OPTIONS.length },
    wiki_entry: null,
    gpu: { names: ["Test GPU"], name: "Test GPU", vendor: "amd", generation: "RDNA3", fsr4: "native" },
    launch_option: 'WINEDLLOVERRIDES="dxgi=n,b" %command%',
    writable: true,
  };
}

function autoPlan(item: UpgradeCase) {
  return {
    recommendation: {
      matched: true,
      searched: [item.gameName],
      entry_count: 1,
      list_available: true,
      near_misses: [],
      game: item.gameName,
      filename: "dxgi.dll",
      filename_source: "wiki entry",
      alternatives: [],
      compatibility: "✅",
      inputs: "FSR3.1",
      optipatcher: false,
      wiki_url: "https://example.invalid/wiki",
      detail: {},
      match_score: 1,
      list_meta: { source: "cache", fetched_at: 1, error: null, stale: false, revision: "auto-upgrade-fixture" },
    },
    plan: {
      available: true,
      enabled: false,
      game: item.gameName,
      source: "wiki entry",
      runtime_supported: true,
      filename: "dxgi.dll",
      filename_source: "wiki entry",
      launch_flags: [],
      launch_options: 'WINEDLLOVERRIDES="dxgi=n,b" %command%',
      settings: [],
      framegen: null,
      warnings: [],
      unresolved: [],
      required_target: null,
    },
  };
}

function liveStatus(target: string) {
  return {
    supported: true,
    schema: 7,
    session: `upgrade-session-${target}`,
    seq: "1",
    ack: "config_request_accepted",
    active_api: "dx12",
    capability_generation: "upgrade-generation",
    directory_generation: "1",
    dir_verified: true,
    dir_matches: true,
    dir: target,
    attached: false,
    legacy_running: false,
    ready: false,
    state: "disconnected",
    error: null,
    age: 1,
    capabilities: {},
    live_keys: [],
    accepted_keys: [],
    failed_keys: [],
    switchable_backends: [],
    fps: null,
    fg_enabled: null,
  };
}

function getCaseByTarget(target: string | undefined) {
  return [...cases.values()].find((item) => item.target === target);
}

fixtures.get_game = (gamePath: string) => {
  const item = cases.get(gamePath);
  if (!item) throw new Error(`Unexpected game lookup: ${gamePath}`);
  return gameDetail(item);
};
fixtures.get_auto_plan = (_name: string, _folders: string[], _force: boolean, gamePath: string) => {
  const item = cases.get(gamePath);
  if (!item) throw new Error(`Unexpected plan lookup: ${gamePath}`);
  return autoPlan(item);
};
fixtures.read_config = (target: string) => {
  const item = getCaseByTarget(target);
  return {
    ok: true,
    path: `${target}/OptiScaler.ini`,
    values,
    modified: 1,
    runtime_current: item?.current ?? false,
    fsr4_build: null,
  };
};
fixtures.get_live_status = (target: string) => {
  const item = getCaseByTarget(target);
  return item?.getLiveStatus ? item.getLiveStatus(target) : liveStatus(target);
};
fixtures.get_monitor = (target: string) => ({
  path: target,
  log_path: `${target}/OptiScaler.log`,
  log_present: false,
  log_size: 0,
  log_modified: null,
  state: null,
  counts: { info: 0, warning: 0, error: 0 },
  frame_generation: [],
  problems: [],
  recent: [],
  configured: null,
  total_lines: 0,
});
fixtures.get_pref = (key: string, fallback?: unknown) => ({ key, value: fallback ?? null });
fixtures.set_pref = { ok: true };
fixtures.get_launch_options = { found: false, value: "", source: null };
fixtures.get_wiki_status = {
  revision: "auto-upgrade-fixture",
  stale: false,
  revalidating: false,
  error: null,
};
fixtures.set_auto_mode = (_gamePath: string, enabled: boolean) => ({ ok: true, enabled });
fixtures.apply_auto_settings = { ok: true, applied: [], rejected: [] };
fixtures.rollback_install = { ok: true, launch_options: "" };

const bundleStatus: any = { version: "0.9.5", optiscaler_version: "0.9.5" };

async function mount(item: UpgradeCase, runningGame: any = null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <GameDetail
        gamePath={item.gamePath}
        gameName={item.gameName}
        appid={item.appid}
        status={bundleStatus}
        runningGame={runningGame}
        onBack={() => {}}
      />,
    );
  });
  await settle();
  return { host, root, item };
}

async function unmount(view: Awaited<ReturnType<typeof mount>>) {
  await act(async () => view.root.unmount());
  view.host.remove();
  await settle(2);
}

function upgradeCalls(target: string) {
  return invocations.filter((call) => call.name === "upgrade_runtime" && call.args[0] === target);
}

function renderCountFor(target: string) {
  return upgradeCalls(target).length;
}

function captureLivePolls() {
  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  const callbacks: Function[] = [];
  window.setInterval = ((callback: TimerHandler, _delay?: number) => {
    if (typeof callback === "function") callbacks.push(callback);
    return callbacks.length as unknown as number;
  }) as typeof window.setInterval;
  window.clearInterval = (() => {}) as typeof window.clearInterval;
  return {
    callbacks,
    restore() {
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    },
  };
}

async function pollLive(callbacks: Function[]) {
  await act(async () => {
    callbacks[0]?.();
  });
  await settle();
}

async function run() {
  console.log("=== automatic runtime upgrade UI ===");

  // A managed old runtime is upgraded once, and the settings become editable
  // after GameDetail and the INI reader both report the new identity.
  {
    const item = makeCase("success");
    let calls = 0;
    fixtures.upgrade_runtime = (target: string, gamePath: string, launch: string | null, name: string) => {
      calls++;
      item.current = true;
      return { ok: true, upgraded: true };
    };
    const view = await mount(item);
    const updates = upgradeCalls(item.target);
    const frameGen = findAll(view.host, '[data-mock="ToggleField"][data-label="Frame generation"]')[0];
    check("a managed old runtime upgrades exactly once", calls === 1 && updates.length === 1);
    check("the upgrade receives this target, game path, launch value, and name",
      updates[0]?.args[0] === item.target && updates[0]?.args[1] === item.gamePath &&
      updates[0]?.args[2] === null && updates[0]?.args[3] === item.gameName);
    check("Basic settings become editable after the upgrade is read back",
      Boolean(frameGen) && frameGen.getAttribute("data-disabled") !== "true");
    await unmount(view);
  }

  // Running is deferred by the UI. Once the same page sees the game stop, it
  // performs the upgrade once with the current Steam launch options.
  {
    const item = makeCase("running", { appid: "910002" });
    const previousSteam = (globalThis as any).SteamClient;
    (globalThis as any).SteamClient = {
      Apps: { GetAppLaunchOptions: async () => "gamescope --mangoapp %command%" },
    };
    fixtures.upgrade_runtime = (target: string) => {
      const current = getCaseByTarget(target);
      if (current) current.current = true;
      return { ok: true, upgraded: true };
    };
    const runningGame = { appid: 910002, gameid: "910002", name: item.gameName };
    const view = await mount(item, runningGame);
    check("a running game defers its runtime update", renderCountFor(item.target) === 0 &&
      view.host.textContent!.includes("Waiting for the game to close"));
    await act(async () => {
      view.root.render(
        <GameDetail gamePath={item.gamePath} gameName={item.gameName} appid={item.appid}
          status={bundleStatus} runningGame={null} onBack={() => {}} />,
      );
    });
    await settle();
    const calls = upgradeCalls(item.target);
    check("stopping the game triggers one update with the current launch options",
      calls.length === 1 && calls[0]?.args[2] === "gamescope --mangoapp %command%");
    await unmount(view);
    (globalThis as any).SteamClient = previousSteam;
  }

  // An explicit rollback hold leaves the old runtime untouched until the user
  // chooses an upgrade in Setup.
  {
    const item = makeCase("held", { held: true });
    fixtures.upgrade_runtime = () => ({ ok: true, upgraded: true });
    const view = await mount(item);
    check("a held previous install skips automatic upgrade", renderCountFor(item.target) === 0 &&
      view.host.textContent!.includes("Upgrade manually in Setup"));
    await unmount(view);
  }

  // A deferred response retries on the next status epoch. A later failure is
  // not retried on further polls in this mount, while remounting starts a new
  // attempt for the same target and bundled version.
  {
    const poll = captureLivePolls();
    const item = makeCase("status-epoch");
    let calls = 0;
    fixtures.upgrade_runtime = (target: string) => {
      calls++;
      if (calls === 1) return { ok: true, deferred: true };
      if (calls === 2) return { ok: false, error: "Temporary upgrade failure" };
      const current = getCaseByTarget(target);
      if (current) current.current = true;
      return { ok: true, upgraded: true };
    };
    const view = await mount(item);
    check("a deferred response leaves the page out of a blocking spinner",
      calls === 1 && view.host.textContent!.includes("Waiting for the game to close"));
    await pollLive(poll.callbacks);
    check("a new status epoch retries a deferred update", calls === 2 &&
      view.host.textContent!.includes("Temporary upgrade failure"));
    await pollLive(poll.callbacks);
    check("a failed update is not retried by later status epochs", calls === 2);
    await unmount(view);
    const remounted = await mount(item);
    check("remounting allows one new attempt for the same target and bundle",
      calls === 3 && renderCountFor(item.target) === 3 && item.current);
    await unmount(remounted);
    poll.restore();
  }

  // If Steam has not answered the current launch-options request, closing the
  // page before it resolves must leave the runtime files untouched.
  {
    const item = makeCase("unmount-pending-launch", { appid: "910005" });
    const previousSteam = (globalThis as any).SteamClient;
    const previousDetails = (globalThis as any).appDetailsStore;
    const pending: Array<(value: string) => void> = [];
    (globalThis as any).appDetailsStore = undefined;
    (globalThis as any).SteamClient = {
      Apps: {
        GetAppLaunchOptions: () => new Promise<string>((resolve) => pending.push(resolve)),
      },
    };
    fixtures.upgrade_runtime = () => ({ ok: true, upgraded: true });
    const view = await mount(item);
    check("a pending Steam launch-options read has not called the upgrade RPC",
      pending.length > 0 && renderCountFor(item.target) === 0);
    await unmount(view);
    await act(async () => pending.forEach((resolve) => resolve("gamescope %command%")));
    await settle();
    check("resolving launch options after unmount does not call the upgrade RPC",
      renderCountFor(item.target) === 0);
    (globalThis as any).SteamClient = previousSteam;
    (globalThis as any).appDetailsStore = previousDetails;
  }

  // A Steam-owned game with no readable launch-options answer must not enter
  // the upgrade RPC, which captures those options in its rollback snapshot.
  {
    const item = makeCase("unreadable-launch", { appid: "910006" });
    const previousSteam = (globalThis as any).SteamClient;
    const previousDetails = (globalThis as any).appDetailsStore;
    (globalThis as any).appDetailsStore = undefined;
    (globalThis as any).SteamClient = { Apps: { GetAppLaunchOptions: async () => null } };
    fixtures.get_launch_options = { found: false, value: "", source: null };
    fixtures.upgrade_runtime = () => ({ ok: true, upgraded: true });
    const view = await mount(item);
    check("unreadable Steam launch options prevent the automatic upgrade RPC",
      renderCountFor(item.target) === 0 &&
      view.host.textContent!.includes("Steam launch options are unavailable"));
    await unmount(view);
    (globalThis as any).SteamClient = previousSteam;
    (globalThis as any).appDetailsStore = previousDetails;
  }

  console.log(`\nReact errors: ${reactErrors.length}`);
  if (reactErrors.length) reactErrors.slice(0, 8).forEach((message) => console.log(`  ! ${message}`));
  if (failures.length) {
    console.log(`\nBehavior checks failed: ${failures.length}`);
    failures.forEach((label) => console.log(`  ! ${label}`));
  }
  process.exit(reactErrors.length || failures.length ? 1 : 0);
}

void run();
