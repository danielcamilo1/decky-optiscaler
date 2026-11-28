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
  get_game: () => JSON.parse(JSON.stringify(gameDetail)),
  get_auto_plan: planResult,
  wiki_status: { revision: "stable", stale: false, revalidating: false, error: null },
  get_live_status: { supported: false, attached: false, asi_installed: false, load_enabled: false },
  read_config: () => ({ ok: true, values: {}, runtime_current: true, fsr4_build: "bundled" }),
  get_monitor: { path: "", log_path: "", log_present: false, log_size: 0, log_modified: null,
    logging_enabled: null, state: {}, counts: {}, frame_generation: [], problems: [], recent: [], hints: [], configured: {} },
  rollback_install: () => {
    if (gameDetail.install?.rollback) gameDetail.install.rollback.launch_pending = true;
    return { ok: true, launch_options: rollbackAnswer, launch_pending: true };
  },
  confirm_rollback_launch_options: () => {
    if (gameDetail.install?.rollback) gameDetail.install.rollback.launch_pending = false;
    return { ok: true };
  },
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

function makeDetail(
  path: string,
  savedLaunch: string | null,
  recorded = true,
  metadata: string | null = savedLaunch,
  launchPending = false,
) {
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
      rollback: {
        available: true,
        version: "0.9.5",
        launch_pending: launchPending,
        metadata: { launch_options: metadata },
      },
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
async function openTab(host: HTMLElement, id: string) {
  const tabBtn = host.querySelector<HTMLElement>(`[data-tab-button="${id}"]`);
  assert.ok(tabBtn, `missing tab button: ${id}`);
  await act(async () => { tabBtn.click(); });
  await pump();
}
async function renderGame(path: string, appid: string, detail: any) {
  Object.assign(gameDetail, detail);
  const view = await render(<GameDetail gamePath={path} gameName={detail.name} appid={appid} status={null} runningGame={null} onBack={() => {}} />);
  await waitFor(() => Boolean(view.host.querySelector('[data-tab-button="install"]')), "GameDetail tabs");
  await openTab(view.host, "install");
  return view;
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

/** Mount the latest modal pushed to showModal() and click its ConfirmModal OK or Cancel button. */
async function respondModal(
  action: "ok" | "cancel",
  beforeClick?: (modalHost: HTMLElement) => Promise<void> | void,
) {
  assert.ok(shownModals.length > 0, "expected a modal to be shown");
  const modalElement = shownModals[shownModals.length - 1];
  let closed = false;
  const rendered = await render(
    React.cloneElement(modalElement, { closeModal: () => { closed = true; } }),
  );
  try {
    if (beforeClick) await beforeClick(rendered.host);
    const btn = rendered.host.querySelector<HTMLElement>(
      action === "ok" ? "[data-modal-ok]" : "[data-modal-cancel]",
    );
    assert.ok(btn, `missing ConfirmModal ${action} button`);
    await act(async () => { btn.click(); await Promise.resolve(); });
    assert.equal(closed, true, `ConfirmModal ${action} should invoke closeModal`);
  } finally {
    await rendered.unmount();
  }
}

async function openRemove(host: HTMLElement) {
  const before = shownModals.length;
  await click(host, "Remove");
  await waitFor(() => shownModals.length > before, "Remove confirmation modal");
  return shownModals[shownModals.length - 1];
}

async function confirmRemoveThroughModal(action: "restore" | "clear" | "cancel") {
  if (action === "cancel") {
    await respondModal("cancel");
    return;
  }
  await respondModal("ok", async (modalHost) => {
    if (action === "clear") {
      // RemovePrompt defaults to the first choice (restore/clear); pick the desired choice if needed.
      const clearToggle = [...modalHost.querySelectorAll<HTMLElement>('[data-mock="ToggleField"]')]
        .find((node) => node.textContent?.includes("Remove OptiScaler's override"));
      const toggleSpan = clearToggle?.querySelector<HTMLElement>("[data-toggle]");
      if (toggleSpan && toggleSpan.getAttribute("data-checked") !== "true") {
        await act(async () => { toggleSpan.click(); });
      }
    }
  });
}

function steam(get: (appid: number) => string, setter: (appid: number, value: string) => void) {
  (globalThis as any).SteamClient = { Apps: { GetAppLaunchOptions: async (appid: number) => get(appid), SetAppLaunchOptions: setter } };
}

async function run() {
  const saved = "gamemoderun %command% -dx12";
  const path = "/games/recovery-restore";
  const appid = "9410041";
  const detail = makeDetail(path, saved, true, saved, false);
  let current = 'WINEDLLOVERRIDES="dxgi=n,b" %command%';
  let setterCalls: string[] = [];
  steam(() => current, (_id, value) => { setterCalls.push(value); throw new Error("Steam rejected options"); });
  rollbackAnswer = saved;
  fixtures.rollback_install = () => {
    gameDetail.install.rollback.launch_pending = true;
    return { ok: true, launch_options: rollbackAnswer, launch_pending: true };
  };
  const failedRestore = await renderGame(path, appid, detail);
  await waitFor(() => Boolean(button(failedRestore.host, "Restore previous install")), "recovery action");
  // [UI-02]: A normal Steam game with a restore point (launch_pending=false) must NOT show the
  // "Apply saved launch options" warning or button.
  assert.equal(
    button(failedRestore.host, "Apply saved launch options"),
    undefined,
    "normal Steam game with restore point must not permanently show Apply saved launch options",
  );
  // [UI-12]: Clicking Restore previous install opens a ConfirmModal; Cancel must not call rollback_install.
  const rollbackCalls = count("rollback_install", detail.install.path);
  shownModals.length = 0;
  await click(failedRestore.host, "Restore previous install");
  await waitFor(() => shownModals.length === 1, "Restore ConfirmModal");
  await respondModal("cancel");
  await pump();
  assert.equal(count("rollback_install", detail.install.path), rollbackCalls, "cancelling Restore modal must not roll back");

  shownModals.length = 0;
  await click(failedRestore.host, "Restore previous install");
  await waitFor(() => shownModals.length === 1, "Restore ConfirmModal (confirm)");
  await respondModal("ok");
  await waitFor(() => {
    const retry = button(failedRestore.host, "Retry launch options");
    return Boolean(retry && retry.getAttribute("data-disabled") !== "true");
  }, "retained Steam retry after restore reload");
  assert.ok(count("rollback_install", detail.install.path) > rollbackCalls, "restore must use the backend snapshot");
  assert.equal(setterCalls[0], saved);
  assert.ok(failedRestore.host.textContent?.includes("Steam rejected the launch options"));
  // [UI-02]: Only one error banner (the top blockingBar), never a duplicate error Notice inside RecoverySection.
  assert.equal(
    failedRestore.host.textContent?.split("Steam rejected the launch options").length,
    2,
    "restoreError must appear once (no duplicate red banner)",
  );
  await failedRestore.unmount();

  // After remount with persisted launch_pending=true, RecoverySection shows "Apply saved launch options",
  // and clicking it requires ConfirmModal confirmation (Cancel = no-op, OK = writes Steam & clears marker).
  const reopened = await renderGame(path, appid, detail);
  await waitFor(() => Boolean(button(reopened.host, "Apply saved launch options")), "saved launch action after remount");
  const writesBeforeApply = setterCalls.length;
  shownModals.length = 0;
  await click(reopened.host, "Apply saved launch options");
  await waitFor(() => shownModals.length === 1, "Apply saved launch ConfirmModal (cancel)");
  await respondModal("cancel");
  assert.equal(setterCalls.length, writesBeforeApply, "cancelling Apply saved launch options must not overwrite Steam");

  // Now let Steam accept the saved launch options and confirm via ConfirmModal OK.
  steam(() => current, (_id, value) => { setterCalls.push(value); current = value; });
  const confirmCallsBefore = count("confirm_rollback_launch_options", path);
  shownModals.length = 0;
  await click(reopened.host, "Apply saved launch options");
  await waitFor(() => shownModals.length === 1, "Apply saved launch ConfirmModal (ok)");
  await respondModal("ok");
  await waitFor(() => count("confirm_rollback_launch_options", path) > confirmCallsBefore, "confirm_rollback_launch_options call");
  assert.equal(current, saved, "OK on Apply saved launch options writes the saved value");
  await waitFor(() => !button(reopened.host, "Apply saved launch options"), "Apply button clears once confirmed");
  await reopened.unmount();

  const nullPath = "/games/recovery-null-options";
  const nullDetail = makeDetail(nullPath, saved, true, null, false);
  current = "user wrapper %command% -from-steam";
  setterCalls = [];
  rollbackAnswer = null;
  fixtures.rollback_install = () => ({ ok: true, launch_options: null });
  const nullRestore = await renderGame(nullPath, "9410042", nullDetail);
  await waitFor(() => Boolean(button(nullRestore.host, "Restore previous install")), "null-option recovery action");
  shownModals.length = 0;
  await click(nullRestore.host, "Restore previous install");
  await waitFor(() => shownModals.length === 1, "null-option Restore ConfirmModal");
  await respondModal("ok");
  await waitFor(() => nullRestore.host.textContent?.includes("restore it manually") === true &&
    button(nullRestore.host, "Restore previous install")?.getAttribute("data-disabled") !== "true", "manual launch guidance after reload");
  assert.deepEqual(setterCalls, [], "an unknown saved launch value must not clear Steam");
  assert.equal(current, "user wrapper %command% -from-steam");
  await nullRestore.unmount();

  // [TS-05]: Verify RemovePrompt ConfirmModal Cancel does nothing, and OK executes removal flow.
  const removePath = "/games/remove-setter-failure";
  const removeApp = "9410043";
  const removeDetail = makeDetail(removePath, saved);
  current = 'WINEDLLOVERRIDES="dxgi=n,b" lsfg-run %command%';
  setterCalls = [];
  steam(() => current, (_id, value) => { setterCalls.push(value); throw new Error("Steam rejected options"); });
  uninstallAnswer = { ok: true };
  const keepFiles = await renderChecklist(removeDetail, removeApp);
  shownModals.length = 0;
  await openRemove(keepFiles.host);
  await confirmRemoveThroughModal("cancel");
  await pump();
  assert.equal(setterCalls.length, 0, "cancelling RemovePrompt must not touch Steam launch options");
  assert.equal(count("uninstall", `${removePath}/bin/x64`), 0, "cancelling RemovePrompt must not uninstall");

  shownModals.length = 0;
  await openRemove(keepFiles.host);
  await confirmRemoveThroughModal("restore");
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
  await openRemove(retrying.host);
  await confirmRemoveThroughModal("restore");
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
  await openRemove(stripRetry.host);
  await confirmRemoveThroughModal("clear");
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
  await openRemove(refreshFailure.host);
  const beforeUninstall = count("uninstall", `${finalPath}/bin/x64`);
  await confirmRemoveThroughModal("restore");
  await waitFor(() => count("uninstall", `${finalPath}/bin/x64`) > beforeUninstall && changed === 1 &&
    button(refreshFailure.host, "Remove")?.getAttribute("data-disabled") !== "true", "post-remove refresh failure");
  assert.deepEqual(finalWrites, [saved], "a refresh error after successful removal must not restore the old override");
  await refreshFailure.unmount();

  // Comment 4726888098: Restore point snapshots applied_launch (["-dx11"]); after updating to -dx12,
  // restoring puts back Steam launch options AND applied_launch (ONLY after setLaunchOptions succeeds,
  // including retry path), so a subsequent Re-apply to -dx12 strips -dx11 cleanly!
  {
    const prevPlan = fixtures.get_auto_plan;
    const prevSetPref = fixtures.set_pref;
    const prevCreateRp = fixtures.create_restore_point;
    const prevAutoInstall = fixtures.auto_install;
    const prevRollback = fixtures.rollback_install;
    try {
      const rpPath = "/games/recovery-applied-launch";
      const rpApp = "9410098";
      const dx11Steam = 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11';
      const dx12Steam = 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx12';
      const dx12Plan = {
        plan: {
          available: true,
          game: "Applied Launch Game",
          source: "wiki entry",
          wiki_url: "https://example.invalid/wiki/AppliedLaunch",
          filename: "dxgi.dll",
          filename_source: "wiki",
          launch_flags: ["-dx12"],
          launch_options: dx12Steam,
          reframework: null,
          optipatcher: false,
          settings: [],
          framegen: null,
          hotkey: null,
          unresolved: [],
          warnings: [],
        },
        recommendation: {
          matched: true,
          game: "Applied Launch Game",
          list_available: true,
          filename: "dxgi.dll",
          filename_source: "wiki",
          alternatives: [],
          notes: null,
          detail: {},
          list_meta: { revision: "stable" },
        },
      };
      fixtures.get_auto_plan = () => dx12Plan;
      fixtures.set_pref = (key: string, value: unknown) => {
        if (value === null || value === undefined) prefValues.delete(key);
        else prefValues.set(key, value);
        return { ok: true };
      };
      let capturedSnapshot: { launch: string | null; applied: unknown } | null = null;
      fixtures.create_restore_point = (
        _target: string,
        _gamePath: string,
        launch: string | null,
        applied: unknown,
      ) => {
        capturedSnapshot = { launch, applied };
        return { ok: true, available: true };
      };
      fixtures.auto_install = () => ({ ok: true, plan: dx12Plan.plan });

      // Start on -dx11 install and run Re-apply -> snapshots { flags: ["-dx11"] } and upgrades to -dx12
      prefValues.set(`applied_launch:${rpApp}`, { flags: ["-dx11"], extraOverrides: [] });
      current = dx11Steam;
      steam(() => current, (_id, value) => { current = value; });
      const rpDetail = makeDetail(rpPath, "", true, dx11Steam, false);
      rpDetail.install.rollback.metadata = {
        launch_options: dx11Steam,
        applied_launch: { flags: ["-dx11"], extraOverrides: [] },
      } as any;

      const view = await renderGame(rpPath, rpApp, rpDetail);
      await waitFor(() => Boolean(button(view.host, "Set up again")), "Set up again button");
      await click(view.host, "Set up again");
      await waitFor(() => current === dx12Steam, "initial reapply to -dx12");
      assert.deepEqual(
        capturedSnapshot,
        { launch: dx11Steam, applied: { flags: ["-dx11"], extraOverrides: [] } },
        "create_restore_point must snapshot both Steam launch options and applied_launch metadata",
      );
      assert.deepEqual(
        prefValues.get(`applied_launch:${rpApp}`),
        { flags: ["-dx12"], extraOverrides: [] },
        "reapply must update applied_launch to ['-dx12']",
      );

      // Now simulate rollback where Steam rejects the first setLaunchOptions write:
      // applied_launch MUST stay ['-dx12'] until retry succeeds!
      let rejectRestoreSteam = true;
      steam(() => current, (_id, value) => {
        if (rejectRestoreSteam) throw new Error("Steam rejected restore");
        current = value;
      });
      fixtures.rollback_install = () => {
        gameDetail.install.rollback.launch_pending = true;
        return {
          ok: true,
          launch_options: dx11Steam,
          applied_launch: { flags: ["-dx11"], extraOverrides: [] },
          launch_pending: true,
        };
      };
      shownModals.length = 0;
      await click(view.host, "Restore previous install");
      await waitFor(() => shownModals.length === 1, "applied_launch Restore ConfirmModal");
      await respondModal("ok");
      await waitFor(() => Boolean(button(view.host, "Retry launch options")), "Retry launch options button");
      assert.deepEqual(
        prefValues.get(`applied_launch:${rpApp}`),
        { flags: ["-dx12"], extraOverrides: [] },
        "applied_launch must NOT be overwritten before Steam accepts the restored launch options",
      );

      // Retry succeeds -> Steam gets -dx11 AND applied_launch is restored to ['-dx11']
      rejectRestoreSteam = false;
      const confirmBefore = count("confirm_rollback_launch_options", rpPath);
      await click(view.host, "Retry launch options");
      await waitFor(
        () => count("confirm_rollback_launch_options", rpPath) > confirmBefore,
        "confirm_rollback_launch_options after retry",
      );
      assert.equal(current, dx11Steam, "retry restores Steam launch options to -dx11");
      assert.deepEqual(
        prefValues.get(`applied_launch:${rpApp}`),
        { flags: ["-dx11"], extraOverrides: [] },
        "retry restores applied_launch to ['-dx11'] after Steam write succeeds",
      );

      // Click Re-apply again with -dx12 -> Steam MUST end up with ONLY -dx12 (not -dx12 -dx11)!
      await click(view.host, "Set up again");
      await waitFor(() => current === dx12Steam, "second reapply after rollback");
      assert.equal(
        current,
        dx12Steam,
        "Re-apply after restore must strip restored -dx11 and leave only -dx12",
      );
      assert.ok(!String(current).includes("-dx11"), "stale -dx11 must not linger after post-restore Re-apply");

      // Also verify restoring an explicit empty applied_launch ({ flags: [], extraOverrides: [] })
      // clears applied_launch pref cleanly after Steam accepts the launch options.
      const cleanSteam = 'WINEDLLOVERRIDES="dxgi=n,b" %command%';
      fixtures.rollback_install = () => ({
        ok: true,
        launch_options: cleanSteam,
        applied_launch: { flags: [], extraOverrides: [] },
        launch_pending: true,
      });
      shownModals.length = 0;
      await click(view.host, "Restore previous install");
      await waitFor(() => shownModals.length === 1, "empty applied_launch Restore ConfirmModal");
      await respondModal("ok");
      await waitFor(() => current === cleanSteam && !prefValues.has(`applied_launch:${rpApp}`), "empty applied_launch cleared");
      assert.equal(prefValues.has(`applied_launch:${rpApp}`), false, "explicit empty applied_launch must clear pref");

      await view.unmount();
    } finally {
      fixtures.get_auto_plan = prevPlan;
      fixtures.set_pref = prevSetPref;
      fixtures.create_restore_point = prevCreateRp;
      fixtures.auto_install = prevAutoInstall;
      fixtures.rollback_install = prevRollback;
    }
  }
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
    warnings.forEach((warning) => console.error(`  warn: ${warning}`));
    process.exitCode = 1;
  }
})();
