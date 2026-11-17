import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import assert from "node:assert/strict";
import { fixtures, invocations } from "@decky/api";
import { shownModals } from "@decky/ui";
import { GameDetail } from "../src/components/GameDetail";
import { SetupChecklist } from "../src/components/SetupChecklist";

const roots: { root: Root; host: HTMLElement; mounted: boolean }[] = [];
const failures: string[] = [];
const warnings: string[] = [];
const prefValues = new Map<string, unknown>([["remember_choices", true]]);
const backendLaunchOptions = new Map<string, string | null>();
let rollbackAnswer: string | null = "before install %command%";
let uninstallAnswer: any = { ok: false, error: "uninstall rejected" };
const gameDetail: any = {};

const planResult = {
  plan: { available: false, game: null, filename: "dxgi.dll", settings: [], framegen: null },
  recommendation: { matched: false, list_available: true, notes: null, detail: {}, list_meta: { revision: "stable" } },
};
Object.assign(fixtures, {
  get_game: () => gameDetail,
  get_auto_plan: planResult,
  get_live_status: { supported: false, attached: false, asi_installed: false, load_enabled: false },
  read_config: () => ({ ok: true, values: {}, runtime_current: true, fsr4_build: "bundled" }),
  get_monitor: { path: "", log_path: "", log_present: false, log_size: 0, log_modified: null,
    logging_enabled: null, state: {}, counts: {}, frame_generation: [], problems: [], recent: [], hints: [], configured: {} },
  rollback_install: () => ({ ok: true, launch_options: rollbackAnswer }),
  get_launch_options: (appid: string) => {
    const value = backendLaunchOptions.get(String(appid));
    return value == null
      ? { found: false, value: "", source: null }
      : { found: true, value, source: "harness" };
  },
  get_pref: (key: string, fallback?: unknown) => ({ key, value: prefValues.has(key) ? prefValues.get(key) : fallback ?? null }),
  set_pref: (key: string, value: unknown) => { prefValues.set(key, value); return { ok: true }; },
  uninstall: () => uninstallAnswer,
});

function makeDetail(path: string, savedLaunch: string | null, recorded = true, metadata: string | null = savedLaunch) {
  return {
    path, name: "Recovery Harness", target: `${path}/bin/x64`, target_is_saved: true,
    candidates: [], ini_info: { present: true, directory_generation: "1", legacy: false, keys: 1 }, wiki_entry: null,
    fsr4_sources: [], gpu: { names: [], name: "Test GPU", gfx: null, vendor: "amd", generation: "RDNA2", fsr4: "unknown" },
    launch_option: "", writable: true,
    reframework: { required: false, installed: false, dll: "dinput8.dll", path: `${path}/bin/x64/dinput8.dll`,
      revision: null, managed: false, plugin: null, plugin_installed: false, plugin_url: null, plugin_name: null, complete: true },
    install: {
      path: `${path}/bin/x64`, installed: true, filename: "dxgi.dll", managed: true, version: "0.9.5",
      runtime_current: true, installed_at: 1, ini_present: true, directory_generation: "1", ini_path: `${path}/bin/x64/OptiScaler.ini`,
      log_present: false, log_path: "", candidates: ["dxgi.dll"], extra_proxies: [],
      backup_dir: `${path}/backup`, backed_up: ["dxgi.dll"],
      launch_record: { recorded, value: recorded ? savedLaunch ?? "" : "" },
      rollback: { available: true, version: "0.9.5", metadata: { launch_options: metadata } },
      fsr4: { files: {}, ready: false, required: [] }, reframework: { installed: false, revision: null, managed: false },
    },
  };
}

function count(name: string, firstArg?: unknown) {
  return invocations.filter((item) => item.name === name && (firstArg === undefined || item.args[0] === firstArg)).length;
}
function button(host: HTMLElement, label: string) {
  return [...host.querySelectorAll<HTMLElement>('[data-mock="DialogButton"]')]
    .find((node) => node.textContent?.trim() === label);
}
async function pump() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function waitFor(predicate: () => boolean, label: string) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await pump();
  }
  assert.fail(`Timed out waiting for ${label}`);
}
async function render(element: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const entry = { root, host, mounted: true };
  roots.push(entry);
  await act(async () => { root.render(element); });
  return {
    host,
    async unmount() {
      if (!entry.mounted) return;
      await act(async () => { root.unmount(); });
      entry.mounted = false;
      host.remove();
    },
  };
}
async function renderGame(path: string, appid: string, detail: any) {
  Object.assign(gameDetail, detail);
  return render(<GameDetail gamePath={path} gameName={detail.name} appid={appid} status={null} runningGame={null} onBack={() => {}} />);
}
async function renderChecklist(detail: any, appid: string, onChanged: () => Promise<void> | void = () => {}) {
  return render(<SetupChecklist
    detail={detail} appid={appid} plan={null} recommendation={null} loadingWiki={false} refreshing={false}
    auto={false} live={null} running={false} onSetAuto={() => {}} onManual={() => {}} onLogs={() => {}}
    onChanged={onChanged} onReloadPlan={() => {}} onResetConfig={() => {}} onBeforeMutation={() => {}}
  />);
}
async function click(host: HTMLElement, label: string) {
  const target = button(host, label);
  assert.ok(target, `missing button: ${label}`);
  await act(async () => { target!.click(); });
}
async function openRemove(host: HTMLElement) {
  const before = shownModals.length;
  await click(host, "Remove");
  await waitFor(() => shownModals.length > before, "Remove confirmation modal");
  const modal = shownModals[shownModals.length - 1];
  assert.equal(typeof modal.props.onConfirm, "function");
  return modal;
}
async function confirm(modal: any, action: "restore" | "clear") {
  await act(async () => { modal.props.onConfirm(action, false); await Promise.resolve(); });
}

