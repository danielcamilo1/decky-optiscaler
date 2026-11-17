import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import assert from "node:assert/strict";
import { fixtures, invocations } from "@decky/api";
import { useConfig } from "../src/hooks/useConfig";
import {
  beginTargetLiveStatusRequest,
  clearTargetAfterSteamRestart,
  getTargetLiveRecord,
  rememberTargetForAppId,
  setTargetLiveRecord,
} from "../src/config/liveRecord";
import { getTargetConfigQueue } from "../src/config/writeRecord";
import type { ConfigResult, ConfigValues, OptionMeta, WriteConfigResult } from "../src/types";

type Hook = ReturnType<typeof useConfig>;
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
const targetPrefix = "/games/use-config-harness";
const disk = new Map<string, ConfigValues>();
const builds = new Map<string, string>();
const probes = new Map<string, Hook>();
const roots: { root: Root; host: HTMLElement; name: string; mounted: boolean }[] = [];
const failures: string[] = [];
const warnings: string[] = [];
let readBackend: (dir: string) => ConfigResult | Promise<ConfigResult>;
let writeBackend: (dir: string, changes: { section: string; key: string; value: string }[]) =>
  WriteConfigResult | Promise<WriteConfigResult>;

const enabledOption = { section: "FrameGen", key: "Enabled" } as OptionMeta;
const updateOption = { section: "FSR", key: "Fsr4Update" } as OptionMeta;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const freshValues = (): ConfigValues => ({ FrameGen: { Enabled: "true" }, FSR: { Fsr4Update: "false" } });
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function readResult(dir: string, values = disk.get(dir) ?? freshValues()): ConfigResult {
  return { ok: true, values: clone(values), runtime_current: true, fsr4_build: builds.get(dir) ?? "bundled" };
}
function applyChanges(dir: string, changes: { section: string; key: string; value: string }[]) {
  const values = clone(disk.get(dir) ?? freshValues());
  for (const change of changes) {
    values[change.section] = { ...(values[change.section] ?? {}), [change.key]: change.value };
  }
  disk.set(dir, values);
}
readBackend = (dir) => readResult(dir);
writeBackend = (dir, changes) => {
  applyChanges(dir, changes);
  return { ok: true, applied: clone(changes), live: { sent: true, directory_generation: "1", deferred: [] } };
};
Object.assign(fixtures, {
  read_config: (dir: string) => readBackend(dir),
  write_config: (dir: string, changes: { section: string; key: string; value: string }[]) =>
    writeBackend(dir, changes),
  create_restore_point: { ok: true, available: true },
  set_fsr4_build: (dir: string, build: string) => {
    builds.set(dir, build);
    return { ok: true };
  },
});
function Probe({ name, dir, gamePath, appid }: {
  name: string; dir: string; gamePath?: string; appid?: string | null;
}) {
  const hook = useConfig(dir, true, undefined, name, gamePath ? { gamePath, appid: appid ?? null } : undefined);
  probes.set(name, hook);
  return null;
}
async function mount(name: string, dir: string, gamePath?: string, appid?: string | null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const entry = { root, host, name, mounted: true };
  roots.push(entry);
  await act(async () => { root.render(<Probe name={name} dir={dir} gamePath={gamePath} appid={appid} />); });
  return {
    get hook() { return probes.get(name)!; },
    async unmount() {
      if (!entry.mounted) return;
      await act(async () => { root.unmount(); });
      entry.mounted = false;
      probes.delete(name);
      host.remove();
    },
  };
}
async function pump() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function waitFor(predicate: () => boolean, description: string) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await pump();
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function ready(name: string, dir: string) {
  const probe = await mount(name, dir);
  await waitFor(() => probe.hook.runtimeCurrent === true && !probe.hook.loading, `${name} initial config read`);
  return probe;
}

async function allRootsDown() {
  for (const entry of [...roots].reverse()) {
    if (!entry.mounted) continue;
    try {
      await act(async () => { entry.root.unmount(); });
      entry.mounted = false;
      entry.host.remove();
      probes.delete(entry.name);
    } catch (error) {
      failures.push(`root cleanup: ${String(error)}`);
    }
  }
}

