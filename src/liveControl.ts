import type {
  LiveApi,
  LiveApplyResult,
  LiveContext,
  LiveStatus,
  OptionChange,
} from "./types";

const API_BACKEND_KEY: Record<LiveApi, string> = {
  dx11: "Upscalers.Dx11Upscaler",
  dx12: "Upscalers.Dx12Upscaler",
  vulkan: "Upscalers.VulkanUpscaler",
};

const UNREADY_STATES = new Set([
  "absent", "disconnected", "failed", "legacy", "loaded", "loading", "searching",
  "unknown", "unsupported", "waiting", "awaiting_config", "awaiting_frame", "queued", "timeout",
]);

export function backendOptionId(api: LiveApi): string {
  return API_BACKEND_KEY[api];
}

/** These values identify a particular active API/runtime list at selection time. */
export function requiresLiveSelectionContext(id: string): boolean {
  return id === "FSR.FGIndex" || id === "FSR.UpscalerIndex" || id.startsWith("Upscalers.");
}

function isLiveApi(api: LiveStatus["active_api"]): api is LiveApi {
  return api === "dx11" || api === "dx12" || api === "vulkan";
}

function isKnownApiOrUnknown(api: LiveStatus["active_api"]): api is LiveApi | "unknown" {
  return isLiveApi(api) || api === "unknown";
}

function statusIdentity(
  status: LiveStatus | null | undefined,
  target: string | null | undefined,
): LiveContext | null {
  if (!target || status?.schema !== 7) return null;
  const session = status.session?.trim();
  const api = status.active_api;
  const capabilityGeneration = status.capability_generation?.trim();
  if (!session || !isKnownApiOrUnknown(api) || !capabilityGeneration) return null;
  return {
    // A ready status has already authenticated the directory. Reuse that
    // canonical identity so contexts returned with actual wire sends compare
    // with the same folder even if the UI was opened through an alias.
    target: status.dir?.trim() || target,
    session,
    active_api: api,
    capability_generation: capabilityGeneration,
  };
}

/** Whether a status snapshot is new enough to bind a command to this game. */
export function currentLiveContext(
  status: LiveStatus | null | undefined,
  target: string | null | undefined,
): LiveContext | null {
  if (
    !target ||
    status?.supported !== true ||
    status.schema !== 7 ||
    status.ready !== true ||
    status.attached !== true ||
    status.asi_current !== true ||
    status.dir_verified !== true ||
    status.dir_matches !== true ||
    UNREADY_STATES.has(status.state) ||
    status.ack === "pending" ||
    status.ack === "timeout"
  ) {
    return null;
  }
  return statusIdentity(status, target);
}

export interface LiveFfxVersionChoice {
  data: string;
  label: string;
  version: string;
  id?: string;
  context: LiveContext | null;
}

/** Build the ordered runtime FFX options used by both Basic and Advanced. */
export function liveFfxVersionChoices(
  status: LiveStatus | null | undefined,
  target: string | null | undefined,
  kind: "fg" | "upscaler",
): LiveFfxVersionChoice[] {
  if (!hasVerifiedLiveRuntime(status) || !status) return [];
  const isFg = kind === "fg";
  const versions = isFg ? status.ffx_fg_versions : status.ffx_upscaler_versions;
  if (!versions?.length) return [];
  const fieldId = isFg ? "FSR.FGIndex" : "FSR.UpscalerIndex";
  const action = isFg ? "change_fg_index" : "change_ffx_upscaler";
  const liveContext = liveContextForField(status, target, fieldId, action);
  const ids = isFg ? status.ffx_fg_ids : status.ffx_upscaler_ids;
  return versions.map((version, index) => {
    const id = ids?.[index];
    return {
      data: String(index),
      label: `FSR ${version}`,
      version,
      id,
      context: liveContext,
    };
  });
}

/** Capture only an explicitly supported live action for the current target. */
export function liveContextForAction(
  status: LiveStatus | null | undefined,
  target: string | null | undefined,
  action: string,
): LiveContext | null {
  const context = currentLiveContext(status, target);
  return context && status?.capabilities?.[action] === true ? context : null;
}