function steam(get: (appid: number) => string, setter: (appid: number, value: string) => void) {
  (globalThis as any).SteamClient = { Apps: { GetAppLaunchOptions: async (appid: number) => get(appid), SetAppLaunchOptions: setter } };
}

async function run() {
  const saved = "gamemoderun %command% -dx12";
  const path = "/games/recovery-restore";
  const appid = "9410041";
  const detail = makeDetail(path, saved, true, saved);
  let current = 'WINEDLLOVERRIDES="dxgi=n,b" %command%';
  let setterCalls: string[] = [];
  steam(() => current, (_id, value) => { setterCalls.push(value); throw new Error("Steam rejected options"); });
  rollbackAnswer = saved;
  fixtures.rollback_install = () => ({ ok: true, launch_options: rollbackAnswer });
  const failedRestore = await renderGame(path, appid, detail);
  await waitFor(() => Boolean(button(failedRestore.host, "Restore previous install")), "recovery action");
  const rollbackCalls = count("rollback_install", detail.install.path);
  await click(failedRestore.host, "Restore previous install");
  await waitFor(() => {
    const retry = button(failedRestore.host, "Retry launch options");
    return Boolean(retry && retry.getAttribute("data-disabled") !== "true");
  }, "retained Steam retry after restore reload");
  assert.ok(count("rollback_install", detail.install.path) > rollbackCalls, "restore must use the backend snapshot");
  assert.equal(setterCalls[0], saved);
  assert.ok(failedRestore.host.textContent?.includes("Steam rejected the launch options"));
  await failedRestore.unmount();

  const reopened = await renderGame(path, appid, detail);
  await waitFor(() => Boolean(button(reopened.host, "Apply saved launch options")), "saved launch action after remount");
  await reopened.unmount();

  const nullPath = "/games/recovery-null-options";
  const nullDetail = makeDetail(nullPath, saved, true, null);
  current = "user wrapper %command% -from-steam";
  setterCalls = [];
  rollbackAnswer = null;
  fixtures.rollback_install = () => ({ ok: true, launch_options: null });
  const nullRestore = await renderGame(nullPath, "9410042", nullDetail);
  await waitFor(() => Boolean(button(nullRestore.host, "Restore previous install")), "null-option recovery action");
  await click(nullRestore.host, "Restore previous install");
  await waitFor(() => nullRestore.host.textContent?.includes("restore it manually") === true &&
    button(nullRestore.host, "Restore previous install")?.getAttribute("data-disabled") !== "true", "manual launch guidance after reload");
  assert.deepEqual(setterCalls, [], "an unknown saved launch value must not clear Steam");
  assert.equal(current, "user wrapper %command% -from-steam");
  await nullRestore.unmount();

  const removePath = "/games/remove-setter-failure";
  const removeApp = "9410043";
  const removeDetail = makeDetail(removePath, saved);
  current = 'WINEDLLOVERRIDES="dxgi=n,b" lsfg-run %command%';
  setterCalls = [];
  steam(() => current, (_id, value) => { setterCalls.push(value); throw new Error("Steam rejected options"); });
  uninstallAnswer = { ok: true };
  const keepFiles = await renderChecklist(removeDetail, removeApp);
  shownModals.length = 0;
  const rejectedModal = await openRemove(keepFiles.host);
  await confirm(rejectedModal, "restore");
  await waitFor(() => keepFiles.host.textContent?.includes("original launch record is intact") ?? false, "remove setter rejection");
  assert.equal(count("uninstall", `${removePath}/bin/x64`), 0);
  assert.equal(removeDetail.install.launch_record.value, saved);
  await keepFiles.unmount();

  const unknownPath = "/games/remove-unknown-options";
  const unknownApp = "9410044";
  const unknownDetail = makeDetail(unknownPath, saved);
  const previousDetails = (globalThis as any).appDetailsStore;
  (globalThis as any).appDetailsStore = undefined;
  backendLaunchOptions.set(unknownApp, null);
  let unknownWrites: string[] = [];
  (globalThis as any).SteamClient = { Apps: { SetAppLaunchOptions: (_id: number, value: string) => unknownWrites.push(value) } };
  const retrying = await renderChecklist(unknownDetail, unknownApp);
  shownModals.length = 0;
  const unknownModal = await openRemove(retrying.host);
  await confirm(unknownModal, "restore");
  await waitFor(() => retrying.host.textContent?.includes("current value is unknown") ?? false, "unknown Steam value guard");
  assert.equal(count("uninstall", `${unknownPath}/bin/x64`), 0);
  assert.deepEqual(unknownWrites, []);
  const launchReads = count("get_launch_options", unknownApp);
  await click(retrying.host, "Retry Steam update and removal");
  await waitFor(() => count("get_launch_options", unknownApp) > launchReads &&
    button(retrying.host, "Retry Steam update and removal")?.getAttribute("data-disabled") !== "true", "unknown retry read");
  assert.equal(count("uninstall", `${unknownPath}/bin/x64`), 0, "repeated unknown reads must not uninstall");
  assert.deepEqual(unknownWrites, []);

  current = "lsfg-run %command% -dx12 -user-edit";
  const freshCurrent = current;
  const freshWrites: string[] = [];
  steam(() => current, (_id, value) => { freshWrites.push(value); current = value; });
  uninstallAnswer = { ok: false, error: "files busy" };
  const failedUninstalls = count("uninstall", `${unknownPath}/bin/x64`);
  await click(retrying.host, "Retry Steam update and removal");
  await waitFor(() => count("uninstall", `${unknownPath}/bin/x64`) > failedUninstalls &&
    freshWrites.length === 2 && button(retrying.host, "Retry Steam update and removal")?.getAttribute("data-disabled") !== "true", "retry with fresh Steam value");
  assert.deepEqual(freshWrites, [saved, freshCurrent], "failed uninstall must restore the newly read user value");
  assert.equal(current, freshCurrent);
  await retrying.unmount();
  (globalThis as any).appDetailsStore = previousDetails;

  const stripPath = "/games/remove-strip-retry";
  const stripApp = "9410046";
  const stripDetail = makeDetail(stripPath, "", false, null);
  current = 'WINEDLLOVERRIDES="dxgi=n,b" lsfg-run %command% -old';
  const stripWrites: string[] = [];
  let rejectStrip = true;
  steam(() => current, (_id, value) => {
    stripWrites.push(value);
    if (rejectStrip) throw new Error("Steam rejected options");
    current = value;
  });
  uninstallAnswer = { ok: true };
  const stripRetry = await renderChecklist(stripDetail, stripApp);
  shownModals.length = 0;
  const stripModal = await openRemove(stripRetry.host);
  await confirm(stripModal, "clear");
  await waitFor(() => stripRetry.host.textContent?.includes("Steam rejected the launch-options change") ?? false, "strip-only setter rejection");
  assert.equal(count("uninstall", `${stripPath}/bin/x64`), 0);
  current = 'WINEDLLOVERRIDES="dxgi=n,b" lsfg-run %command% -old -new';
  rejectStrip = false;
  await click(stripRetry.host, "Retry Steam update and removal");
  await waitFor(() => count("uninstall", `${stripPath}/bin/x64`) > 0, "strip retry uninstall");
  assert.deepEqual(stripWrites, [
    "lsfg-run %command% -old",
    "lsfg-run %command% -old -new",
  ], "strip-only retry must preserve Steam edits made after the failed attempt");
  assert.equal(current, "lsfg-run %command% -old -new");
  await stripRetry.unmount();

  const finalPath = "/games/remove-refresh-fails";
  const finalApp = "9410045";
  const finalDetail = makeDetail(finalPath, saved);
  current = 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11';
  const finalWrites: string[] = [];
  steam(() => current, (_id, value) => { finalWrites.push(value); current = value; });
  uninstallAnswer = { ok: true };
  let changed = 0;
  const refreshFailure = await renderChecklist(finalDetail, finalApp, async () => { changed += 1; throw new Error("refresh failed"); });
  shownModals.length = 0;
  const finalModal = await openRemove(refreshFailure.host);
  const beforeUninstall = count("uninstall", `${finalPath}/bin/x64`);
  await confirm(finalModal, "restore");
  await waitFor(() => count("uninstall", `${finalPath}/bin/x64`) > beforeUninstall && changed === 1 &&
    button(refreshFailure.host, "Remove")?.getAttribute("data-disabled") !== "true", "post-remove refresh failure");
  assert.deepEqual(finalWrites, [saved], "a refresh error after successful removal must not restore the old override");
  await refreshFailure.unmount();
}

const oldWarn = console.warn;
const oldError = console.error;
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); oldWarn(...args); };
console.error = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); oldError(...args); };
void (async () => {
  try { await run(); console.log("recovery UI harness scenarios passed"); }
  catch (error) { failures.push(String(error)); }
  finally {
    for (const entry of [...roots].reverse()) {
      if (!entry.mounted) continue;
      try { await act(async () => { entry.root.unmount(); }); entry.host.remove(); entry.mounted = false; }
      catch (error) { failures.push(`root cleanup: ${String(error)}`); }
    }
    console.warn = oldWarn;
    console.error = oldError;
    shownModals.length = 0;
    (globalThis as any).appDetailsStore = undefined;
    (globalThis as any).SteamClient = undefined;
  }
  if (failures.length || warnings.length) {
    console.error(`recovery UI harness failed (${failures.length} failures, ${warnings.length} React warnings)`);
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exitCode = 1;
  }
})();
