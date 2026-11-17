/**
 * Steam can report its launch-options file before it has flushed a value just
 * accepted by SetAppLaunchOptions. Keep that acknowledged value briefly so a
 * remounted Setup panel cannot mistake the old disk copy for the current one.
 */
const RECENT_WRITE_MS = 60_000;
const recent = new Map<string, { value: string; at: number }>();

export function rememberLaunchOptions(appid: string | number, value: string) {
  recent.set(String(appid), { value, at: Date.now() });
}

/** Prefer a recent Steam write until a fresh read agrees or the record expires. */
export function preferRecentLaunchOptions(
  appid: string | number,
  observed: string | null,
): string | null {
  const id = String(appid);
  const saved = recent.get(id);
  if (!saved) return observed;
  if (Date.now() - saved.at > RECENT_WRITE_MS) {
    recent.delete(id);
    return observed;
  }
  if (observed === saved.value) {
    recent.delete(id);
    return observed;
  }
  return saved.value;
}
