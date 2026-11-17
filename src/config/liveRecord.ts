import type { LiveApplyResult } from "../types";
import type { LiveContext } from "../types";

export interface PendingLiveChange {
  target: string;
  session: string;
  seq: string;
  /** Status requests started at or before this epoch cannot retire this send. */
  statusEpoch: number;
  keys: string[];
  values: Record<string, string>;
  revisions: Record<string, number>;
  contexts: Record<string, LiveContext>;
}

export interface TargetLiveRecord {
  restartKeys: string[];
  livePending: PendingLiveChange[];
  live: LiveApplyResult | null;
  /** Last values and target-wide revisions confirmed written to the INI. */
  persistedValues: Record<string, string>;
  persistedRevisions: Record<string, number>;
  /** Old status replies at or below this epoch cannot restore a cleared receipt. */
  statusEpoch?: number;
}

const records = new Map<string, TargetLiveRecord>();
const listeners = new Map<string, Set<() => void>>();
const statusRequestEpochs = new Map<string, number>();
const targetsByAppId = new Map<string, string>();

/** Monotonic per-target request order shared by every mounted live-status hook. */
export function beginTargetLiveStatusRequest(target: string): number {
  const epoch = (statusRequestEpochs.get(target) ?? 0) + 1;
  statusRequestEpochs.set(target, epoch);
  return epoch;
}

export function getTargetLiveStatusRequestEpoch(target: string): number {
  return statusRequestEpochs.get(target) ?? 0;
}

function copy(record: TargetLiveRecord): TargetLiveRecord {
  return {
    restartKeys: [...record.restartKeys],
    livePending: record.livePending.map((entry) => ({
      ...entry,
      keys: [...entry.keys],
      values: { ...entry.values },
      revisions: { ...entry.revisions },
      contexts: Object.fromEntries(Object.entries(entry.contexts).map(([key, context]) => [key, { ...context }])),
    })),
    live: record.live ? { ...record.live } : null,
    persistedValues: { ...record.persistedValues },
    persistedRevisions: { ...record.persistedRevisions },
    statusEpoch: record.statusEpoch ?? 0,
  };
}

export function getTargetLiveRecord(target: string): TargetLiveRecord {
  const record = records.get(target);
  return record ? copy(record) : {
    restartKeys: [], livePending: [], live: null,
    persistedValues: {}, persistedRevisions: {},
    statusEpoch: 0,
  };
}

export function setTargetLiveRecord(target: string, record: TargetLiveRecord): void {
  if (
    record.restartKeys.length === 0 && record.livePending.length === 0 && !record.live &&
    Object.keys(record.persistedValues).length === 0 && Object.keys(record.persistedRevisions).length === 0 &&
    !record.statusEpoch
  ) {
    records.delete(target);
  } else {
    records.set(target, copy(record));
  }
  for (const listener of listeners.get(target) ?? []) listener();
}

/** Mutate the shared per-target state before any component-local React update. */
export function updateTargetLiveRecord(
  target: string,
  update: (current: TargetLiveRecord) => TargetLiveRecord,
): TargetLiveRecord {
  const next = update(getTargetLiveRecord(target));
  setTargetLiveRecord(target, next);
  return getTargetLiveRecord(target);
}

/** Keep Steam's app identity attached to its currently managed install. */
export function rememberTargetForAppId(target: string, appid: string): void {
  if (target && appid && appid !== "0") targetsByAppId.set(appid, target);
}

function invalidateTargetStatuses(target: string): number {
  const epoch = Math.max(
    getTargetLiveStatusRequestEpoch(target),
    getTargetLiveRecord(target).statusEpoch ?? 0,
  ) + 1;
  statusRequestEpochs.set(target, epoch);
  return epoch;
}

/** Clear target receipts when Steam confirms a new process start. */
export function clearTargetAfterSteamRestart(appid: string): void {
  if (!appid || appid === "0") return;
  const target = targetsByAppId.get(appid);
  if (!target) return;
  const statusEpoch = invalidateTargetStatuses(target);
  updateTargetLiveRecord(target, (stored) => ({
    ...stored,
    restartKeys: [],
    livePending: [],
    live: null,
    statusEpoch,
  }));
}

/** A stopped-game file mutation leaves no live receipt or restart warning to reconcile. */
export function clearTargetLiveActions(target: string): void {
  updateTargetLiveRecord(target, (stored) => ({
    ...stored,
    restartKeys: [],
    livePending: [],
    live: null,
  }));
}

/** Clear target state after file replacement; Remove can also drop the Steam mapping. */
export function forgetTargetLiveRecord(target: string, removeAppMapping = false): void {
  const statusEpoch = invalidateTargetStatuses(target);
  setTargetLiveRecord(target, {
    restartKeys: [], livePending: [], live: null,
    persistedValues: {}, persistedRevisions: {}, statusEpoch,
  });
  if (removeAppMapping) {
    for (const [appid, mappedTarget] of targetsByAppId) {
      if (mappedTarget === target) targetsByAppId.delete(appid);
    }
  }
}

export function subscribeTargetLiveRecord(target: string, listener: () => void): () => void {
  let targetListeners = listeners.get(target);
  if (!targetListeners) {
    targetListeners = new Set();
    listeners.set(target, targetListeners);
  }
  targetListeners.add(listener);
  return () => {
    targetListeners?.delete(listener);
    if (targetListeners?.size === 0) listeners.delete(target);
  };
}
