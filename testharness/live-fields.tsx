/**
 * The Quick Access panel's live controls, against a backend that behaves like
 * the real one: read_config returns a *copy* of the ini, write_config applies
 * the changes to it the way the Python writer does (rejecting anything the
 * schema will not take), and the live status is re-polled with a fresh object
 * every time.
 *
 * The thing under test is that a control shows what was picked. A dropdown
 * whose value is derived from the ini has to agree with the choice the moment
 * it is made, keep agreeing across a live-status poll, and still agree after
 * the debounced write has come back.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { fixtures, invocations } from "@decky/api";
import { GENERATED_OPTIONS } from "../src/config/generatedSchema";
import { Fsr4Panel } from "../src/components/Fsr4Panel";
import { BasicPanel } from "../src/components/BasicPanel";
import { ConfigTab } from "../src/components/ConfigTab";
import { LiveOutcome } from "../src/components/LiveOutcome";
import { LivePanel } from "../src/components/LivePanel";
import { LiveStats } from "../src/components/LiveStats";
import { QuickPanel } from "../src/components/QuickPanel";
import { liveFfxVersionChoices, liveStatusMessage } from "../src/liveControl";
import { beginTargetFlush, finishTargetFlush, forgetWrites, getTargetConfigQueue, waitForTargetWrites } from "../src/config/writeRecord";
import { getTargetLiveRecord, setTargetLiveRecord } from "../src/config/liveRecord";
import { useConfig } from "../src/hooks/useConfig";

// ---- a backend that keeps state -------------------------------------------
const ini: Record<string, Record<string, string>> = {};
for (const o of GENERATED_OPTIONS) {
  ini[o.section] = ini[o.section] ?? {};
  ini[o.section][o.key] = "auto";
}
ini.FrameGen.Enabled = "true";
ini.FrameGen.FGInput = "fsrfg";
ini.FrameGen.FGOutput = "fsrfg";
ini.Upscalers.Dx12Upscaler = "fsr31";
ini.FSR.Fsr4Update = "false";

const SCHEMA = new Map(GENERATED_OPTIONS.map((o) => [`${o.section}.${o.key}`, o]));

/** The same check py_modules/optiscaler/schema.py:valid() makes. */
function accepts(section: string, key: string, value: string) {
  const meta: any = SCHEMA.get(`${section}.${key}`);
  if (!meta || value === "auto") return true;
  // schema.INDEX_RANGES: the reference ini names the FFX generators and FSR
  // versions the reference build had, but both lists are per-game, so these are
  // indexes rather than the closed enums the ini makes them look like.
  if (section === "FSR" && (key === "FGIndex" || key === "UpscalerIndex")) {
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index <= 15;
  }
  if (meta.type === "bool") return ["true", "false"].includes(value.toLowerCase());
  if (meta.type === "enum") return !meta.options?.length || meta.options.includes(value);
  if (meta.type === "int" || meta.type === "float") return Number.isFinite(Number(value));
  return true;
}

/** The two device stories this harness needs: the Deck the INT8 route is for,
 *  and a card OptiScaler's own GPU checks already cover. Neither is fixed
 *  inside a test — the FSR version section plays both in turn. */
const DECK_GPU = {
  name: "Van Gogh (Steam Deck)", vendor: "amd", generation: "RDNA2",
  fsr4: "experimental" as const,
};
const RDNA4_GPU = {
  name: "Radeon RX 9070 XT", vendor: "amd", generation: "RDNA4", fsr4: "native" as const,
};

const detail = {
  path: "/games/Cyberpunk 2077",
  name: "Cyberpunk 2077",
  target: "/games/Cyberpunk 2077/bin/x64",
  install: {
    path: "/games/Cyberpunk 2077/bin/x64",
    installed: true, filename: "dxgi.dll", managed: true, version: "0.9.4",
    ini_present: true, directory_generation: "1", log_present: true, candidates: ["dxgi.dll"], extra_proxies: [],
    runtime_current: true,
    backed_up: [],
    // The library the shipped OptiScaler release actually carries, which is a
    // later version than the reference ini it documents itself with.
    fsr4: {
      files: {}, ready: false, required: [],
      ffx: { present: true, directory_generation: "1", name: "amd_fidelityfx_upscaler_dx12.dll",
             version: "4.1.1.2740", fsr4_capable: true },
    },
  },
  gpu: DECK_GPU,
  wiki_entry: null,
};

function ConfigProbe({
  target,
  onReady,
}: Readonly<{
  target: string;
  onReady: (actions: {
    authoritativeReload: () => Promise<void>;
    reconcileLiveStatus: (status: any, epoch: number | null) => void;
  }) => void;
}>) {
  const config = useConfig(target, true, undefined, `probe:${target}`);
  React.useEffect(() => onReady({
    authoritativeReload: config.authoritativeReload,
    reconcileLiveStatus: config.reconcileLiveStatus,
  }), [config.authoritativeReload, config.reconcileLiveStatus, onReady]);
  return null;
}

// Three generators, which is one more than the shipped ini documents — the
// running game is the authority on this list and a real one can be longer.
const FFX_VERSIONS: string[] = ["4.0.0", "3.1.6", "3.1.4"];
const DEFAULT_FFX_VERSIONS = [...FFX_VERSIONS];
// The same again for the FSR versions the FidelityFX runtime reports, one
// longer than the ini's three, and with the trailing marker the SDK's own name
// carries — OptiScaler prints those names verbatim and so does this.
const FSR_VERSIONS: string[] = ["4.1.1 *", "4.0.2", "3.1.5", "2.3.4"];
const FSR_IDS = ["ffx-id-0", "ffx-id-1", "ffx-id-2", "ffx-id-3"];
const LIVE_FIELD_IDS = [
  "FrameGen.Enabled",
  "OptiFG.HUDFix",
  "FrameGen.DebugView",
  "OptiFG.MakeDepthCopy",
  "OptiFG.HUDFixExtended",
  "XeFG.InterpolationCount",
  "FSR.FGIndex",
  "FSR.UpscalerIndex",
  "Upscalers.Dx11Upscaler",
  "Upscalers.Dx12Upscaler",
  "Upscalers.VulkanUpscaler",
  "Sharpness.OverrideSharpness",
  "Sharpness.Sharpness",
  "Menu.ShowFps",
];
const DYNAMIC_LIVE_FIELD_IDS = new Set([
  "FSR.FGIndex", "FSR.UpscalerIndex",
  "Upscalers.Dx11Upscaler", "Upscalers.Dx12Upscaler", "Upscalers.VulkanUpscaler",
]);
const LIVE_CAPABILITIES = Object.fromEntries([
  "set_scalar",
  "switch_upscaler",
  "change_fg_index",
  "change_ffx_upscaler",
  "reset_auto",
  "fg_scalar",
  "fg_enable",
  "fsr_debug_view",
  "change_xefg_count",
  ...LIVE_FIELD_IDS,
].map((key) => [key, true]));
let liveSession = "test-session";
let liveSequence = "1";
let liveAck: string = "config_request_accepted";
let liveActiveApi: "dx11" | "dx12" | "vulkan" = "dx12";
let liveGeneration = "generation-a";
let requestContext = { session: liveSession, active_api: liveActiveApi as string, capability_generation: liveGeneration };
const captureRequest = () => { requestContext = { session: liveSession, active_api: liveActiveApi, capability_generation: liveGeneration }; };
let liveStatusState = "ready";
let liveStatusReady = true;
let liveStatusSupported = true;
let liveCanEnableFg = true;
let liveConfirmedKeys: string[] = [];
let liveFailedKeys: string[] = [];
let liveFgIndex = 0;
let liveUpscalerIndex = 0;
let liveConfiguredFgIndex = 0;
let liveConfiguredUpscalerIndex = 1;
let liveConfiguredBackend = "xess";
let liveBackend = "fsr31";
let liveFgEnabled = true;
let liveConfiguredFgEnabled: boolean | null = true;
let liveBaseFps: number | null = 20.2;
let liveTotalFps: number | null = 40.4;
let liveCountedFps: number | null = 40.4;
let liveTelemetryReady = true;
let liveTelemetrySource: "state_present_counter" | "core_intervals" | "unknown" = "state_present_counter";
let livePresentPathFps: number | null = null;

function makeLiveStatus(target: string) {
  return {
    supported: liveStatusSupported,
    can_install: false, legacy_running: false,
    asi_installed: true, asi_available: true, asi_current: true,
    attached: true, ready: liveStatusReady, state: liveStatusState,
    load_enabled: true, loaded_by_optiscaler: true, error: null, seq: liveSequence,
    session: liveSession, ack: liveAck, active_api: liveActiveApi,
    capability_generation: liveGeneration, dir_matches: true, dir_verified: true,
    request_session: requestContext.session, request_api: requestContext.active_api,
    request_generation: requestContext.capability_generation,
    directory_generation: "1", wine_prefix: "Z:\\prefix", dir: target,
    accepted_keys: [...liveConfirmedKeys], failed_keys: [...liveFailedKeys],
    capabilities: LIVE_CAPABILITIES,
    switchable_backends: ["xess", "xess_12", "fsr21", "fsr21_12", "fsr22", "fsr22_12", "fsr31", "fsr31_12", "dlss"],
    can_override_sharpness: true,
    can_switch_upscaler: true, can_change_fg: true, can_enable_fg: liveCanEnableFg,
    can_change_ffx_upscaler: true,
    can_change_fg_version: LIVE_CAPABILITIES.change_fg_index,
    can_change_xefg_count: LIVE_CAPABILITIES.change_xefg_count,
    can_change_opti_fg: LIVE_CAPABILITIES.can_change_opti_fg,
    can_change_hud_fix: LIVE_CAPABILITIES.can_change_hud_fix,
    can_change_fsr_debug_view: LIVE_CAPABILITIES.fsr_debug_view,
    age: 1.0,
    live_keys: LIVE_FIELD_IDS,
    fps: liveCountedFps, base_fps: liveBaseFps, total_fps: liveTotalFps,
    rendered_ms: 49.5, presented_ms: 24.8,
    telemetry_ready: liveTelemetryReady, telemetry_source: liveTelemetrySource,
    present_path_fps: livePresentPathFps,
    fg_enabled: liveFgEnabled, configured_fg_enabled: liveConfiguredFgEnabled,
    frames: 12000, backend_entries: 1,
    upscaler: {
      dx12: liveActiveApi === "dx12" ? liveBackend : null,
      dx11: liveActiveApi === "dx11" ? liveBackend : null,
      vulkan: liveActiveApi === "vulkan" ? liveBackend : null,
    },
    pending_backend: null, schema: 7, fg_index: liveFgIndex,
    configured_fg_index: liveConfiguredFgIndex,
    configured_ffx_upscaler_index: liveConfiguredUpscalerIndex,
    configured_upscaler: {
      dx12: liveConfiguredBackend, dx11: liveConfiguredBackend, vulkan: liveConfiguredBackend,
    },
    ffx_fg_versions: FFX_VERSIONS,
    ffx_upscaler_versions: FSR_VERSIONS, ffx_upscaler_ids: FSR_IDS,
    ffx_upscaler_index: liveUpscalerIndex,
  };
}

function liveWriteResult(target: string, changes: any[]) {
  const context = {
    target,
    session: liveSession,
    active_api: liveActiveApi,
    capability_generation: liveGeneration,
  };
  const liveChanges = changes.filter((change) => {
    if (!liveStatusSupported || !liveStatusReady) return false;
    const id = `${change.section}.${change.key}`;
    if (!LIVE_FIELD_IDS.includes(id) || LIVE_CAPABILITIES[id] !== true) return false;
    if (id === "FrameGen.Enabled" && String(change.value).toLowerCase() === "true" && !liveCanEnableFg) {
      return false;
    }
    if (!DYNAMIC_LIVE_FIELD_IDS.has(id)) return true;
    const selected = change.live_context;
    return selected?.target === context.target && selected.session === context.session &&
      selected.active_api === context.active_api &&
      selected.capability_generation === context.capability_generation;
  });
  const keys = liveChanges.map((change) => `${change.section}.${change.key}`);
  const deferred = changes
    .filter((change) => LIVE_FIELD_IDS.includes(`${change.section}.${change.key}`) &&
      !liveChanges.includes(change))
    .map((change) => `${change.section}.${change.key}`);
  if (keys.length === 0) {
    return {
      sent: false, confirmed: false, ack: null, session: null, seq: null,
      applied: [], accepted_keys: [], sent_keys: [], context: null, failed_keys: [], deferred,
    };
  }
  liveSequence = String(BigInt(liveSequence) + 1n);
  captureRequest();
  liveAck = "config_request_accepted";
  liveStatusState = "ready";
  liveConfirmedKeys = keys;
  liveFailedKeys = [];
  return {
    sent: true, directory_generation: "1", confirmed: true, ack: "config_request_accepted", session: liveSession, seq: liveSequence,
    applied: keys, accepted_keys: keys, sent_keys: keys, context,
    failed_keys: [], deferred,
  };
}