export function liveContextForField(
  status: LiveStatus | null | undefined,
  target: string | null | undefined,
  fieldId: string,
  action: string,
): LiveContext | null {
  const context = currentLiveContext(status, target);
  if (
    !context || !status || !status.live_keys?.includes(fieldId) ||
    status.capabilities?.[fieldId] !== true || status.capabilities?.[action] !== true
  ) return null;
  return context;
}

function keyCapability(status: LiveStatus, id: string, context: LiveContext, value: string): string | null {
  if (!status.live_keys?.includes(id) || status.capabilities?.[id] !== true) return null;
  if (id === "FrameGen.Enabled") {
    if (value.trim().toLowerCase() === "true") {
      return status.can_enable_fg === true && status.capabilities?.fg_enable === true
        ? "fg_enable"
        : null;
    }
    if (value.trim().toLowerCase() === "false") {
      return status.can_change_fg === true ? "set_scalar" : null;
    }
  }
  if (id === "FSR.FGIndex") return "change_fg_index";
  if (id === "FSR.UpscalerIndex") return "change_ffx_upscaler";
  if (id.startsWith("Upscalers.")) {
    return isLiveApi(context.active_api) && id === API_BACKEND_KEY[context.active_api] &&
      status.switchable_backends?.includes(value.toLowerCase())
      ? "switch_upscaler"
      : null;
  }
  return "set_scalar";
}

/**
 * Add the selection-time binding to explicitly live-capable fields. Unknown,
 * legacy, stale, or unsupported states produce an ordinary INI-only change.
 */
export function bindLiveChanges(
  changes: OptionChange[],
  status: LiveStatus | null | undefined,
  target: string | null | undefined,
  options: { omitBackend?: boolean } = {},
): OptionChange[] {
  const context = currentLiveContext(status, target);
  if (!context || !status) return changes.map((change) => ({ ...change }));
  return changes.map((change) => {
    if (change.live_context) return { ...change };
    const id = `${change.section}.${change.key}`;
    // Scalar settings are authorized against the current status at send time.
    // Only API or ordered-list choices need to retain their selection snapshot.
    if (!requiresLiveSelectionContext(id)) return { ...change };
    if (options.omitBackend && id.startsWith("Upscalers.")) return { ...change };
    if (
      change.value.trim().toLowerCase() === "auto" &&
      (id.startsWith("Upscalers.") || status.capabilities?.reset_auto !== true)
    ) return { ...change };
    const action = keyCapability(status, id, context, change.value);
    if (!action || status.capabilities?.[action] !== true) return { ...change };
    return { ...change, live_context: { ...context } };
  });
}

export function isSameLiveContext(
  expected: LiveContext | null | undefined,
  status: LiveStatus | null | undefined,
  target: string | null | undefined,
): boolean {
  if (!expected) return false;
  const current = statusIdentity(status, target);
  return Boolean(
    current &&
      current.target === expected.target &&
      current.session === expected.session &&
      current.active_api === expected.active_api &&
      current.capability_generation === expected.capability_generation,
  );
}

/** Match a past receipt without confusing it with capabilities for a new request. */
export function requestMatchesContext(
  expected: LiveContext | null | undefined,
  status: LiveStatus,
  target: string | null,
): boolean {
  return Boolean(expected && expected.target === (status.dir?.trim() || target) &&
    status.session === expected.session && status.request_session === expected.session &&
    status.request_generation === expected.capability_generation &&
    (status.request_api === "unknown" || status.request_api === expected.active_api));
}

/** Read-only telemetry remains valid while a command is pending or timing out. */
export function hasVerifiedLiveRuntime(
  status: LiveStatus | null | undefined,
): status is LiveStatus {
  return Boolean(
    status &&
      status.supported === true &&
      status.schema === 7 &&
      status.ready === true &&
      status.attached === true &&
      status.asi_current === true &&
      status.dir_matches === true &&
      status.dir_verified === true &&
      status.session &&
      status.capability_generation &&
      isKnownApiOrUnknown(status.active_api),
  );
}

export function confirmedLiveKeys(result: LiveApplyResult | null | undefined): string[] {
  return Array.from(new Set(result?.accepted_keys ?? []));
}

function directoryCounter(value: string | null | undefined): bigint | null {
  return value && /^[1-9][0-9]*$/.test(value) ? BigInt(value) : null;
}