async function run() {
  const base = freshValues();
  const dir1 = `${targetPrefix}/shared-initial`;
  disk.set(dir1, base);
  let firstRead = deferred<ConfigResult>();
  let secondRead = deferred<ConfigResult>();
  let reads = 0;
  readBackend = (dir) => ++reads === 1 ? firstRead.promise : secondRead.promise;
  const first = await mount("initial-a", dir1);
  const second = await mount("initial-b", dir1);
  assert.equal(reads, 2, "both hooks should issue an initial read");
  await act(async () => { firstRead.resolve(readResult(dir1)); secondRead.resolve(readResult(dir1)); });
  await waitFor(() => first.hook.runtimeCurrent === true && second.hook.runtimeCurrent === true, "both shared initial reads");
  assert.equal(first.hook.values.FrameGen?.Enabled, "true");
  assert.equal(second.hook.values.FrameGen?.Enabled, "true");
  await first.unmount();
  await second.unmount();

  const dir2 = `${targetPrefix}/shared-flush`;
  disk.set(dir2, freshValues());
  readBackend = (dir) => readResult(dir);
  const writer = await ready("writer-a", dir2);
  const flusher = await ready("flusher-b", dir2);
  const write = deferred<WriteConfigResult>();
  let writeStarted = 0;
  writeBackend = (dir, changes) => {
    writeStarted += 1;
    return write.promise.then((result) => { if (result.ok) applyChanges(dir, changes); return result; });
  };
  await act(async () => { writer.hook.setOption(enabledOption, "false"); });
  let flushSettled = false;
  let sharedFlush!: Promise<void>;
  await act(async () => {
    sharedFlush = flusher.hook.flush().then(() => { flushSettled = true; }, (error) => { flushSettled = true; throw error; });
    await Promise.resolve();
  });
  await waitFor(() => writeStarted === 1, "the shared pending write");
  assert.equal(flushSettled, false, "the foreground flush must wait for the other hook's write");
  await act(async () => { write.resolve({ ok: true, live: { sent: true, directory_generation: "1", deferred: [] } }); await sharedFlush; });
  assert.equal(disk.get(dir2)?.FrameGen?.Enabled, "false", "flush must commit the other hook's pending value");
  await act(async () => { await flusher.hook.authoritativeReload(); });
  assert.equal(flusher.hook.values.FrameGen?.Enabled, "false", "the action's authoritative reload must show that value");
  await writer.unmount();
  await flusher.unmount();

  const dir3 = `${targetPrefix}/failed-write`;
  disk.set(dir3, freshValues());
  readBackend = (dir) => readResult(dir);
  const retry = await ready("failed-write", dir3);
  const failedWrite = deferred<WriteConfigResult>();
  let failedStarted = false;
  writeBackend = () => { failedStarted = true; return failedWrite.promise; };
  let failure!: Promise<string | null>;
  await act(async () => {
    retry.hook.setOption(enabledOption, "false");
    failure = retry.hook.flush().then(() => null, (error) => String(error));
    await Promise.resolve();
  });
  await waitFor(() => failedStarted, "the delayed failing write");
  let failureMessage: string | null = null;
  await act(async () => { failedWrite.resolve({ ok: false, error: "disk write failed" }); failureMessage = await failure; });
  assert.match(failureMessage ?? "", /disk write failed/);
  assert.equal(retry.hook.values.FrameGen?.Enabled, "true", "failed edits must roll back to disk");
  assert.equal(retry.hook.runtimeCurrent, true);
  await act(async () => { await retry.hook.flush(); });
  writeBackend = (dir, changes) => { applyChanges(dir, changes); return { ok: true }; };
  await act(async () => { retry.hook.setOption(updateOption, "true"); await retry.hook.flush(); });
  assert.equal(disk.get(dir3)?.FSR?.Fsr4Update, "true", "a later flush should proceed without re-editing the failed key");
  await retry.unmount();

  const dir4 = `${targetPrefix}/authoritative-read`;
  disk.set(dir4, freshValues());
  let oldRead = deferred<ConfigResult>();
  let authoritativeRead = deferred<ConfigResult>();
  reads = 0;
  readBackend = (dir) => ++reads === 1 ? oldRead.promise : authoritativeRead.promise;
  const stale = await mount("stale-read", dir4);
  let reload!: Promise<void>;
  await act(async () => { reload = stale.hook.authoritativeReload(); await Promise.resolve(); });
  await waitFor(() => reads === 2, "the authoritative config read");
  const authoritative = freshValues();
  authoritative.FrameGen.Enabled = "false";
  await act(async () => { authoritativeRead.resolve(readResult(dir4, authoritative)); await reload; });
  await act(async () => { oldRead.resolve(readResult(dir4, freshValues())); });
  await pump();
  assert.equal(stale.hook.values.FrameGen?.Enabled, "false", "an older read must not replace authoritative data");
  await stale.unmount();

  async function mutationDuringInitialRead(label: string, rejectOldRead: boolean) {
    const dir = `${targetPrefix}/${label}`;
    disk.set(dir, freshValues());
    let count = 0;
    const old = deferred<ConfigResult>();
    readBackend = (requestedDir) => ++count === 2 ? old.promise : readResult(requestedDir);
    const a = await ready(`${label}-writer`, dir);
    const b = await mount(`${label}-reader`, dir);
    assert.equal(count, 2, "second hook should hold its first read");
    const delayedWrite = deferred<WriteConfigResult>();
    let started = false;
    writeBackend = (requestedDir, changes) => {
      started = true;
      return delayedWrite.promise.then((result) => { if (result.ok) applyChanges(requestedDir, changes); return result; });
    };
    let writing!: Promise<void>;
    await act(async () => { a.hook.setOption(enabledOption, "false"); writing = a.hook.flush(); await Promise.resolve(); });
    await waitFor(() => started, "the foreground write during the held read");
    await act(async () => { delayedWrite.resolve({ ok: true, live: { sent: true, directory_generation: "1", deferred: [] } }); await writing; });
    if (rejectOldRead) {
      await act(async () => { old.reject(new Error("read completed against the old target")); });
    } else {
      await act(async () => { old.resolve(readResult(dir, freshValues())); });
    }
    await waitFor(() => b.hook.runtimeCurrent === true && !b.hook.loading, `${label} reader retry`);
    assert.equal(count, 3, "a mutation-stale initial read should be retried");
    assert.equal(b.hook.values.FrameGen?.Enabled, "false", "the retry should show the completed write");
    await a.unmount();
    await b.unmount();
  }
  await mutationDuringInitialRead("write-over-held-read", false);
  await mutationDuringInitialRead("rejected-stale-read", true);

  const dir7 = `${targetPrefix}/unmount-failure`;
  disk.set(dir7, freshValues());
  let closeReads = 0;
  readBackend = (dir) => { closeReads += 1; return readResult(dir); };
  const closing = await ready("closing", dir7);
  const closeWrite = deferred<WriteConfigResult>();
  let closeStarted = false;
  writeBackend = () => { closeStarted = true; return closeWrite.promise; };
  await act(async () => { closing.hook.setOption(enabledOption, "false"); });
  await closing.unmount();
  await waitFor(() => closeStarted, "unmount-triggered write");
  await act(async () => { closeWrite.resolve({ ok: false, error: "closed-panel write failed" }); });
  await waitFor(() => closeReads >= 2 && getTargetConfigQueue(dir7).drain === null, "failed unmount write settlement");
  const reopened = await ready("reopened", dir7);
  assert.equal(reopened.hook.values.FrameGen?.Enabled, "true", "reopening must not resurrect a failed optimistic value");
  await reopened.unmount();

  const sessionTarget = `${targetPrefix}/verified-session-change`;
  setTargetLiveRecord(sessionTarget, {
    restartKeys: ["FrameGen.Enabled"],
    livePending: [{
      target: sessionTarget, session: "session-a", seq: "7", statusEpoch: 9,
      keys: ["FrameGen.Enabled"], values: { "FrameGen.Enabled": "true" },
      revisions: { "FrameGen.Enabled": 3 },
      contexts: { "FrameGen.Enabled": {
        target: sessionTarget, session: "session-a", active_api: "dx12", capability_generation: "gen-a",
      } },
    }],
    live: {
      sent: true, confirmed: false, ack: "pending", session: "session-a", seq: "7",
      sent_keys: ["FrameGen.Enabled"],
    },
    persistedValues: { "FrameGen.Enabled": "true" },
    persistedRevisions: { "FrameGen.Enabled": 3 },
    statusEpoch: 0,
  });
  readBackend = (dir) => readResult(dir);
  const sessionProbe = await ready("session-a-probe", sessionTarget);
  const oldPollEpoch = beginTargetLiveStatusRequest(sessionTarget);
  const nextPollEpoch = beginTargetLiveStatusRequest(sessionTarget);
  const liveStatus = (session: string, state = "ready") => ({
    asi_installed: true, supported: true, schema: 7, ready: state === "ready",
    attached: true, asi_current: true, dir_matches: true, dir_verified: true,
    state, session, capability_generation: `gen-${session}`,
    active_api: "dx12", seq: "7", ack: "pending", accepted_keys: [], failed_keys: [],
  }) as any;
  await act(async () => sessionProbe.hook.reconcileLiveStatus(liveStatus("session-b"), nextPollEpoch));
  assert.equal(getTargetLiveRecord(sessionTarget).restartKeys.includes("FrameGen.Enabled"), true,
    "a different status session alone does not clear restart state");
  assert.equal(getTargetLiveRecord(sessionTarget).live?.session, "session-a",
    "the prior receipt remains until Steam reports a start");
  rememberTargetForAppId(sessionTarget, "4242");
  await act(async () => clearTargetAfterSteamRestart("4242"));
  const afterSteamStart = getTargetLiveRecord(sessionTarget);
  assert.deepEqual(afterSteamStart.restartKeys, [], "Steam start clears restart keys");
  assert.equal(afterSteamStart.livePending.length, 0, "Steam start clears pending requests");
  assert.equal(afterSteamStart.live, null, "Steam start clears the old receipt");
  await act(async () => sessionProbe.hook.reconcileLiveStatus(liveStatus("session-a"), oldPollEpoch));
  assert.equal(getTargetLiveRecord(sessionTarget).live, null, "a pre-start status reply cannot restore a cleared receipt");
  await sessionProbe.unmount();

  const dir8 = `${targetPrefix}/fsr4-preserve`;
  disk.set(dir8, freshValues());
  builds.set(dir8, "bundled");
  setTargetLiveRecord(dir8, {
    restartKeys: ["FrameGen.Enabled"], livePending: [],
    live: { sent: true, confirmed: false, ack: "pending", session: "old-session", seq: "1" },
    persistedValues: {}, persistedRevisions: {},
  });
  readBackend = (dir) => readResult(dir);
  const previousSteam = (globalThis as any).SteamClient;
  const launchOptions = 'gamescope --mangoapp %command% WINEDLLOVERRIDES="custom=n,b"';
  (globalThis as any).SteamClient = {
    Apps: { GetAppLaunchOptions: async (appid: number) => appid === 42 ? launchOptions : "" },
  };
  try {
    const invocationStart = invocations.length;
    const fsr4 = await mount("basic-fsr4", dir8, "/games/Test Game", "42");
    await waitFor(() => fsr4.hook.runtimeCurrent === true, "FSR4 hook read");
    await act(async () => { await fsr4.hook.enableFsr4(); });
    const calls = invocations.slice(invocationStart);
    const snapshot = calls.find((call) => call.name === "create_restore_point");
    const buildCall = calls.find((call) => call.name === "set_fsr4_build");
    assert.ok(snapshot && buildCall && calls.indexOf(snapshot) < calls.indexOf(buildCall), "Basic FSR4 must snapshot before replacing files");
    assert.equal(buildCall.args[1], "4.1.2-lite-exact-20261105", "Basic selects the pinned latest community build");
    assert.equal(snapshot.args[2], launchOptions, "the snapshot must receive Steam's current launch string");
    assert.deepEqual(getTargetLiveRecord(dir8).restartKeys, [], "a stopped-game FSR change leaves no restart warning");
    assert.equal(getTargetLiveRecord(dir8).live, null, "a stopped-game FSR change clears its old live receipt");
    await fsr4.unmount();
  } finally {
    (globalThis as any).SteamClient = previousSteam;
  }
}

const oldWarn = console.warn;
const oldError = console.error;
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); oldWarn(...args); };
console.error = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); oldError(...args); };

void (async () => {
  try {
    await run();
    console.log("useConfig harness scenarios passed");
  } catch (error) {
    failures.push(error instanceof Error ? error.stack ?? String(error) : String(error));
  } finally {
    await allRootsDown();
    console.warn = oldWarn;
    console.error = oldError;
  }
  if (failures.length || warnings.length) {
    console.error(`useConfig harness failed (${failures.length} assertion/cleanup failures, ${warnings.length} React warnings)`);
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exitCode = 1;
  }
})();