let installedFsr4Build = "bundled";
let fsr4SetupFails = true;
Object.assign(fixtures, {
  create_restore_point: { ok: true, available: true },
  get_launch_options: { found: true, value: "", source: "test" },
  find_running_game: () => ({ found: true, appid: "1091500", detail }),
  get_auto_plan: { recommendation: { matched: false }, plan: { available: false } },
  get_pref: { key: "auto", value: null },
  set_fsr4_build: (_dir: string, build: string) => {
    if (fsr4SetupFails) return { ok: false, error: "Close the game before changing the FSR 4 build." };
    installedFsr4Build = build;
    setIni({ Upscalers: { Dx12Upscaler: "fsr31" },
      FSR: { Fsr4ForceEnableInt8: "1", Fsr4Update: build === "4.1.1b" ? "auto" : "true", UpscalerIndex: "0" } });
    return { ok: true };
  },
  read_config: () => ({
    fsr4_build: installedFsr4Build,
    ok: true, path: "/x/OptiScaler.ini",
    values: JSON.parse(JSON.stringify(ini)), modified: 1, runtime_current: true,
  }),
  write_config: (_dir: string, changes: any[]) => {
    const applied: any[] = [];
    const rejected: any[] = [];
    for (const c of changes) {
      const value = c.value === null || c.value === "" ? "auto" : String(c.value);
      if (!accepts(c.section, c.key, value)) {
        rejected.push({ ...c, value });
        continue;
      }
      ini[c.section] = ini[c.section] ?? {};
      ini[c.section][c.key] = value;
      applied.push({ section: c.section, key: c.key, value });
    }
    return { ok: true, applied, rejected, live: liveWriteResult(_dir, changes) };
  },
  get_live_status: (target: string) => makeLiveStatus(target),
  switch_upscaler: (dir: string, code: string, context: any) => {
    const key = context?.active_api === "dx11"
      ? "Dx11Upscaler"
      : context?.active_api === "vulkan"
        ? "VulkanUpscaler"
        : "Dx12Upscaler";
    const live = liveWriteResult(dir, [{ section: "Upscalers", key, value: code, live_context: context }]);
    if (live.sent) liveBackend = code;
    return { ok: true, backend: code, live };
  },
});