/** A capability change is normal; a newer directory authorization revokes old receipts. */
export function receiptAuthorizationChanged(result: LiveApplyResult, status: LiveStatus): boolean {
  if (!isConfirmedLiveResult(result)) return false;
  const accepted = directoryCounter(result.directory_generation);
  const current = directoryCounter(status.directory_generation);
  if (!accepted || !current || result.session !== status.session) return false;
  return current > accepted || (current === accepted && (
    status.dir_matches === false || status.dir_verified === false ||
    (status.seq === result.seq && status.ack === "rejected")
  ));
}

/** The receipt confirms configuration acceptance, independently of runtime effects. */
export function isConfirmedLiveResult(
  result: LiveApplyResult | null | undefined,
  context?: LiveContext | null,
  requiredKeys?: string[],
): boolean {
  if (
    !result ||
    result.sent !== true ||
    result.confirmed !== true ||
    result.ack !== "config_request_accepted" ||
    !result.session ||
    !result.seq ||
    !result.sent_keys?.length ||
    !directoryCounter(result.directory_generation) ||
    result.accepted_keys?.length !== result.sent_keys.length ||
    new Set(result.accepted_keys).size !== result.sent_keys.length ||
    !result.sent_keys.every((key) => result.accepted_keys?.includes(key)) ||
    !result.context?.target ||
    !result.context.session ||
    !result.context.capability_generation ||
    result.context.session !== result.session
  ) {
    return false;
  }
  if (context && (
    result.context.target !== context.target ||
    result.context.session !== context.session ||
    result.context.active_api !== context.active_api ||
    result.context.capability_generation !== context.capability_generation
  )) return false;
  if (requiredKeys?.length) {
    const applied = new Set(confirmedLiveKeys(result));
    const sent = new Set(result.sent_keys);
    if (!requiredKeys.every((key) => applied.has(key) && sent.has(key))) return false;
  }
  return true;
}

export function liveResultIsComplete(result: LiveApplyResult | null | undefined): boolean {
  return Boolean(
    isConfirmedLiveResult(result) &&
      (result?.deferred?.length ?? 0) === 0 &&
      (result?.failed_keys?.length ?? 0) === 0 &&
      confirmedLiveKeys(result).length > 0,
  );
}

export interface LiveStatusMessage {
  code: "unknown" | "unsupported" | "old" | "wrongdir" | "not-installed" | "load-disabled" | "not-loaded" | "searching" | "awaiting-config" | "awaiting-frame" | "disconnected" | "ready" | "queued" | "rejected" | "timeout" | "failed";
  title: string;
  detail: string;
  tone: "info" | "warn" | "error" | "success";
  ready: boolean;
}

