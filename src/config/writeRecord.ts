import type { ConfigValues, OptionChange } from "../types";

/**
 * What this plugin has written to each OptiScaler.ini, remembered for longer
 * than the component that wrote it.
 *
 * The Quick Access panel is unmounted every time it is closed, which is the
 * normal thing to do after changing a setting — you close it to look at the
 * game. Writes are debounced and flushed on the way out, so reopening the panel
 * starts a fresh read that can be *issued before that write has landed*. The
 * controls then come up showing the value from before the change; do it again
 * and they show the one before that. The panel appears to lag exactly one step
 * behind, while the running game is correct, which is what it did.
 *
 * `useConfig` cannot fix that on its own: its refs die with the instance. So
 * the record lives here. A read is overlaid with anything written since, and an
 * entry is dropped as soon as the file comes back agreeing with it — or once it
 * is old enough that a file still disagreeing means somebody else wrote it,
 * OptiScaler's own overlay Save being the likely one.
 */

const RECENT_MS = 60_000;

interface Written {
  value: string;
  at: number;
  stamp: number;
}

export interface QueuedConfigChange {
  change: OptionChange;
  stamp: number | null;
  revision: number;
}

export interface TargetConfigQueue {
  pending: Map<string, QueuedConfigChange>;
  inFlight: Map<string, QueuedConfigChange>;
  timer: number | null;
  drain: Promise<void> | null;
  revision: number;
  flushWaiters: Map<number, { throughRevision: number; foreground: boolean; errors: string[] }>;
  unobservedFailures: { revision: number; message: string }[];
}

const written = new Map<string, Map<string, Written>>();
const targetQueues = new Map<string, Promise<void>>();
const configQueues = new Map<string, TargetConfigQueue>();
const targetReadEpochs = new Map<string, number>();
let nextStamp = 0;
let nextFlushWaiter = 0;

const now = () => Date.now();
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Note values this plugin has just asked the backend to write. */
export function rememberWrites(dir: string | null, changes: OptionChange[]): number | null {
  if (!dir) return null;
  let record = written.get(dir);
  if (!record) {
    record = new Map();
    written.set(dir, record);
  }
  const at = now();
  const stamp = ++nextStamp;
  for (const change of changes) {
    record.set(`${change.section}.${change.key}`, { value: change.value, at, stamp });
  }
  return stamp;
}

/** Drop keys the backend refused: they were never written, so never ours. */
export function forgetWrites(dir: string | null, changes?: OptionChange[], stamp?: number | null) {
  if (!dir) return;
  if (!changes) {
    written.delete(dir);
    return;
  }
  const record = written.get(dir);
  if (!record) return;
  for (const change of changes) {
    const id = `${change.section}.${change.key}`;
    if (stamp == null || record.get(id)?.stamp === stamp) record.delete(id);
  }
  if (record.size === 0) written.delete(dir);
}

/** Serialize config writes and other INI mutations for one install directory. */
export function serializeTargetWrite<T>(dir: string, operation: () => Promise<T>): Promise<T> {
  const previous = targetQueues.get(dir) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  targetQueues.set(dir, settled);
  void settled.then(() => {
    if (targetQueues.get(dir) === settled) targetQueues.delete(dir);
  });
  return result;
}

/** Wait until all config writes queued before this call have settled. */
export async function waitForTargetWrites(dir: string): Promise<void> {
  await targetQueues.get(dir);
}

/** A single debounced config queue shared by every panel editing this target. */
export function getTargetConfigQueue(dir: string): TargetConfigQueue {
  let queue = configQueues.get(dir);
  if (!queue) {
    queue = {
      pending: new Map(),
      inFlight: new Map(),
      timer: null,
      drain: null,
      revision: 0,
      flushWaiters: new Map(),
      unobservedFailures: [],
    };
    configQueues.set(dir, queue);
  }
  return queue;
}

/** Queue changes under one target-wide revision and clear superseded errors. */
export function queueTargetChanges(
  dir: string,
  changes: OptionChange[],
  stamp: number | null,
): TargetConfigQueue {
  const queue = getTargetConfigQueue(dir);
  for (const change of changes) {
    const id = `${change.section}.${change.key}`;
    const revision = ++queue.revision;
    queue.pending.set(id, { change, stamp, revision });
  }
  return queue;
}

/** Register the callers that must receive failures from writes they are waiting on. */
export function beginTargetFlush(
  queue: TargetConfigQueue,
  throughRevision: number,
  foreground: boolean,
): number {
  const id = ++nextFlushWaiter;
  const errors: string[] = [];
  if (foreground) {
    const remaining: typeof queue.unobservedFailures = [];
    for (const failure of queue.unobservedFailures) {
      if (failure.revision <= throughRevision) errors.push(failure.message);
      else remaining.push(failure);
    }
    queue.unobservedFailures = remaining;
  }
  queue.flushWaiters.set(id, { throughRevision, foreground, errors });
  return id;
}

/** Deliver a failure only to flushes that were waiting for that batch. */
export function failTargetChanges(
  queue: TargetConfigQueue,
  changes: QueuedConfigChange[],
  message: string,
) {
  let delivered = false;
  for (const waiter of queue.flushWaiters.values()) {
    if (waiter.foreground && changes.some((item) => item.revision <= waiter.throughRevision)) {
      waiter.errors.push(message);
      delivered = true;
    }
  }
  if (!delivered) {
    queue.unobservedFailures.push({
      revision: Math.max(...changes.map((item) => item.revision)),
      message,
    });
  }
}

/** Consume this caller's result so a later, unrelated flush can proceed. */
export function finishTargetFlush(queue: TargetConfigQueue, id: number): string[] {
  const waiter = queue.flushWaiters.get(id);
  queue.flushWaiters.delete(id);
  return waiter?.errors ?? [];
}

/** Snapshot the mutation epoch without invalidating other panels' initial reads. */
export function beginTargetRead(dir: string): number {
  return targetReadEpochs.get(dir) ?? 0;
}

export function invalidateTargetReads(dir: string): number {
  const next = (targetReadEpochs.get(dir) ?? 0) + 1;
  targetReadEpochs.set(dir, next);
  return next;
}

export function isCurrentTargetRead(dir: string, sequence: number): boolean {
  return (targetReadEpochs.get(dir) ?? 0) === sequence;
}

/**
 * A freshly-read file with anything newer this plugin wrote laid back over it.
 *
 * Entries retire themselves: once the file agrees, the record has served its
 * purpose, and after `RECENT_MS` a file that still disagrees is taken at its
 * word rather than argued with for ever.
 */
export function overlayWrites(dir: string | null, values: ConfigValues): ConfigValues {
  const record = dir ? written.get(dir) : undefined;
  if (!record || record.size === 0) return values;

  const cutoff = now() - RECENT_MS;
  const next: ConfigValues = {};
  for (const [section, keys] of Object.entries(values)) next[section] = { ...keys };

  for (const [id, entry] of Array.from(record)) {
    const split = id.indexOf(".");
    const section = id.slice(0, split);
    const key = id.slice(split + 1);
    const onDisk = values[section]?.[key];
    if (onDisk !== undefined && same(onDisk, entry.value)) {
      record.delete(id);
      continue;
    }
    if (entry.at < cutoff) {
      record.delete(id);
      continue;
    }
    next[section] = { ...(next[section] ?? {}), [key]: entry.value };
  }
  if (record.size === 0 && dir) written.delete(dir);
  return next;
}