// ---- harness ---------------------------------------------------------------
const errors: string[] = [];
const originalError = console.error;
console.error = (...args: any[]) => {
  errors.push(args.map(String).join(" "));
  originalError(...args);
};

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "[ok]" : "[FAIL]"} ${label}${ok ? "" : ` — got ${actual}, want ${expected}`}`);
}

const attachedNotReady = makeLiveStatus(detail.install.path);
check("an explicit failed state is not reported as waiting for a frame",
  liveStatusMessage({ ...attachedNotReady, state: "failed", ready: false, error: "attach failed" }).code,
  "failed");
check("an explicit searching state stays a runtime check",
  liveStatusMessage({ ...attachedNotReady, state: "searching", ready: false }).code,
  "searching");
check("awaiting OptiScaler config has its own state",
  liveStatusMessage({ ...attachedNotReady, state: "awaiting_config", ready: false }).code,
  "awaiting-config");

async function settle(ms = 5) {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

/**
 * Rewrite the ini behind the plugin's back, as a fresh session would find it.
 *
 * The plugin remembers what it wrote so that reopening the panel does not read
 * a file the write has not reached yet, and that record outlives a render root.
 * Editing the fixture directly is the harness playing a different session, so
 * it has to drop the record too — otherwise the previous case's writes are
 * still, correctly, winning.
 */
function setIni(entries: Record<string, Record<string, string>>) {
  for (const [section, keys] of Object.entries(entries)) {
    ini[section] = { ...(ini[section] ?? {}), ...keys };
  }
  forgetWrites(detail.install.path);
  const queue = getTargetConfigQueue(detail.install.path);
  finishTargetFlush(queue, beginTargetFlush(queue, queue.revision, true));
}

/** The same trick for the device: which GPU is under the game decides whether
 *  an FSR 4 version is reachable through OptiScaler's own checks or only
 *  through the INT8 override, and the fixture is one object either way. */
function setGpu(gpu: typeof detail.gpu) {
  detail.gpu = gpu;
  forgetWrites(detail.install.path);
  const queue = getTargetConfigQueue(detail.install.path);
  finishTargetFlush(queue, beginTargetFlush(queue, queue.revision, true));
}

const all = (node: Element, selector: string) => Array.from(node.querySelectorAll(selector));
const control = (host: Element, label: string) =>
  all(host, `[data-mock][data-label="${label}"], [data-mock][data-label="${label} •"]`)[0];
const selected = (host: Element, label: string) =>
  control(host, label)?.getAttribute("data-selected");

/**
 * The value shown in one of the live tiles, found by the label above it.
 *
 * The tiles are plain markup rather than Steam controls, so there is no mock
 * marker to look for — a tile is a div whose first child is the label and whose
 * second is the number.
 */
const tile = (host: Element, label: string) => {
  for (const node of all(host, "div")) {
    const [head, body] = Array.from(node.children);
    if (head?.textContent === label && body) return body.textContent;
  }
  return null;
};

(async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QuickPanel
        runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
        onOpenManager={() => {}}
      />
    );
  });
  await settle();

  console.log("=== the upscaler dropdown ===");
  check("opens on what the ini says", selected(host, "Override upscaler with"), "fsr31");
  const upscaler = control(host, "Override upscaler with");
  await act(async () => {
    (all(upscaler, '[data-opt-value="xess"]')[0] as HTMLElement).click();
  });
  await settle();
  check("shows the pick straight away", selected(host, "Override upscaler with"), "xess");
  // Past the debounce, so the write has been made and answered.
  await settle(200);
  check("still shows it after the write", selected(host, "Override upscaler with"), "xess");
  check("the ini has it", ini.Upscalers.Dx12Upscaler, "xess");

  console.log("=== a new Quick Access save replaces the previous success ===");
  liveAck = "config_request_accepted";
  liveStatusState = "ready";
  liveConfirmedKeys = ["FrameGen.Enabled"];
  liveFailedKeys = [];
  setTargetLiveRecord(detail.install.path, {
    ...getTargetLiveRecord(detail.install.path),
    restartKeys: [],
    livePending: [],
    live: {
      sent: true, directory_generation: "1", confirmed: true, ack: "config_request_accepted", session: liveSession,
      seq: liveSequence, applied: ["FrameGen.Enabled"], accepted_keys: ["FrameGen.Enabled"],
      sent_keys: ["FrameGen.Enabled"],
      context: {
        target: detail.install.path,
        session: liveSession,
        active_api: liveActiveApi,
        capability_generation: liveGeneration,
      },
      failed_keys: [], deferred: [],
    },
  });
  await settle();
  check("the previous confirmed success is visible before another save",
    host.textContent?.includes("Sent to OptiScaler"), true);
  const regularWriter = fixtures.write_config;
  let finishSaving: () => void = () => {};
  fixtures.write_config = async (dir: string, changes: any[]) => {
    await new Promise<void>((resolve) => { finishSaving = resolve; });
    for (const change of changes) {
      ini[change.section] = ini[change.section] ?? {};
      ini[change.section][change.key] = String(change.value);
    }
    const seq = String(BigInt(liveSequence) + 1n);
    liveSequence = seq;
    captureRequest();
    liveAck = "pending";
    liveStatusState = "queued";
    liveConfirmedKeys = [];
    const sentKeys = changes.map((change) => `${change.section}.${change.key}`)
      .filter((id) => LIVE_FIELD_IDS.includes(id));
    return {
      ok: true, applied: changes, rejected: [],
      live: {
        sent: true, directory_generation: "1", confirmed: false, ack: "pending", session: liveSession, seq,
        applied: [], accepted_keys: [], sent_keys: sentKeys,
        context: {
          target: dir, session: liveSession, active_api: liveActiveApi,
          capability_generation: liveGeneration,
        },
        failed_keys: [], deferred: [],
      },
    };
  };
  const frameToggle = control(host, "Frame generation");
  await act(async () => { (all(frameToggle, "[data-toggle]")[0] as HTMLElement).click(); });
  await settle(10);
  check("saving status replaces the old applied banner",
    host.textContent?.includes("Saving settings") && !host.textContent?.includes("Sent to OptiScaler"), true);
  await act(async () => {
    finishSaving();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  await settle();
  fixtures.write_config = regularWriter;
  setIni({ FrameGen: { Enabled: "true" } });
  liveAck = "config_request_accepted";
  liveStatusState = "ready";
  liveConfirmedKeys = [];
  setTargetLiveRecord(detail.install.path, {
    restartKeys: [], livePending: [], live: null,
    persistedValues: {}, persistedRevisions: {},
  });
  await settle();

  const outcomeHost = document.createElement("div");
  document.body.appendChild(outcomeHost);
  const outcomeRoot = createRoot(outcomeHost);
  const lastConfirmed = {
    sent: true, directory_generation: "1",
    confirmed: true,
    ack: "config_request_accepted",
    session: liveSession,
    seq: liveSequence,
    applied: ["FrameGen.Enabled"],
    accepted_keys: ["FrameGen.Enabled"],
    sent_keys: ["FrameGen.Enabled"],
    context: {
      target: detail.install.path,
      session: liveSession,
      active_api: liveActiveApi,
      capability_generation: liveGeneration,
    },
    deferred: [],
    failed_keys: [],
  } as const;
  await act(async () => outcomeRoot.render(
    <LiveOutcome
      result={lastConfirmed}
      status={{ ...makeLiveStatus(detail.install.path), state: "disconnected", ready: false, ack: undefined, accepted_keys: [] }}
    />
  ));
  check("a failed status refresh never turns the previous ACK into a live success",
    outcomeHost.textContent?.includes("Sent to OptiScaler"), false);
  check("the missing status is named", outcomeHost.textContent?.includes("disconnected"), true);
  await act(async () => outcomeRoot.render(
    <LiveOutcome result={lastConfirmed} status={makeLiveStatus(detail.install.path)} saving />
  ));
  check("saving replaces a previous success in the shared outcome",
    outcomeHost.textContent?.includes("Saving settings") && !outcomeHost.textContent?.includes("Sent to OptiScaler"), true);
  await act(async () => outcomeRoot.render(
    <LiveOutcome result={lastConfirmed} status={{
      ...makeLiveStatus(detail.install.path), directory_generation: "2",
      ack: "rejected", accepted_keys: [],
    }} />
  ));
  check("reauthorization cannot revive the prior directory receipt",
    outcomeHost.textContent?.includes("authorization changed") &&
    !outcomeHost.textContent?.includes("Sent to OptiScaler"), true);
  await act(async () => outcomeRoot.unmount());
  outcomeHost.remove();

  // The preceding save changed FG. Bring the mounted control back on through
  // its public action before testing a generator choice.
  const enableFg = control(host, "Frame generation");
  if (all(enableFg, "[data-toggle]")[0]?.getAttribute("data-checked") !== "true") {
    await act(async () => { (all(enableFg, "[data-toggle]")[0] as HTMLElement).click(); });
    await settle(200);
  }
  console.log("=== the FFX FG version dropdown ===");
  const ffx = control(host, "FFX FG version");
  console.log(`  options: ${all(ffx, "[data-opt]").map((n) => n.textContent).join(", ")}`);
  await act(async () => {
    (all(ffx, '[data-opt-value="2"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("shows the third generator", selected(host, "FFX FG version"), "2");
  // The shipped ini documents two generators because that is what the
  // reference build offered; the running game is the authority on the list.
  check("and the ini records it", ini.FSR.FGIndex, "2");

  console.log("=== the FSR version dropdown ===");
  // The second half of the upscaler question. "fsr31" is every FSR from 2.3.4
  // to 4.1.1, so which one is running is a separate choice, and the running
  // game is the authority on what the choices are.
  const fsrVersion = control(host, "FSR version");
  check("the versions are the ones the game reports, named as OptiScaler names them",
    all(fsrVersion, "[data-opt]").map((n) => n.textContent).join(", "),
    "FSR 4.1.1 *, FSR 4.0.2, FSR 3.1.5, FSR 2.3.4");
  // Start from the FSR 3.X preset's position, where the FSR 4 upgrade path is
  // off -- asking for FSR 4 from here has to switch it back on, or OptiScaler
  // falls back to FSR 3 without saying so.
  setIni({ FSR: { Fsr4Update: "false" } });
  await act(async () => {
    (all(fsrVersion, '[data-opt-value="3"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("shows the version picked", selected(host, "FSR version"), "3");
  // The shipped ini documents three versions because that is what the
  // reference build offered; a fourth has to be writable all the same.
  check("and the ini records it past the end of the ini's own list",
    ini.FSR.UpscalerIndex, "3");
  check("an older version leaves the FSR 4 upgrade path alone",
    ini.FSR.Fsr4Update, "false");

  const toFsr4 = control(host, "FSR version");
  await act(async () => {
    (all(toFsr4, '[data-opt-value="0"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("asking for FSR 4 records the version", ini.FSR.UpscalerIndex, "0");
  // But not the upgrade path, on the device this plugin exists for: v0.9.4's
  // notes say setting it on an unsupported GPU forces FP8 and OptiScaler
  // answers with its internal FSR 3 fallback, and the maintainer's answer to
  // exactly this device on the tracker was that the INT8 override is the only
  // option it needs. Writing it here would be the bug, not the fix.
  check("and leaves the upgrade path alone where INT8 is the route",
    ini.FSR.Fsr4Update, "false");

  // On a device OptiScaler's own GPU checks cover, the same click has to write
  // it — that is what this section has always covered, and it still holds.
  setGpu(RDNA4_GPU);
  const onAmd = control(host, "FSR version");
  await act(async () => {
    (all(onAmd, '[data-opt-value="3"]')[0] as HTMLElement).click();
  });
  await settle(200);
  await act(async () => {
    (all(control(host, "FSR version"), '[data-opt-value="0"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("asking for FSR 4 on a supported GPU switches the upgrade path on",
    ini.FSR.Fsr4Update, "true");
  setGpu(DECK_GPU);

  console.log("=== the INT8 preset on that same Deck ===");
  // The other half of the device story: the preset the INT8 route needs,
  // recognised from the ini like any other, and the one control it must not
  // offer. The backend switch is live and the override is not — it is read while
  // the upscaler is created — so a switch under this preset would move the game
  // now and leave the thing that was asked for waiting for a restart.
  setIni({
    Upscalers: { Dx12Upscaler: "fsr31" },
    FSR: { Fsr4ForceEnableInt8: "1", Fsr4Update: "auto", UpscalerIndex: "0" },
  });
  // A backend the game is not on, so a switch would otherwise be on offer.
  liveBackend = "xess";
  const host5 = document.createElement("div");
  document.body.appendChild(host5);
  const root5 = createRoot(host5);
  await act(async () => {
    root5.render(
      <QuickPanel
        runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
        onOpenManager={() => {}}
      />
    );
  });
  await settle();
  check("the INT8 preset is the one recognised",
    selected(host5, "Override upscaler with"), "manual-int8");
  check("and the panel says the override waits for a launch",
    host5.textContent!.includes("Manual INT8 settings"), true);
  await act(async () => {
    (all(control(host5, "Override upscaler with"),
      '[data-opt-value="fsr4-int8"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("picking it offers no switch that cannot apply it",
    host5.textContent!.includes("Switch now"), false);
  check("a rejected setup reports the reason", host5.textContent!.includes("Close the game"), true);
  check("a rejected setup does not claim the patched build", selected(host5, "Override upscaler with"), "manual-int8");
  const fgBeforeSetup = JSON.stringify(ini.FrameGen);
  const previousLiveSession = liveSession;
  setTargetLiveRecord(detail.install.path, {
    ...getTargetLiveRecord(detail.install.path),
    live: {
      sent: true, directory_generation: "1", confirmed: false, ack: "timeout", session: "previous-int8-session",
      seq: "77", applied: [], accepted_keys: [], failed_keys: [], deferred: [],
    },
  });
  liveSession = "current-int8-session";
  fsr4SetupFails = false;
  await act(async () => {
    (all(control(host5, "Override upscaler with"), '[data-opt-value="fsr4-int8"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("successful setup selects the patched preset", selected(host5, "Override upscaler with"), "fsr4-int8");
  check("restart-only INT8 setup clears a stale live-session outcome",
    host5.textContent?.includes("previous game session"), false);
  check("setup leaves frame generation alone", JSON.stringify(ini.FrameGen), fgBeforeSetup);
  check("an installed INT8 build does not keep a next-launch notice", host5.textContent!.includes("ready for the next launch"), false);

  await act(async () => root5.unmount());
  liveSession = previousLiveSession;
  liveBackend = "fsr31";
  setIni({ FSR: { Fsr4ForceEnableInt8: "0", Fsr4Update: "false" } });
  await settle(200);

  console.log("=== a 4.0.2 upscaler in the folder ===");
  // The other half of the version question, and the reason the INT8 preset is
  // not offered blindly. A 4.0.2 build is below the 4.1.1 OptiScaler asks for
  // before it will offer FSR 4 off the override, so on the same Deck the upgrade
  // path is what reaches it — the opposite of what the same click does with the
  // released 4.1.1 SDK in the folder.
  installedFsr4Build = "bundled";
  detail.install.fsr4.ffx.version = "4.0.2.0";
  setIni({
    Upscalers: { Dx12Upscaler: "fsr31" },
    FSR: { Fsr4ForceEnableInt8: "0", Fsr4Update: "false", UpscalerIndex: "1" },
  });
  const host6 = document.createElement("div");
  document.body.appendChild(host6);
  const root6 = createRoot(host6);
  await act(async () => {
    root6.render(
      <QuickPanel
        runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
        onOpenManager={() => {}}
      />
    );
  });
  await settle();
  check("the Deck preset can replace an older DLL",
    all(control(host6, "Override upscaler with"), '[data-opt-value="fsr4-int8"]').length, 1);
  await act(async () => {
    (all(control(host6, "FSR version"), '[data-opt-value="0"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("and asking for FSR 4 writes the upgrade path instead",
    ini.FSR.Fsr4Update, "true");
  await act(async () => root6.unmount());
  detail.install.fsr4.ffx.version = "4.1.1.2740";
  setIni({ FSR: { Fsr4Update: "false", UpscalerIndex: "0" } });

  console.log("=== official 4.1.2 APU model selection ===");
  detail.install.fsr4.ffx.version = "4.1.2.0";
  installedFsr4Build = "bundled";
  setIni({
    Upscalers: { Dx12Upscaler: "fsr31" },
    FSR: { Fsr4ForceEnableInt8: "0", Fsr4Update: "true", UpscalerIndex: "0" },
  });
  const officialHost = document.createElement("div");
  document.body.appendChild(officialHost);
  const officialRoot = createRoot(officialHost);
  await act(async () => {
    officialRoot.render(<QuickPanel
      runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
      onOpenManager={() => {}}
    />);
  });
  await settle();
  check("explicit disabled INT8 is not labeled automatic model selection", selected(officialHost, "Override upscaler with") === "fsr4", false);
  await act(async () => {
    (all(control(officialHost, "Override upscaler with"), '[data-opt-value="fsr4"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("official FSR4 preset enables the SDK upgrade path", ini.FSR.Fsr4Update, "true");
  check("official FSR4 preset lets the runtime choose the APU model", ini.FSR.Fsr4ForceEnableInt8, "auto");
  check("official FSR4 preset keeps the bundled DLL", installedFsr4Build, "bundled");
  check("official SDK does not require the community preset", officialHost.textContent!.includes("install the RDNA2 build and enable INT8"), false);
  await act(async () => officialRoot.unmount());
  detail.install.fsr4.ffx.version = "4.1.1.2740";
  setIni({ FSR: { Fsr4Update: "false", UpscalerIndex: "0" } });

  console.log("=== the live tiles ===");
  // The backend id cannot say which FSR is running and OptiScaler's own name
  // for it — "FSR 3.X/4" — says so out loud. The version list can, and the game
  // is still on the one it built, not the one just written to the file.
  check("the upscaler tile names the exact version the game is running",
    tile(host, "upscaler"), "FSR 4.1.1 *");
  check("frame generation splits the frame rate in two",
    `${tile(host, "base fps")} / ${tile(host, "with fg")}`, "20 / 40");

  console.log("=== the frame multiplier ===");
  // Only the XeSS FG output can do more than 2X, so switch to it first.
  const method = control(host, "Method");
  await act(async () => {
    (all(method, '[data-opt-value="xefg"]')[0] as HTMLElement).click();
  });
  await settle(200);
  const mult = control(host, "Frame multiplier");
  check("the multiplier is usable on XeFG", mult?.getAttribute("data-disabled"), "null");
  await act(async () => {
    (all(mult, '[data-opt-value="3"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("shows 3X", selected(host, "Frame multiplier"), "3");

  console.log("=== the frame generation toggle ===");
  const fg = all(host, '[data-mock="ToggleField"][data-label="Frame generation"]')[0];
  await act(async () => {
    (all(fg, "[data-toggle]")[0] as HTMLElement).click();
  });
  await settle(200);
  const fgNow = all(host, '[data-mock="ToggleField"][data-label="Frame generation"]')[0];
  check("turns off", all(fgNow, "[data-toggle]")[0].getAttribute("data-checked"), "false");
  check("and the ini agrees", ini.FrameGen.Enabled, "false");

  console.log("=== an ini the presets have no name for ===");
  // The Advanced page and the wiki plan write the same file. A value with no
  // preset used to be displayed as "Auto", which is the opposite of the truth.
  setIni({
    Upscalers: { Dx12Upscaler: "fsr21" },
    FSR: { Fsr4Update: "auto" },
    FrameGen: { Enabled: "true", FGInput: "dlssg", FGOutput: "xefg" },
  });
  const host3 = document.createElement("div");
  document.body.appendChild(host3);
  const root3 = createRoot(host3);
  await act(async () => {
    root3.render(
      <QuickPanel
        runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
        onOpenManager={() => {}}
      />
    );
  });
  await settle();
  check("the upscaler is not passed off as Auto",
    selected(host3, "Override upscaler with"), "fsr21");
  const shown = (host: Element, label: string) => {
    const node = control(host, label);
    const value = node?.getAttribute("data-selected");
    return all(node!, `[data-opt-value="${value}"]`)[0]?.textContent;
  };
  console.log(`  and is named: ${shown(host3, "Override upscaler with")}`);
  check("the FG pair is not passed off as FSR FG",
    selected(host3, "Method"), "dlssg \u2192 xefg");
  console.log(`  and is named: ${shown(host3, "Method")}`);
  await act(async () => root3.unmount());

  console.log("=== a write the backend will not take ===");
  // A rejected write reaches neither the file nor the running game. The control
  // has to go back to what the file says and the panel has to say why — and the
  // re-read that does it must not blank the controls on the way past.
  setIni({
    Upscalers: { Dx12Upscaler: "fsr31" },
    FSR: { Fsr4Update: "false" },
    FrameGen: { Enabled: "true", FGInput: "fsrfg", FGOutput: "fsrfg" },
    XeFG: { InterpolationCount: "auto" },
  });
  const host4 = document.createElement("div");
  document.body.appendChild(host4);
  const root4 = createRoot(host4);
  await act(async () => {
    root4.render(
      <QuickPanel
        runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
        onOpenManager={() => {}}
      />
    );
  });
  await settle();
  // Nothing in the panel offers an unacceptable value, so one is forced in the
  // one place a real ini can also disagree with the schema: an out-of-range
  // FFX FG index, which is what the game reporting a shorter list looks like.
  let refused = true;
  fixtures.write_config = (_dir: string, changes: any[]) => {
    if (!refused) return { ok: true, applied: changes, rejected: [], live: liveWriteResult(_dir, changes) };
    return { ok: true, applied: [], rejected: changes, live: { sent: false, deferred: [] } };
  };
  const before = selected(host4, "Override upscaler with");
  const target = control(host4, "Override upscaler with");
  await act(async () => {
    (all(target, '[data-opt-value="xess"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("the panel stays up through the re-read",
    Boolean(control(host4, "Override upscaler with")), true);
  check("the control goes back to the file",
    selected(host4, "Override upscaler with"), before);
  check("and the refusal is reported",
    /would not accept/.test(host4.textContent ?? ""), true);

  // And once the backend accepts again, an edit sticks.
  refused = false;
  const retry = control(host4, "Override upscaler with");
  await act(async () => {
    (all(retry, '[data-opt-value="xess"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("a later edit sticks", selected(host4, "Override upscaler with"), "xess");
  await act(async () => root4.unmount());

  console.log("=== failed config RPCs restore the authoritative ini ===");
  setIni({ Upscalers: { Dx12Upscaler: "fsr31" } });
  const successfulWrite = fixtures.write_config;
  fixtures.write_config = () => ({ ok: false, error: "disk is read-only" });
  let failedPanel = await open();
  await act(async () => {
    (all(control(failedPanel.node, "Override upscaler with"), '[data-opt-value="xess"]')[0] as HTMLElement)
      .click();
  });
  await settle(80);
  check("an ok:false RPC rolls the control back to disk",
    selected(failedPanel.node, "Override upscaler with"), "fsr31");
  check("the full RPC failure is visible",
    failedPanel.node.textContent?.includes("disk is read-only"), true);
  await act(async () => failedPanel.root.unmount());
  failedPanel = await open();
  check("reopening does not resurrect the failed optimistic value",
    selected(failedPanel.node, "Override upscaler with"), "fsr31");
  await act(async () => failedPanel.root.unmount());

  fixtures.write_config = () => { throw new Error("Decky RPC disconnected"); };
  failedPanel = await open();
  await act(async () => {
    (all(control(failedPanel.node, "Override upscaler with"), '[data-opt-value="xess"]')[0] as HTMLElement)
      .click();
  });
  await settle(80);
  check("a rejected RPC promise also restores the file value",
    selected(failedPanel.node, "Override upscaler with"), "fsr31");
  check("a rejected RPC promise explains the failure",
    failedPanel.node.textContent?.includes("Decky RPC disconnected"), true);
  await act(async () => failedPanel.root.unmount());
  fixtures.write_config = successfulWrite;

  console.log("=== closing the panel while the write is in flight ===");
  // Closing the Quick Access panel unmounts everything, which is what you do to
  // look at the game after changing something. Reopening starts a read that can
  // be issued before the write has landed, and the panel then comes up showing
  // the value from before the change — one step behind, for ever.
  setIni({
    Upscalers: { Dx12Upscaler: "xess" },
    FSR: { Fsr4Update: "false" },
    FrameGen: { Enabled: "true", FGInput: "fsrfg", FGOutput: "fsrfg" },
  });
  setTargetLiveRecord(detail.install.path, {
    restartKeys: [], livePending: [], live: null,
    persistedValues: {}, persistedRevisions: {},
  });
  liveAck = "config_request_accepted";
  liveStatusState = "ready";
  liveConfirmedKeys = [];
  let delayedSequence: string | null = null;
  let releaseWrite: () => void = () => {};
  fixtures.write_config = async (_dir: string, changes: any[]) => {
    await new Promise<void>((r) => {
      releaseWrite = r;
    });
    for (const c of changes) {
      ini[c.section] = ini[c.section] ?? {};
      ini[c.section][c.key] = String(c.value);
    }
    const sent = liveWriteResult(_dir, changes);
    const keys = sent.sent_keys ?? [];
    delayedSequence = sent.seq ?? null;
    liveAck = "timeout";
    liveStatusState = "timeout";
    liveConfirmedKeys = [];
    return {
      ok: true, applied: changes, rejected: [],
      live: {
        sent: keys.length > 0, directory_generation: "1", confirmed: false, ack: "timeout",
        session: keys.length > 0 ? liveSession : null,
        seq: keys.length > 0 ? delayedSequence : null,
        sent_keys: keys,
        context: keys.length > 0 ? sent.context : null,
        applied: [], accepted_keys: [], failed_keys: [],
        deferred: changes.map((change) => `${change.section}.${change.key}`).filter((id) => !keys.includes(id)),
      },
    };
  };

  async function open() {
    const node = document.createElement("div");
    document.body.appendChild(node);
    const r = createRoot(node);
    await act(async () => {
      r.render(
        <QuickPanel
          runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
          onOpenManager={() => {}}
        />
      );
    });
    await settle();
    return { node, root: r };
  }

  let panel = await open();
  check("opens on XeSS", selected(panel.node, "Override upscaler with"), "xess");
  await act(async () => {
    (all(control(panel.node, "Override upscaler with"), '[data-opt-value="fsr4"]')[0] as HTMLElement)
      .click();
  });
  await settle();
  // Close it before the write has been answered, exactly as the panel closing
  // over a running game does.
  await act(async () => panel.root.unmount());
  panel = await open();
  check("reopening does not show the value from before the change",
    selected(panel.node, "Override upscaler with"), "fsr4");
  // Now let the write through and reopen once more: the file agrees, and the
  // record retires itself.
  await act(async () => {
    releaseWrite();
    await new Promise((r) => setTimeout(r, 5));
  });
  await settle();
  const persistedPending = getTargetLiveRecord(detail.install.path).livePending;
  const delayedKeys = persistedPending.flatMap((entry) => entry.keys);
  check("the unmounted panel keeps its timeout sequence in the shared target record",
    delayedKeys.includes("FSR.UpscalerIndex"), true);
  await act(async () => panel.root.unmount());
  liveAck = "config_request_accepted";
  liveStatusState = "ready";
  liveConfirmedKeys = delayedKeys;
  panel = await open();
  check("and still agrees once the write lands",
    selected(panel.node, "Override upscaler with"), "fsr4");
  check("the file has it", ini.Upscalers.Dx12Upscaler, "fsr31");
  check("a matching late ACK reconciles after the original hook was unmounted",
    getTargetLiveRecord(detail.install.path).livePending.length, 0);

  console.log("=== the FFX FG control on a game with one generator ===");
  FFX_VERSIONS.length = 0;
  FFX_VERSIONS.push("3.1.6");
  await act(async () => panel.root.unmount());
  panel = await open();
  const single = control(panel.node, "FFX FG version");
  check("the control is still there", Boolean(single), true);
  check("but there is nothing to pick", single?.getAttribute("data-disabled"), "true");
  await act(async () => panel.root.unmount());

  console.log("=== frame generation on, but not generating ===");
  // OptiScaler can have the setting on and not have engaged the generator --
  // it reports FSR-FG as off until the game selects frame generation in its
  // own options -- and the two rates then measure the same frames. Both are
  // still shown, because both were asked for; what stops two identical numbers
  // reading as a fault is the frame-generation tile saying why.
  liveBaseFps = 40.4;
  liveTotalFps = 40.4;
  panel = await open();
  check("both rates are still shown",
        `${tile(panel.node, "base fps")} / ${tile(panel.node, "with fg")}`, "40 / 40");
  // The tile reads "ON idle": still on, and saying why the two match.
  check("and the frame generation tile says the generator is not running",
        tile(panel.node, "frame gen"), "ON idle");
  await act(async () => panel.root.unmount());

  console.log("=== configured XeFG multiplier is not a runtime measurement ===");
  liveTelemetrySource = "state_present_counter";
  liveTelemetryReady = true;
  liveFgEnabled = true;
  liveBaseFps = 30;
  liveTotalFps = 60;
  liveCountedFps = 60;
  setIni({ FrameGen: { Enabled: "true", FGInput: "fsrfg", FGOutput: "xefg" }, XeFG: { InterpolationCount: "3" } });
  panel = await open();
  check("measured 2X rates are not labeled with the configured 4X multiplier",
    tile(panel.node, "frame gen")?.includes("4X"), false);
  check("measured rates remain visible", `${tile(panel.node, "base fps")} / ${tile(panel.node, "with fg")}`, "30 / 60");
  await act(async () => panel.root.unmount());

  // An in-game plugin older than this one reports no frame intervals at all,
  // and so does a generator that was created but has never presented: the
  // rendered slot stays at zero and the host withholds the derived rate. The
  // pair is what was asked for, so the second tile is still there saying it has
  // no reading -- a pair of counters that quietly becomes one counter is
  // indistinguishable from the feature never having shipped.
  liveBaseFps = null;
  liveTotalFps = null;
  liveCountedFps = 40.4;
  panel = await open();
  check("an unmeasured base rate still gets its tile",
        `${tile(panel.node, "base fps")} / ${tile(panel.node, "with fg")}`, "— / 40");
  check("and the frame generation tile says there is no reading",
        tile(panel.node, "frame gen"), "ON no reading");
  await act(async () => panel.root.unmount());

  // The frame counter does not always count the frames that reach the screen.
  // When it counts the rendered ones instead, the total is the derived number
  // and the raw count is the *base* -- showing the count as the total is what
  // put the rendered rate under a "with fg" label while the base stayed blank.
  liveBaseFps = 30.0;
  liveTotalFps = 60.0;
  liveCountedFps = 30.0;
  panel = await open();
  check("a counter on the rendered side does not become the total",
        `${tile(panel.node, "base fps")} / ${tile(panel.node, "with fg")}`, "30 / 60");
  await act(async () => panel.root.unmount());
  liveCountedFps = 40.4;

  // With frame generation off there is only ever one rate to show.
  liveFgEnabled = false;
  liveBaseFps = 20.2;
  liveTotalFps = 40.4;
  panel = await open();
  check("with frame generation off there is one rate",
        tile(panel.node, "fps"), "40");
  check("and no second tile", tile(panel.node, "base fps"), "null");
  await act(async () => panel.root.unmount());

  console.log("=== interval-only telemetry stays a present-path reading ===");
  FFX_VERSIONS.splice(0, FFX_VERSIONS.length, ...DEFAULT_FFX_VERSIONS);
  liveFgEnabled = true;
  liveConfiguredFgEnabled = false;
  liveCountedFps = 0;
  liveBaseFps = null;
  liveTotalFps = null;
  liveFgIndex = 0;
  liveConfiguredFgIndex = 2;
  liveUpscalerIndex = 1;
  liveConfiguredUpscalerIndex = 0;
  liveConfiguredBackend = "xess";
  liveTelemetryReady = true;
  liveTelemetrySource = "core_intervals";
  livePresentPathFps = 40.3;
  setIni({
    FrameGen: { Enabled: "true", FGInput: "xefg", FGOutput: "xefg" },
    XeFG: { InterpolationCount: "3" },
  });
  panel = await open();
  check("fresh core intervals show their present-path rate",
    tile(panel.node, "present path fps"), "40.3");
  check("interval-only data does not invent an FG base-rate tile",
    tile(panel.node, "base fps"), "null");
  check("interval-only data does not invent an FG total-rate tile",
    tile(panel.node, "with fg"), "null");
  check("the runtime FG object remains distinct from the saved setting",
    tile(panel.node, "frame gen"), "ON");
  check("interval-only telemetry does not label FG with the configured XeFG multiplier",
    tile(panel.node, "frame gen")?.includes("4X"), false);

  const statsHost = document.createElement("div");
  document.body.appendChild(statsHost);
  const statsRoot = createRoot(statsHost);
  await act(async () => statsRoot.render(<LiveStats live={makeLiveStatus(detail.install.path)} />));
  check("the detailed readout labels the interval-derived rate precisely",
    statsHost.textContent?.includes("Present path FPS40.3 fps"), true);
  check("the interval-derived rate is not presented as an FG total",
    statsHost.textContent?.includes("Frame rate, with FG40.3 fps"), false);
  check("the detailed readout separates runtime and configured FG states",
    statsHost.textContent?.includes("Frame generation activeon") &&
      statsHost.textContent?.includes("Frame generation configuredoff"), true);
  check("the actual FFX FG version comes from its observed runtime index",
    statsHost.textContent?.includes("FFX frame generatorFFX FG 4.0.0"), true);
  check("the upscaler readout uses the runtime FFX index, not its configured index",
    statsHost.textContent?.includes("UpscalerFSR 4.0.2"), true);
  await act(async () => statsRoot.unmount());
  statsHost.remove();

  const livePanelHost = document.createElement("div");
  document.body.appendChild(livePanelHost);
  const livePanelRoot = createRoot(livePanelHost);
  await act(async () => livePanelRoot.render(
    <LivePanel targetDir={detail.install.path} status={makeLiveStatus(detail.install.path)} onChanged={() => {}} />
  ));
  check("the setup readout uses the same explicitly labeled present-path FPS",
    livePanelHost.textContent?.includes("Present path FPS40.3 fps"), true);
  check("the setup readout preserves both core frame intervals",
    livePanelHost.textContent?.includes("Intervals24.80 ms present · 49.50 ms fg"), true);
  check("the setup readout does not derive a generated FPS pair from those intervals",
    livePanelHost.textContent?.includes("Presented rate") || livePanelHost.textContent?.includes("Rendered rate"), false);
  await act(async () => livePanelRoot.unmount());
  livePanelHost.remove();

  console.log("=== live module repair entry follows backend preflight ===");
  const renderLivePanel = async (
    status: any,
    running = false,
    onBeforeMutation?: () => Promise<void> | void,
  ) => {
    const node = document.createElement("div");
    document.body.appendChild(node);
    const r = createRoot(node);
    await act(async () => r.render(
      <LivePanel
        targetDir={detail.install.path}
        status={status}
        running={running}
        onBeforeMutation={onBeforeMutation}
        onChanged={() => {}}
      />
    ));
    return { node, root: r };
  };
  const repairButton = (node: Element) =>
    all(node, '[data-mock="ButtonItem"]').find((item) =>
      item.textContent?.includes("Add live control") || item.textContent?.includes("Reinstall live control"),
    );

  const previousLiveInstall = fixtures.install_live;
  const repairOrder: string[] = [];
  fixtures.install_live = () => {
    repairOrder.push("install");
    return { ok: true };
  };

  let repair = await renderLivePanel({
    ...makeLiveStatus(detail.install.path),
    supported: false, can_install: true, asi_installed: false, asi_current: null,
    attached: false, ready: false, state: "absent", schema: null,
  }, false, async () => { repairOrder.push("snapshot"); });
  check("a missing ASI on a managed supported target can be added",
    repairButton(repair.node)?.textContent?.trim(), "Add live control");
  check("the missing-ASI action is enabled after preflight",
    repairButton(repair.node)?.getAttribute("data-disabled"), null);
  await act(async () => { (repairButton(repair.node) as HTMLElement).click(); });
  await settle();
  check("live repair snapshots the managed install before writing files",
    repairOrder.join(","), "snapshot,install");
  await act(async () => repair.root.unmount());
  repair.node.remove();

  repairOrder.length = 0;
  repair = await renderLivePanel({
    ...makeLiveStatus(detail.install.path),
    supported: false, can_install: true, asi_installed: false, asi_current: null,
    attached: false, ready: false, state: "absent", schema: null,
  }, false, async () => {
    repairOrder.push("snapshot");
    throw new Error("snapshot failed");
  });
  await act(async () => { (repairButton(repair.node) as HTMLElement).click(); });
  await settle();
  check("a failed snapshot prevents the live file mutation",
    repairOrder.join(","), "snapshot");
  check("the snapshot failure is shown on the live panel",
    repair.node.textContent?.includes("snapshot failed"), true);
  await act(async () => repair.root.unmount());
  repair.node.remove();
  fixtures.install_live = previousLiveInstall;

  repair = await renderLivePanel({
    ...makeLiveStatus(detail.install.path),
    supported: false, can_install: true, asi_installed: true, asi_current: false,
    attached: false, ready: false, state: "legacy", schema: 5,
  });
  check("a known legacy ASI can be reinstalled when the game is stopped",
    repairButton(repair.node)?.textContent?.trim(), "Reinstall live control");
  check("the known-legacy repair is enabled after preflight",
    repairButton(repair.node)?.getAttribute("data-disabled"), null);
  await act(async () => repair.root.unmount());
  repair.node.remove();

  for (const [name, status] of [
    ["wrong core", {
      ...makeLiveStatus(detail.install.path), supported: false, can_install: false,
      asi_installed: false, asi_current: null, attached: false, ready: false, state: "unsupported",
    }],
    ["unknown ASI hash", {
      ...makeLiveStatus(detail.install.path), supported: false, can_install: false,
      asi_installed: true, asi_current: null, attached: false, ready: false, state: "unsupported",
    }],
  ] as const) {
    repair = await renderLivePanel(status);
    check(`${name} cannot bypass the live install preflight`, Boolean(repairButton(repair.node)), false);
    await act(async () => repair.root.unmount());
    repair.node.remove();
  }

  repair = await renderLivePanel({
    ...makeLiveStatus(detail.install.path),
    supported: false, can_install: true, asi_installed: false, asi_current: null,
    attached: false, ready: false, legacy_running: true, state: "legacy", schema: 5,
  });
  check("a repair action is disabled while a legacy game process is still running",
    repairButton(repair.node)?.getAttribute("data-disabled"), "true");
  check("the stopped-game requirement is explained",
    repair.node.textContent?.includes("Close the game before repairing live control"), true);
  await act(async () => repair.root.unmount());
  repair.node.remove();

  await act(async () => panel.root.unmount());
  liveConfiguredFgEnabled = true;
  liveConfiguredFgIndex = 0;
  liveConfiguredUpscalerIndex = 1;
  liveConfiguredBackend = "xess";
  liveFgIndex = 0;
  liveUpscalerIndex = 1;
  liveCountedFps = 40.4;
  liveBaseFps = 20.2;
  liveTotalFps = 40.4;
  liveTelemetrySource = "state_present_counter";
  livePresentPathFps = null;

  console.log("=== a version list that arrives after the control does ===");
  // The full page mounts its settings before the first live poll lands, so the
  // FidelityFX lists start as the shipped ini's snapshot and are replaced under
  // an index that does not move: 0 goes from "FSR 4.0.2", which is what the
  // reference ini documents, to what the game actually has. Steam's dropdown
  // builds its label once, so a control keyed on the value alone kept showing
  // the ini's name for ever -- which is why the page and the Quick Access
  // panel disagreed about the same install.
  setIni({ FSR: { UpscalerIndex: "0" } });
  const promptly = fixtures.get_live_status;
  fixtures.get_live_status = async (...args: any[]) => {
    await new Promise((r) => setTimeout(r, 60));
    return (promptly as any)(...args);
  };
  panel = await open();
  const versionControl = control(panel.node, "FSR version");
  // Not the reference ini's "FSR 4.0.2": the library sitting next to the game
  // is 4.1.1, and that is readable without the game running at all.
  check("the installed library names the newest one before the game answers",
        versionControl?.getAttribute("data-shown"), "FSR 4.1.1");
  await settle(30);
  check("and the game's own name replaces it once it does",
        control(panel.node, "FSR version")?.getAttribute("data-shown"), "FSR 4.1.1 *");
  fixtures.get_live_status = promptly;
  await act(async () => panel.root.unmount());

  console.log("=== switching running games while a lookup is pending ===");
  liveUpscalerIndex = 0;
  const originalFind = fixtures.find_running_game;
  const originalWrite = fixtures.write_config;
  let finishA: (answer: any) => void = () => {};
  let finishB: (answer: any) => void = () => {};
  fixtures.find_running_game = (appid: string) => new Promise((resolve) => {
    if (appid === "1091500") finishA = resolve;
    else finishB = resolve;
  });
  const targetB = {
    ...detail,
    path: "/games/Test B",
    name: "Test B",
    target: "/games/Test B/bin",
    install: { ...detail.install, path: "/games/Test B/bin" },
  };
  const writes: string[] = [];
  const writeTargets: string[] = [];
  fixtures.write_config = (dir: string, changes: any[]) => {
    writes.push(dir);
    writeTargets.push(...changes.map((change) => change.live_context?.target).filter(Boolean));
    for (const change of changes) {
      ini[change.section] = ini[change.section] ?? {};
      ini[change.section][change.key] = String(change.value);
    }
    return { ok: true, applied: changes, rejected: [], live: liveWriteResult(dir, changes) };
  };
  await act(async () => {
    root.render(
      <QuickPanel
        runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
        onOpenManager={() => {}}
      />
    );
  });
  await settle();
  await act(async () => {
    root.render(
      <QuickPanel
        runningGame={{ appid: 2358720, name: "Test B", gameid: "2358720" }}
        onOpenManager={() => {}}
      />
    );
  });
  await settle();
  check("old controls are hidden while the new target resolves",
    all(host, '[data-mock="DropdownItem"]').length, 0);
  await act(async () => finishB({ found: true, appid: "2358720", detail: targetB }));
  await settle(100);
  await act(async () => finishA({ found: true, appid: "1091500", detail }));
  await settle(100);
  check("the late lookup for game A cannot replace game B",
    host.textContent?.includes("Test B") && Boolean(control(host, "Override upscaler with")), true);
  check("game B's ready runtime is available before making a dynamic choice",
    tile(host, "upscaler"), "FSR 4.1.1 *");
  const targetControl = control(host, "FFX FG version");
  await act(async () => {
    (all(targetControl!, '[data-opt-value="2"]')[0] as HTMLElement).click();
  });
  await settle(100);
  check("a live setting chosen after the switch writes only to game B",
    writes.length > 0 && writes.every((dir) => dir === "/games/Test B/bin"), true);
  check("its live binding also names game B",
    writeTargets.length > 0 && writeTargets.every((target) => target === "/games/Test B/bin"), true);
  fixtures.find_running_game = originalFind;
  fixtures.write_config = originalWrite;

  console.log("=== schema 7 live confirmation and restart boundaries ===");
  type ContractMode = "pending" | "timeout" | "config_request_accepted" | "fail";
  let contractMode: ContractMode = "config_request_accepted";
  let contractWriteCalls = 0;
  let contractLiveSends = 0;
  let contractChanges: any[] = [];
  const resetContractTarget = (target: string, session: string) => {
    detail.install.path = target;
    detail.target = target;
    detail.gpu = DECK_GPU;
    setTargetLiveRecord(target, {
      restartKeys: [], livePending: [], live: null,
      persistedValues: {}, persistedRevisions: {},
    });
    setIni({
      FrameGen: { Enabled: "true", FGInput: "fsrfg", FGOutput: "fsrfg" },
      Upscalers: { Dx11Upscaler: "fsr31", Dx12Upscaler: "fsr31", VulkanUpscaler: "fsr31" },
      FSR: { FGIndex: "0", UpscalerIndex: "1", Fsr4Update: "false", Fsr4ForceEnableInt8: "0" },
    });
    FFX_VERSIONS.splice(0, FFX_VERSIONS.length, ...DEFAULT_FFX_VERSIONS);
    liveSession = session;
    liveSequence = "10";
    liveAck = "config_request_accepted";
    liveActiveApi = "dx12";
    liveGeneration = "generation-a";
    captureRequest();
    liveStatusState = "ready";
    liveStatusReady = true;
    liveStatusSupported = true;
    liveCanEnableFg = true;
    liveConfirmedKeys = [];
    liveFailedKeys = [];
    liveBackend = "fsr31";
    liveFgIndex = 0;
    liveUpscalerIndex = 1;
    liveConfiguredFgIndex = 0;
    liveConfiguredUpscalerIndex = 1;
    liveConfiguredBackend = "xess";
    liveFgEnabled = true;
    liveConfiguredFgEnabled = true;
    liveCountedFps = 40.4;
    liveBaseFps = 20.2;
    liveTotalFps = 40.4;
    liveTelemetryReady = true;
    liveTelemetrySource = "state_present_counter";
    livePresentPathFps = null;
  };
  fixtures.write_config = (target: string, changes: any[]) => {
    contractWriteCalls += 1;
    contractChanges = changes.map((change) => ({ ...change }));
    if (contractMode === "fail") return { ok: false, error: "disk is read-only" };

    const applied = changes.map(({ section, key, value }) => ({ section, key, value: String(value) }));
    for (const change of applied) {
      ini[change.section] = ini[change.section] ?? {};
      ini[change.section][change.key] = change.value;
    }
    const allLiveIds = changes
      .map((change) => `${change.section}.${change.key}`)
      .filter((id) => LIVE_FIELD_IDS.includes(id));
    const context = {
      target,
      session: liveSession,
      active_api: liveActiveApi,
      capability_generation: liveGeneration,
    };
    const liveChanges = changes.filter((change) => {
      const id = `${change.section}.${change.key}`;
      if (
        !liveStatusSupported || !liveStatusReady || liveAck === "pending" || liveAck === "timeout" ||
        !LIVE_FIELD_IDS.includes(id) || LIVE_CAPABILITIES[id] !== true
      ) return false;
      if (id === "FrameGen.Enabled" && String(change.value).toLowerCase() === "true" && !liveCanEnableFg) {
        return false;
      }
      if (!DYNAMIC_LIVE_FIELD_IDS.has(id)) return true;
      const selected = change.live_context;
      if (
        selected?.target !== target || selected.session !== liveSession ||
        selected.active_api !== liveActiveApi || selected.capability_generation !== liveGeneration
      ) return false;
      if (id === "FSR.FGIndex" && Number(change.value) >= FFX_VERSIONS.length) return false;
      if (id === "FSR.UpscalerIndex") {
        const index = Number(change.value);
        if (
          index >= FSR_VERSIONS.length
        ) return false;
      }
      if (id.startsWith("Upscalers.")) {
        const key = id.slice("Upscalers.".length);
        const api = key === "Dx11Upscaler" ? "dx11" : key === "VulkanUpscaler" ? "vulkan" : "dx12";
        if (api !== liveActiveApi) return false;
      }
      return true;
    });
    const keys = liveChanges.map((change) => `${change.section}.${change.key}`);
    const deferred = allLiveIds.filter((id) => !keys.includes(id));
    if (keys.length === 0) {
      return {
        ok: true, applied, rejected: [],
        live: {
          sent: false, confirmed: false, ack: null, session: null, seq: null,
          applied: [], accepted_keys: [], sent_keys: [], context: null, failed_keys: [], deferred,
          reason: "The selection-time session, API, or FFX list changed.",
        },
      };
    }

    contractLiveSends += 1;
    const seq = String(BigInt(liveSequence) + 1n);
    if (contractMode === "pending" || contractMode === "timeout") {
      liveSequence = seq;
    captureRequest();
      const ack = contractMode === "timeout" ? "timeout" : "pending";
      liveAck = ack;
      liveStatusState = contractMode === "timeout" ? "timeout" : "queued";
      liveConfirmedKeys = [];
      liveFailedKeys = [];
      return {
        ok: true, applied, rejected: [],
        live: {
          sent: true, directory_generation: "1", confirmed: false, ack, session: liveSession, seq,
          applied: [], accepted_keys: [], sent_keys: keys, context, failed_keys: [], deferred,
        },
      };
    }
    liveSequence = seq;
    captureRequest();
    liveAck = "config_request_accepted";
    liveStatusState = "ready";
    liveConfirmedKeys = keys;
    liveFailedKeys = [];
    return {
      ok: true, applied, rejected: [],
      live: {
        sent: true, directory_generation: "1", confirmed: true, ack: "config_request_accepted", session: liveSession, seq,
          applied: keys, accepted_keys: keys, sent_keys: keys, context,
          failed_keys: [], deferred,
      },
    };
  };

  const clickToggle = async (host: Element) => {
    const toggle = all(host, '[data-mock="ToggleField"][data-label="Frame generation"]')[0];
    await act(async () => { (all(toggle, "[data-toggle]")[0] as HTMLElement).click(); });
    await settle(200);
  };
  const restartButtonVisible = (host: Element) =>
    all(host, '[data-mock="ButtonItem"]').some((node) => node.textContent?.includes("Restart game to apply"));

  console.log("--- failed INI save never sends a live command ---");
  resetContractTarget("/games/live-contract/fail-save", "session-fail-save");
  contractMode = "fail";
  contractWriteCalls = 0;
  contractLiveSends = 0;
  let contractPanel = await open();
  await clickToggle(contractPanel.node);
  check("the failed save is visible", contractPanel.node.textContent?.includes("disk is read-only"), true);
  check("the failed value stays off disk", ini.FrameGen.Enabled, "true");
  check("the write RPC ran once and native send did not run", `${contractWriteCalls}/${contractLiveSends}`, "1/0");
  check("a failed save is not described as applied", contractPanel.node.textContent?.includes("Sent to OptiScaler"), false);
  await act(async () => contractPanel.root.unmount());

  console.log("--- an unsupported FG enable stays saved while safe OFF remains live ---");
  const fgOffTarget = "/games/live-contract/fg-safe-off";
  resetContractTarget(fgOffTarget, "session-fg-safe-off");
  liveCanEnableFg = false;
  contractMode = "config_request_accepted";
  contractLiveSends = 0;
  contractPanel = await open();
  await clickToggle(contractPanel.node);
  check("turning FG off still sends through the safe change capability", contractLiveSends, 1);
  check("safe OFF is accepted for the actual key", getTargetLiveRecord(fgOffTarget).live?.accepted_keys?.includes("FrameGen.Enabled"), true);
  await act(async () => contractPanel.root.unmount());

  console.log("--- a scalar uses the context that authorized its actual send ---");
  const scalarTarget = "/games/live-contract/scalar-send-context";
  resetContractTarget(scalarTarget, "session-scalar-context");
  liveStatusReady = false;
  liveStatusState = "awaiting_frame";
  liveGeneration = "generation-at-selection";
  contractMode = "config_request_accepted";
  contractLiveSends = 0;
  contractPanel = await open();
  const scalarWriter = fixtures.write_config;
  let releaseScalar: () => void = () => {};
  fixtures.write_config = async (...args: any[]) => {
    await new Promise<void>((resolve) => { releaseScalar = resolve; });
    return (scalarWriter as any)(...args);
  };
  const scalarToggle = all(
    control(contractPanel.node, "Frame generation"), "[data-toggle]",
  )[0] as HTMLElement;
  await act(async () => scalarToggle.click());
  // The value was picked without a ready selection snapshot. A later, current
  // status authorizes this scalar when the queued INI write reaches the API.
  liveStatusReady = true;
  liveStatusState = "ready";
  liveGeneration = "generation-at-send";
  await act(async () => releaseScalar());
  await settle(200);
  fixtures.write_config = scalarWriter;
  const scalarResult = getTargetLiveRecord(scalarTarget).live;
  check("the scalar write carries no selection-time binding", contractChanges[0]?.live_context, undefined);
  check("the actual scalar send is recorded as sent", scalarResult?.sent_keys?.includes("FrameGen.Enabled"), true);
  check("the pending record carries the send-time generation",
    scalarResult?.context?.capability_generation, "generation-at-send");
  check("the current send is confirmed without a selection snapshot",
    scalarResult?.confirmed && scalarResult.ack === "config_request_accepted", true);
  await act(async () => contractPanel.root.unmount());
  liveStatusReady = true;
  liveStatusState = "ready";

  const fgOnTarget = "/games/live-contract/fg-unproven-enable";
  resetContractTarget(fgOnTarget, "session-fg-unproven-enable");
  setIni({ FrameGen: { Enabled: "false" } });
  liveCanEnableFg = false;
  contractMode = "config_request_accepted";
  contractLiveSends = 0;
  contractPanel = await open();
  await clickToggle(contractPanel.node);
  check("an unproven FG enable is still saved to the INI", ini.FrameGen.Enabled, "true");
  check("an unproven FG enable does not send a live command", contractLiveSends, 0);
  check("the UI marks the saved enable for restart",
    restartButtonVisible(contractPanel.node), true);
  await act(async () => contractPanel.root.unmount());

  console.log("--- sent pending, late ACK, and telemetry ---");
  const pendingTarget = "/games/live-contract/late-ack";
  resetContractTarget(pendingTarget, "session-late-ack");
  contractMode = "pending";
  contractPanel = await open();
  await clickToggle(contractPanel.node);
  const pendingSeq = liveSequence;
  check("a send without terminal ACK remains pending", contractPanel.node.textContent?.includes("Saved · waiting for OptiScaler"), true);
  check("pending live work does not claim success", contractPanel.node.textContent?.includes("Sent to OptiScaler"), false);
  check("pending live work does not ask for restart yet", restartButtonVisible(contractPanel.node), false);
  await act(async () => contractPanel.root.unmount());

  contractPanel = await open();
  check("verified telemetry stays visible while the command is pending", Boolean(tile(contractPanel.node, "base fps")), true);
  check("the queued state is shown separately", contractPanel.node.textContent?.includes("live · queued"), true);
  const cachedEntry = getTargetLiveRecord(pendingTarget).livePending[0];
  const probeHost = document.createElement("div");
  document.body.appendChild(probeHost);
  const probeRoot = createRoot(probeHost);
  let probeActions: {
    authoritativeReload: () => Promise<void>;
    reconcileLiveStatus: (status: any, epoch: number | null) => void;
  } | null = null;
  const publishProbeActions = (actions: NonNullable<typeof probeActions>) => { probeActions = actions; };
  await act(async () => probeRoot.render(
    <ConfigProbe target={pendingTarget} onReady={publishProbeActions} />
  ));
  await settle();
  probeActions?.reconcileLiveStatus({
    ...makeLiveStatus(pendingTarget),
    session: "different-cached-session",
    seq: "1",
    ack: "config_request_accepted",
    accepted_keys: ["FrameGen.Enabled"],
  }, cachedEntry?.statusEpoch ?? null);
  check("another panel's cached session cannot retire a newer pending write",
    getTargetLiveRecord(pendingTarget).livePending.some((entry) => entry.seq === pendingSeq), true);
  await act(async () => probeRoot.unmount());
  probeHost.remove();
  await act(async () => contractPanel.root.unmount());

  liveAck = "config_request_accepted";
  liveStatusState = "ready";
  liveConfirmedKeys = ["FrameGen.Enabled"];
  contractPanel = await open();
  await settle();
  check("the same session and sequence late ACK clears pending", contractPanel.node.textContent?.includes("Sent to OptiScaler"), true);
  check("the confirmed late ACK leaves no restart button", restartButtonVisible(contractPanel.node), false);
  await act(async () => contractPanel.root.unmount());

  console.log("--- a timed-out sequence stays pending until its exact late ACK ---");
  const timeoutTarget = "/games/live-contract/timeout-late-ack";
  resetContractTarget(timeoutTarget, "session-timeout-late-ack");
  contractMode = "timeout";
  contractPanel = await open();
  await clickToggle(contractPanel.node);
  const timeoutSeq = liveSequence;
  check("timeout is shown as unresolved, not rejected",
    contractPanel.node.textContent?.includes("Saved · live request unconfirmed"), true);
  check("a timeout with empty failure keys does not demand restart",
    restartButtonVisible(contractPanel.node), false);
  await act(async () => contractPanel.root.unmount());

  contractPanel = await open();
  check("reopening keeps the same timeout pending",
    contractPanel.node.textContent?.includes("Saved · live request unconfirmed"), true);
  check("reopened timeout still has no restart button",
    restartButtonVisible(contractPanel.node), false);
  await act(async () => contractPanel.root.unmount());

  liveSequence = timeoutSeq;
  liveAck = "config_request_accepted";
  liveStatusState = "ready";
  liveConfirmedKeys = ["FrameGen.Enabled"];
  liveFailedKeys = [];
  contractPanel = await open();
  await settle();
  check("only the matching session and sequence late ACK confirms the saved change",
    contractPanel.node.textContent?.includes("Sent to OptiScaler"), true);
  check("that exact late ACK clears the restart requirement",
    restartButtonVisible(contractPanel.node), false);
  await act(async () => contractPanel.root.unmount());

  console.log("--- an explicit backend switch timeout remains target-pending ---");
  const switchTarget = "/games/live-contract/backend-timeout";
  resetContractTarget(switchTarget, "session-backend-timeout");
  contractMode = "config_request_accepted";
  const originalSwitch = fixtures.switch_upscaler;
  let finishBackendTimeout: (() => void) | null = null;
  fixtures.switch_upscaler = (dir: string, code: string, context: any) => new Promise((resolve) => {
    contractLiveSends += 1;
    const seq = String(BigInt(liveSequence) + 1n);
    finishBackendTimeout = () => {
      liveSequence = seq;
    captureRequest();
      liveAck = "timeout";
      liveStatusState = "timeout";
      liveConfirmedKeys = [];
      liveFailedKeys = [];
      resolve({
        ok: false,
        backend: code,
        live: {
          sent: true, directory_generation: "1", confirmed: false, ack: "timeout", session: context.session, seq,
          applied: [], accepted_keys: [], sent_keys: ["Upscalers.Dx12Upscaler"],
          context, failed_keys: [], deferred: [],
        },
      });
    };
  });
  contractLiveSends = 0;
  contractPanel = await open();
  const switchPreset = control(contractPanel.node, "Override upscaler with");
  await act(async () => { (all(switchPreset, '[data-opt-value="xess"]')[0] as HTMLElement).click(); });
  await settle(100);
  const switchNow = all(contractPanel.node, '[data-mock="ButtonItem"]')
    .find((node) => node.textContent?.includes("Switch now, without restarting"));
  check("a saved backend choice offers its explicit live action", Boolean(switchNow), true);
  await act(async () => { (switchNow as HTMLElement).click(); });
  await settle();
  const writesBeforeBusySelection = contractWriteCalls;
  const busyPreset = control(contractPanel.node, "Override upscaler with");
  check("the backend choice is locked during its live request",
    busyPreset.getAttribute("data-disabled"), "true");
  check("the switch button cannot be sent twice while the first request is pending",
    switchNow.getAttribute("data-disabled"), "true");
  await act(async () => {
    (all(busyPreset, '[data-opt-value="fsr4"]')[0] as HTMLElement).click();
    (switchNow as HTMLElement).click();
  });
  await settle();
  check("the in-flight selection cannot queue a failed replacement save", contractWriteCalls, writesBeforeBusySelection);
  check("the disabled button sends only one backend switch", contractLiveSends, 1);
  check("the first backend selection remains saved", ini.Upscalers.Dx12Upscaler, "xess");
  await act(async () => finishBackendTimeout?.());
  await settle();
  const backendKey = "Upscalers.Dx12Upscaler";
  const backendPending = getTargetLiveRecord(switchTarget).livePending
    .find((entry) => entry.keys.includes(backendKey));
  const backendTimeoutSeq = liveSequence;
  check("the sent timeout is pending in the shared target record", Boolean(backendPending), true);
  check("the pending backend key retains the selection-time capability generation",
    backendPending?.contexts[backendKey]?.capability_generation, "generation-a");
  check("the timeout is not shown as a rejected switch",
    contractPanel.node.textContent?.includes("Could not switch the upscaler"), false);
  await act(async () => contractPanel.root.unmount());

  liveSequence = backendTimeoutSeq;
  liveAck = "config_request_accepted";
  liveStatusState = "ready";
  liveBackend = "xess";
  liveConfirmedKeys = [backendKey];
  liveFailedKeys = [];
  contractPanel = await open();
  await settle();
  check("the matching status ACK resolves the backend timeout after reopening",
    getTargetLiveRecord(switchTarget).livePending.some((entry) => entry.keys.includes(backendKey)), false);
  check("the backend key is confirmed without a restart",
    getTargetLiveRecord(switchTarget).restartKeys.includes(backendKey), false);
  await act(async () => contractPanel.root.unmount());
  fixtures.switch_upscaler = originalSwitch;

  console.log("--- an authoritative reset invalidates a saved backend switch proof ---");
  const resetTarget = "/games/live-contract/reset-invalidates-switch";
  resetContractTarget(resetTarget, "session-reset-switch");
  contractMode = "config_request_accepted";
  const switchCallsBeforeReset = invocations.filter((call) => call.name === "switch_upscaler").length;
  contractPanel = await open();
  const resetPreset = control(contractPanel.node, "Override upscaler with");
  await act(async () => { (all(resetPreset, '[data-opt-value="xess"]')[0] as HTMLElement).click(); });
  await settle(200);
  check("the saved backend value initially has a live switch action",
    all(contractPanel.node, '[data-mock="ButtonItem"]').some((node) => node.textContent?.includes("Switch now")), true);

  const resetProbeHost = document.createElement("div");
  document.body.appendChild(resetProbeHost);
  const resetProbeRoot = createRoot(resetProbeHost);
  let resetActions: {
    authoritativeReload: () => Promise<void>;
    reconcileLiveStatus: (status: any, epoch: number | null) => void;
  } | null = null;
  const publishResetActions = (actions: NonNullable<typeof resetActions>) => { resetActions = actions; };
  await act(async () => resetProbeRoot.render(
    <ConfigProbe target={resetTarget} onReady={publishResetActions} />
  ));
  await settle();
  setIni({ Upscalers: { Dx12Upscaler: "fsr31" } });
  await act(async () => { await resetActions?.authoritativeReload(); });
  await settle();
  check("the reset removes the old persisted-value proof",
    getTargetLiveRecord(resetTarget).persistedRevisions["Upscalers.Dx12Upscaler"], undefined);
  check("the other panel drops the stale switch action",
    all(contractPanel.node, '[data-mock="ButtonItem"]').some((node) => node.textContent?.includes("Switch now")), false);
  await act(async () => resetProbeRoot.unmount());
  resetProbeHost.remove();
  await act(async () => contractPanel.root.unmount());
  check("resetting the INI does not issue a backend switch",
    invocations.filter((call) => call.name === "switch_upscaler").length, switchCallsBeforeReset);

  console.log("--- a receipt preserves the generation of its request ---");
  const generationTarget = "/games/live-contract/changed-generation";
  resetContractTarget(generationTarget, "session-changed-generation");
  contractMode = "timeout";
  contractPanel = await open();
  await clickToggle(contractPanel.node);
  const generationSeq = liveSequence;
  await act(async () => contractPanel.root.unmount());
  liveSequence = generationSeq;
  liveGeneration = "generation-b";
  liveAck = "config_request_accepted";
  liveStatusState = "ready";
  liveConfirmedKeys = ["FrameGen.Enabled"];
  contractPanel = await open();
  await settle();
  check("a capability change after submission does not invalidate its matching receipt",
    restartButtonVisible(contractPanel.node), false);
  check("the accepted request retires without claiming the current runtime changed",
    getTargetLiveRecord(generationTarget).livePending.length === 0 &&
      contractPanel.node.textContent?.includes("Sent to OptiScaler"), true);
  await act(async () => contractPanel.root.unmount());

  console.log("--- a changed value is not cleared by an older late ACK ---");
  const changedTarget = "/games/live-contract/late-ack-newer-value";
  resetContractTarget(changedTarget, "session-late-newer");
  contractMode = "pending";
  contractLiveSends = 0;
  contractPanel = await open();
  await clickToggle(contractPanel.node);
  const originalPendingSeq = liveSequence;
  await act(async () => contractPanel.root.unmount());

  contractPanel = await open();
  check("the original request is still pending before the next edit", contractPanel.node.textContent?.includes("Saved · waiting for OptiScaler"), true);
  await clickToggle(contractPanel.node);
  check("a newer edit during the locked mailbox is not sent", contractLiveSends, 1);
  await act(async () => contractPanel.root.unmount());

  liveSequence = originalPendingSeq;
  liveAck = "config_request_accepted";
  liveStatusState = "ready";
  liveConfirmedKeys = ["FrameGen.Enabled"];
  contractPanel = await open();
  await settle();
  check("the older ACK cannot clear the changed value's restart requirement", restartButtonVisible(contractPanel.node), true);
  check("the newer saved value remains authoritative",
    all(control(contractPanel.node, "Frame generation"), "[data-toggle]")[0]?.getAttribute("data-checked"), "true");
  check("the older ACK is not shown as the current applied result", contractPanel.node.textContent?.includes("Sent to OptiScaler"), false);
  await act(async () => contractPanel.root.unmount());

  console.log("--- two panels merge the newest target revision before a late ACK ---");
  const dualTarget = "/games/live-contract/two-panels-newer-revision";
  resetContractTarget(dualTarget, "session-two-panels");
  contractMode = "pending";
  contractLiveSends = 0;
  let firstPanel = await open();
  await clickToggle(firstPanel.node);
  const dualSeq = liveSequence;
  const olderRevision = getTargetLiveRecord(dualTarget).livePending[0]?.revisions["FrameGen.Enabled"] ?? -1;
  let secondPanel = await open();
  check("the second panel reads the value saved by the first",
    all(control(secondPanel.node, "Frame generation"), "[data-toggle]")[0]?.getAttribute("data-checked"), "false");
  await clickToggle(secondPanel.node);
  const newerRevision = getTargetLiveRecord(dualTarget).persistedRevisions["FrameGen.Enabled"] ?? -1;
  check("the second panel's persisted revision is newer", newerRevision > olderRevision, true);
  check("the locked mailbox does not accept the second live send", contractLiveSends, 1);
  liveSequence = dualSeq;
  liveAck = "config_request_accepted";
  liveStatusState = "ready";
  liveConfirmedKeys = ["FrameGen.Enabled"];
  secondPanel = await open();
  check("the first panel's late ACK cannot clear the newer revision's restart requirement",
    restartButtonVisible(secondPanel.node), true);
  await act(async () => firstPanel.root.unmount());
  await act(async () => secondPanel.root.unmount());

  console.log("--- a new session cannot confirm the old sequence ---");
  const oldSessionTarget = "/games/live-contract/old-session";
  resetContractTarget(oldSessionTarget, "session-before-relaunch");
  contractMode = "pending";
  contractPanel = await open();
  await clickToggle(contractPanel.node);
  await act(async () => contractPanel.root.unmount());
  await getTargetConfigQueue(oldSessionTarget).drain;
  await waitForTargetWrites(oldSessionTarget);
  liveSession = "session-after-relaunch";
  liveSequence = "1";
  liveAck = "config_request_accepted";
  liveStatusState = "ready";
  liveConfirmedKeys = ["FrameGen.Enabled"];
  contractPanel = await open();
  await settle();
  check("old-session confirmation is kept as a restart change", restartButtonVisible(contractPanel.node), true);
  check("the prior session is named in the outcome", contractPanel.node.textContent?.includes("previous game session"), true);
  await act(async () => contractPanel.root.unmount());

  console.log("--- one live FFX key plus one startup-only key stays mixed ---");
  const mixedTarget = "/games/live-contract/mixed-restart";
  resetContractTarget(mixedTarget, "session-mixed");
  setGpu(RDNA4_GPU);
  contractMode = "config_request_accepted";
  contractPanel = await open();
  const mixedVersion = control(contractPanel.node, "FSR version");
  await act(async () => { (all(mixedVersion, '[data-opt-value="0"]')[0] as HTMLElement).click(); });
  await settle(200);
  check("the FFX index was applied while the startup-only flag was saved", ini.FSR.UpscalerIndex, "0");
  await act(async () => contractPanel.root.unmount());
  contractPanel = await open();
  await settle();
  check("the same ACK reports the live key and the restart-only flag", contractPanel.node.textContent?.includes("some settings need restart"), true);
  check("a mixed batch retains its restart button", restartButtonVisible(contractPanel.node), true);
  await act(async () => contractPanel.root.unmount());
  detail.gpu = DECK_GPU;

  console.log("--- Advanced FFX controls use the same ordered IDs as Basic ---");
  const advancedTarget = "/games/live-contract/advanced-runtime-lists";
  resetContractTarget(advancedTarget, "session-advanced-runtime-lists");
  const advancedStatus = makeLiveStatus(advancedTarget);
  const toRuntimeChoice = (choice: ReturnType<typeof liveFfxVersionChoices>[number]) => ({
    value: choice.data,
    label: choice.label,
    context: choice.context,
  });
  const advancedRuntimeChoices = {
    "FSR.FGIndex": [
      {
        value: "auto",
        label: "Auto · running FSR 4.0.0",
        context: null,
      },
      ...liveFfxVersionChoices(advancedStatus, advancedTarget, "fg").map(toRuntimeChoice),
    ],
    "FSR.UpscalerIndex": [
      {
        value: "auto",
        label: "Auto · running FSR 4.0.2",
        context: null,
      },
      ...liveFfxVersionChoices(advancedStatus, advancedTarget, "upscaler").map(toRuntimeChoice),
    ],
  };
  const advancedHost = document.createElement("div");
  document.body.appendChild(advancedHost);
  const advancedRoot = createRoot(advancedHost);
  const advancedSelection: { current: { id: string; value: string; context: any } | null } = {
    current: null,
  };
  await act(async () => advancedRoot.render(
    <ConfigTab
      tabId="fsr-runtime-test"
      sections={["FSR"]}
      values={ini}
      onChange={(option, value, context) => {
        advancedSelection.current = { id: `${option.section}.${option.key}`, value, context };
      }}
      onResetSection={() => {}}
      runtimeChoices={advancedRuntimeChoices}
      runtimeGeneration={advancedStatus.capability_generation}
    />
  ));
  const advancedUpscaler = control(advancedHost, "Upscaler Index");
  check("Advanced Auto names the version currently selected by the runtime",
    all(advancedUpscaler, '[data-opt-value="auto"]')[0]?.textContent, "Auto · running FSR 4.0.2");
  check("Advanced exposes the extra game-reported FSR version",
    all(advancedUpscaler, '[data-opt-value="3"]')[0]?.textContent, "FSR 2.3.4");
  await act(async () => { (all(advancedUpscaler, '[data-opt-value="3"]')[0] as HTMLElement).click(); });
  check("Advanced binds that runtime index to the same selection snapshot",
    advancedSelection.current?.id === "FSR.UpscalerIndex" && advancedSelection.current.value === "3" &&
      advancedSelection.current.context?.target === advancedTarget &&
      advancedSelection.current.context?.session === "session-advanced-runtime-lists" &&
      advancedSelection.current.context?.capability_generation === "generation-a", true);
  const advancedRestartVersion = all(advancedUpscaler, '[data-opt-value="2"]')[0];
  check("Advanced labels the same exact restart-only runtime ID",
    advancedRestartVersion?.textContent, "FSR 3.1.5");
  await act(async () => { (advancedRestartVersion as HTMLElement).click(); });
  check("Advanced binds every listed ID to its request context",
    advancedSelection.current?.value === "2" && advancedSelection.current.context?.capability_generation === liveGeneration, true);
  const advancedFg = control(advancedHost, "FG Index");
  check("Advanced uses the runtime FG list instead of the static INI list",
    all(advancedFg, '[data-opt-value="2"]')[0]?.textContent, "FSR 3.1.4");
  await act(async () => { (all(advancedFg, '[data-opt-value="2"]')[0] as HTMLElement).click(); });
  check("Advanced captures the FG selection-time context",
    advancedSelection.current?.id === "FSR.FGIndex" && advancedSelection.current.value === "2" &&
      advancedSelection.current.context?.capability_generation === "generation-a", true);
  await act(async () => advancedRoot.unmount());
  advancedHost.remove();

  console.log("--- FFX list reorder invalidates the selection-time generation ---");
  const reorderTarget = "/games/live-contract/ffx-reorder";
  resetContractTarget(reorderTarget, "session-reorder");
  contractMode = "config_request_accepted";
  contractLiveSends = 0;
  contractPanel = await open();
  const fgVersion = control(contractPanel.node, "FFX FG version");
  await act(async () => {
    (all(fgVersion, '[data-opt-value="2"]')[0] as HTMLElement).click();
    // Same length, different order: generation must change and the queued old
    // selection must retain the generation it captured before this mutation.
    liveGeneration = "generation-b";
    FFX_VERSIONS.splice(0, FFX_VERSIONS.length, "4.0.0", "3.1.4", "3.1.6");
  });
  await settle(200);
  const capturedFg = contractChanges.find((change) => change.key === "FGIndex");
  check("the saved FG index keeps the selection-time generation", capturedFg?.live_context?.capability_generation, "generation-a");
  check("a reordered FFX list prevents live send", contractLiveSends, 0);
  check("the selected index is still saved", ini.FSR.FGIndex, "2");
  check("the changed generation is explained without claiming success", contractPanel.node.textContent?.includes("FFX list changed"), true);
  check("a stale list selection is not labeled applied", contractPanel.node.textContent?.includes("Sent to OptiScaler"), false);
  await act(async () => contractPanel.root.unmount());

  console.log("--- an API change invalidates a pending backend pick ---");
  const apiTarget = "/games/live-contract/api-change";
  resetContractTarget(apiTarget, "session-api-change");
  const apiHost = document.createElement("div");
  document.body.appendChild(apiHost);
  const apiRoot = createRoot(apiHost);
  const apiValues = JSON.parse(JSON.stringify(ini));
  const apiProps = {
    values: apiValues,
    gpu: DECK_GPU,
    live: makeLiveStatus(apiTarget),
    targetDir: apiTarget,
    ffx: detail.install.fsr4.ffx,
    compact: true,
    onApply: (changes: any[]) => {
      const revision = ++getTargetConfigQueue(apiTarget).revision;
      const record = getTargetLiveRecord(apiTarget);
      const revisions: Record<string, number> = {};
      for (const change of changes) {
        const id = `${change.section}.${change.key}`;
        record.persistedValues[id] = change.value;
        record.persistedRevisions[id] = revisions[id] = revision;
        apiValues[change.section][change.key] = change.value;
      }
      setTargetLiveRecord(apiTarget, record);
      return revisions;
    },
  };
  const switchesBefore = invocations.filter((call) => call.name === "switch_upscaler").length;
  await act(async () => { apiRoot.render(<BasicPanel {...apiProps} />); });
  await settle();
  const apiUpscaler = control(apiHost, "Override upscaler with");
  await act(async () => { (all(apiUpscaler, '[data-opt-value="xess"]')[0] as HTMLElement).click(); });
  await settle();
  check("a fresh backend selection offers its live action", all(apiHost, '[data-mock="ButtonItem"]').some((node) => node.textContent?.includes("Switch now")), true);
  const changedApiStatus = {
    ...makeLiveStatus(apiTarget),
    active_api: "vulkan" as const,
    capability_generation: "generation-api-b",
    upscaler: { dx11: null, dx12: "fsr31", vulkan: "fsr31" },
  };
  await act(async () => { apiRoot.render(<BasicPanel {...apiProps} live={changedApiStatus} />); });
  await settle();
  check("the backend action disappears after the API change", all(apiHost, '[data-mock="ButtonItem"]').some((node) => node.textContent?.includes("Switch now")), false);
  check("the old API selection asks for a fresh choice", apiHost.textContent?.includes("active API, session, or FFX version list changed after selection"), true);
  check("the stale choice does not issue a switch RPC", invocations.filter((call) => call.name === "switch_upscaler").length, switchesBefore);
  await act(async () => apiRoot.unmount());
  apiHost.remove();

  console.log("--- a backend pick made before the first live status is saved ---");
  const lateTarget = "/games/live-contract/first-status-after-pick";
  const lateHost = document.createElement("div");
  document.body.appendChild(lateHost);
  const lateRoot = createRoot(lateHost);
  const lateValues = JSON.parse(JSON.stringify(ini));
  const lateProps = {
    values: lateValues,
    gpu: DECK_GPU,
    live: null as any,
    targetDir: lateTarget,
    ffx: detail.install.fsr4.ffx,
    compact: true,
    onApply: (changes: any[]) => {
      const revision = ++getTargetConfigQueue(lateTarget).revision;
      const record = getTargetLiveRecord(lateTarget);
      const revisions: Record<string, number> = {};
      for (const change of changes) {
        const id = `${change.section}.${change.key}`;
        record.persistedValues[id] = change.value;
        record.persistedRevisions[id] = revisions[id] = revision;
        lateValues[change.section][change.key] = change.value;
      }
      setTargetLiveRecord(lateTarget, record);
      return revisions;
    },
  };
  await act(async () => lateRoot.render(<BasicPanel {...lateProps} />));
  const lateUpscaler = control(lateHost, "Override upscaler with");
  await act(async () => {
    (all(lateUpscaler, '[data-opt-value="xess"]')[0] as HTMLElement).click();
  });
  await settle();
  await act(async () => lateRoot.render(
    <BasicPanel {...lateProps} live={makeLiveStatus(lateTarget)} />,
  ));
  await settle();
  check("the first ready status recognizes the already-saved active backend",
    lateHost.textContent?.includes("Saving this backend value before offering a live switch"), false);
  check("a pick made without live authorization asks for a fresh selection",
    lateHost.textContent?.includes("choose again when live status is ready"), true);
  check("a late status does not silently authorize the old selection",
    all(lateHost, '[data-mock="ButtonItem"]').some((node) => node.textContent?.includes("Switch now")), false);
  await act(async () => lateRoot.unmount());
  lateHost.remove();
  detail.gpu = DECK_GPU;
  FFX_VERSIONS.splice(0, FFX_VERSIONS.length, ...DEFAULT_FFX_VERSIONS);

  console.log("--- community Lite targets RDNA2 APUs and labels legacy installs ---");
  for (const [gpu, expected] of [
    [DECK_GPU, 1],
    [{ name: "Radeon RX 6800", vendor: "amd", generation: "RDNA2", fsr4: "experimental" }, 0],
    [{ name: "Intel Arc", vendor: "intel", generation: null, fsr4: "unsupported" }, 0],
    [undefined, 0],
  ] as const) {
    const host = document.createElement("div"); document.body.appendChild(host);
    const probe = createRoot(host);
    await act(async () => probe.render(<BasicPanel values={{ Upscalers: { Dx12Upscaler: "auto" } }}
      gpu={gpu as any} fsr4Build="bundled" onApply={() => {}} />));
    check(`community Lite recommendation for ${gpu?.name ?? "unknown GPU"}`,
      all(host, '[data-opt-value="fsr4-int8"]').length, expected);
    await act(async () => probe.unmount()); host.remove();
  }
  const legacyHost = document.createElement("div"); document.body.appendChild(legacyHost);
  const legacyRoot = createRoot(legacyHost);
  const legacyValues = { Upscalers: { Dx12Upscaler: "fsr31" },
    FSR: { Fsr4ForceEnableInt8: "1", Fsr4Update: "auto", UpscalerIndex: "0" } };
  await act(async () => legacyRoot.render(<BasicPanel values={legacyValues}
    gpu={DECK_GPU as any} fsr4Build="4.1.1b" onApply={() => {}} />));
  check("4.1.1b is not labeled as the new Lite preset", selected(legacyHost, "Override upscaler with"), "manual-int8");
  check("the older installed build is named", legacyHost.textContent?.includes("FSR 4.1.1b (legacy)"), true);
  await act(async () => legacyRoot.render(<BasicPanel values={legacyValues}
    fsr4Build="4.1.2-lite-exact-20261105" onApply={() => {}} />));
  check("new DLL without the complete preset stays manual", selected(legacyHost, "Override upscaler with"), "manual-int8");
  const liteValues = { ...legacyValues, FSR: { ...legacyValues.FSR, Fsr4Update: "true" } };
  await act(async () => legacyRoot.render(<BasicPanel values={liteValues}
    fsr4Build="4.1.2-lite-exact-20261105" onApply={() => {}} />));
  check("an installed Lite build remains visible while hardware is unknown", selected(legacyHost, "Override upscaler with"), "fsr4-int8");
  await act(async () => legacyRoot.unmount()); legacyHost.remove();

  console.log("--- the installed Lite build offers direct legacy recovery ---");
  const priorInfo = fixtures.get_fsr4_info; const priorVerify = fixtures.verify_install;
  installedFsr4Build = "4.1.2-lite-exact-20261105";
  fixtures.get_fsr4_info = () => ({ status: { build: { known: true,
    id: installedFsr4Build, label: installedFsr4Build } } });
  fixtures.verify_install = { ok: true, complete: true, problems: [],
    ffx_upscaler: { present: true, version: "4.1.1.2740", fsr4_capable: true } };
  const fallbackHost = document.createElement("div"); document.body.appendChild(fallbackHost);
  const fallbackRoot = createRoot(fallbackHost); let protectedChanges = 0;
  await act(async () => fallbackRoot.render(<Fsr4Panel targetDir="/games/lite-fallback" sources={[]}
    gpu={DECK_GPU as any} onBeforeMutation={async () => { protectedChanges++; }} onChanged={() => {}} />));
  await settle(100);
  check("community build explains restoring the DLL before official settings", fallbackHost.textContent?.includes("Selecting a settings preset alone does not restore this DLL"), true);
  const legacyButton = all(fallbackHost, '[data-mock="ButtonItem"]').find((node) => node.textContent?.includes("Use legacy 4.1.1b"));
  check("new community build exposes the legacy fallback", Boolean(legacyButton), true);
  await act(async () => (legacyButton as HTMLElement).click());
  await settle(100);
  check("legacy fallback preserves the install before writing", protectedChanges, 1);
  check("legacy fallback selects the actual old component", installedFsr4Build, "4.1.1b");
  await act(async () => fallbackRoot.unmount()); fallbackHost.remove();
  fixtures.get_fsr4_info = priorInfo; fixtures.verify_install = priorVerify;

  const real = errors.filter((e) => !e.includes("not wrapped in act"));
  console.log(`\nreal React errors: ${real.length}`);
  for (const e of real) console.log(`  ${e}`);
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  // The panel polls; without this the intervals keep node alive for ever.
  await act(async () => root.unmount());
  process.exit(failures > 0 || real.length > 0 ? 1 : 0);
})();