/** One status interpretation shared by settings and running-game surfaces. */
export function liveStatusMessage(status: LiveStatus | null | undefined): LiveStatusMessage {
  if (!status) {
    return {
      code: "unknown",
      title: "Waiting for live status",
      detail: "No status has been reported for this game yet.",
      tone: "info",
      ready: false,
    };
  }
  if (status.dir_matches === false || status.state === "wrongdir") {
    return {
      code: "wrongdir",
      title: "Live control is reporting from another folder",
      detail: status.dir ? `It is writing to ${status.dir}.` : "The reported folder does not match this game.",
      tone: "warn",
      ready: false,
    };
  }
  if (status.asi_current === false || status.state === "old" || status.state === "outdated" || (status.schema !== undefined && status.schema !== null && status.schema < 7)) {
    return {
      code: "old",
      title: "Live control is out of date",
      detail: "This game has a legacy control module. Reinstall it after closing the game.",
      tone: "warn",
      ready: false,
    };
  }
  if (status.state === "unknown" || status.state === "legacy") {
    return {
      code: status.state === "legacy" ? "old" : "unknown",
      title: status.state === "legacy" ? "Live control is out of date" : "Live status is unknown",
      detail: status.reason ?? "This status does not establish a current schema 7 session and capabilities.",
      tone: "warn",
      ready: false,
    };
  }
  if (status.ack === "rejected" || status.state === "rejected") {
    return {
      code: "rejected",
      title: "The game rejected the live change",
      detail: status.error ?? status.reason ?? "Refresh the live status and try the setting again.",
      tone: "error",
      ready: false,
    };
  }
  if (status.ack === "timeout" || status.state === "timeout") {
    return {
      code: "timeout",
      title: "The live change was not confirmed",
      detail: status.error ?? status.reason ?? "The game did not confirm the request before it timed out.",
      tone: "warn",
      ready: false,
    };
  }
  if (status.ack === "pending" || status.state === "queued" || status.state === "pending") {
    return {
      code: "queued",
      title: "Live change is waiting for the game",
      detail: "The request was sent; it has not been confirmed yet.",
      tone: "info",
      ready: false,
    };
  }
  if (!status.asi_available) {
    return {
      code: "unsupported",
      title: "Live control is not included in this build",
      detail: status.reason ?? "Install the matching live-control build before using live settings.",
      tone: "warn",
      ready: false,
    };
  }
  if (status.supported === false && status.can_install !== true) {
    return {
      code: "unsupported",
      title: "This target is not safe to repair with live control",
      detail: status.reason ?? "The managed runtime or installed module could not be verified for this target.",
      tone: "warn",
      ready: false,
    };
  }
  if (!status.asi_installed) {
    return {
      code: "not-installed",
      title: "Live control is not installed for this game",
      detail: "Add the live control module, then restart the game.",
      tone: "info",
      ready: false,
    };
  }
  if (status.load_enabled === false) {
    return {
      code: "load-disabled",
      title: "OptiScaler is not set to load plugins",
      detail: "Enable LoadAsiPlugins in OptiScaler.ini, then restart the game.",
      tone: "warn",
      ready: false,
    };
  }
  if (status.loaded_by_optiscaler === false) {
    return {
      code: "not-loaded",
      title: "OptiScaler did not load the live module",
      detail: "Check the OptiScaler plugin folder and restart the game.",
      tone: "warn",
      ready: false,
    };
  }
  if (status.state === "failed") {
    return {
      code: "failed",
      title: "Live control could not attach",
      detail: status.error ?? status.reason ?? "The running runtime could not be verified.",
      tone: "error",
      ready: false,
    };
  }
  if (status.state === "awaiting_config") {
    return {
      code: "awaiting-config",
      title: "Live control is waiting for OptiScaler",
      detail: status.reason ?? "OptiScaler has not authorized its active configuration yet.",
      tone: "info",
      ready: false,
    };
  }
  if (["searching", "loading", "loaded", "waiting", "attached"].includes(status.state)) {
    return {
      code: "searching",
      title: "Live control is checking the running game",
      detail: status.reason ?? "It will become ready only after the runtime and frame hook are verified.",
      tone: "info",
      ready: false,
    };
  }
  if (status.state === "awaiting_frame") {
    return {
      code: "awaiting-frame",
      title: "Live control is waiting for a frame",
      detail: status.reason ?? "The game has loaded the module, but has not reached a verified frame yet.",
      tone: "info",
      ready: false,
    };
  }
  if (status.attached && status.ready !== true) {
    return {
      code: "awaiting-frame",
      title: "Live control is waiting for a frame",
      detail: "The game has loaded the module, but has not reached a verified frame yet.",
      tone: "info",
      ready: false,
    };
  }
  if (status.supported !== true) {
    const legacyUnknown = status.schema === null || status.schema === undefined || status.asi_current === null;
    return {
      code: legacyUnknown ? "unknown" : "unsupported",
      title: legacyUnknown ? "Live status is from an unknown module" : "Live control is unavailable",
      detail: status.reason ?? "This runtime has no verified live-control capabilities.",
      tone: "warn",
      ready: false,
    };
  }
  if (status.state === "disconnected" || !status.attached) {
    return {
      code: "disconnected",
      title: "Live control is not connected",
      detail: status.error ?? "Start or restart the game to connect live control.",
      tone: "info",
      ready: false,
    };
  }
  const context = currentLiveContext(status, "status-target");
  if (!context) {
    return {
      code: "unknown",
      title: "Live status is not ready to accept changes",
      detail: "Waiting for a fresh schema 7 status with a verified session and capabilities.",
      tone: "info",
      ready: false,
    };
  }
  return {
    code: "ready",
    title: "Connected to the running game",
    detail: "Live configuration requests are available.",
    tone: "success",
    ready: true,
  };
}
