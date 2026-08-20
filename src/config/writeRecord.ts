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
}

const written = new Map<string, Map<string, Written>>();

const now = () => Date.now();
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Note values this plugin has just asked the backend to write. */
export function rememberWrites(dir: string | null, changes: OptionChange[]) {
  if (!dir) return;
  let record = written.get(dir);
  if (!record) {
    record = new Map();
    written.set(dir, record);
  }
  const at = now();
  for (const change of changes) {
    record.set(`${change.section}.${change.key}`, { value: change.value, at });
  }
}

/** Drop keys the backend refused: they were never written, so never ours. */
export function forgetWrites(dir: string | null, changes?: OptionChange[]) {
  if (!dir) return;
  if (!changes) {
    written.delete(dir);
    return;
  }
  const record = written.get(dir);
  if (!record) return;
  for (const change of changes) record.delete(`${change.section}.${change.key}`);
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
