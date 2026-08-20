import { useCallback, useEffect, useRef, useState } from "react";
import { readConfig, writeConfig } from "../api";
import { AUTO } from "../config/values";
import { optionsInSection } from "../config/tabs";
import type { ConfigValues, LiveApplyResult, OptionChange, OptionMeta } from "../types";

const FLUSH_DELAY_MS = 400;

const changeId = (change: OptionChange) => `${change.section}.${change.key}`;

/**
 * Edits OptiScaler.ini for one install directory.
 *
 * Values update locally straight away and are flushed to disk on a short
 * debounce, so dragging a slider does not issue a write per frame.
 *
 * Two things follow from that gap between the screen and the file, and both are
 * what a control showing the wrong value comes down to:
 *
 * - A read that lands while an edit is queued or in flight is reading a file
 *   that does not have the edit in it yet. `overlay` puts the newer values back
 *   on top, so the control never reverts to the option the user just changed
 *   away from.
 * - A value the backend will not take never reaches the file *or* the running
 *   game, so leaving it on screen is the UI claiming a change that exists
 *   nowhere. Rejections put the option back to what the file says and are
 *   reported.
 */
export function useConfig(targetDir: string | null, enabled: boolean, reloadKey?: unknown) {
  const [values, setValues] = useState<ConfigValues>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [live, setLive] = useState<LiveApplyResult | null>(null);

  /** Edited, waiting for the debounce. */
  const pending = useRef<Map<string, OptionChange>>(new Map());
  /** Sent to the backend, not yet answered. */
  const inFlight = useRef<Map<string, OptionChange>>(new Map());
  const timer = useRef<number | null>(null);
  /** Which target has been read at least once, so a refresh can stay quiet. */
  const seen = useRef<string | null>(null);

  /** A freshly-read file with every edit newer than it laid back on top. */
  const overlay = useCallback((base: ConfigValues): ConfigValues => {
    const next: ConfigValues = {};
    for (const [section, keys] of Object.entries(base)) next[section] = { ...keys };
    for (const newer of [inFlight.current, pending.current]) {
      for (const change of newer.values()) {
        next[change.section] = { ...(next[change.section] ?? {}), [change.key]: change.value };
      }
    }
    return next;
  }, []);

  const load = useCallback(async () => {
    if (!targetDir || !enabled) return;
    // Only the first read of a target blanks the panel. A refresh keeps the
    // controls on screen, because unmounting them throws away what the user is
    // half way through — the upscaler they just picked, and with it the live
    // switch button that only appears once one has been.
    if (seen.current !== targetDir) setLoading(true);
    setError(null);
    try {
      const result = await readConfig(targetDir);
      if (result.ok) {
        seen.current = targetDir;
        setValues(overlay(result.values));
      } else {
        setError(result.error ?? "Could not read OptiScaler.ini");
        setValues({});
      }
    } catch (exc) {
      setError(String(exc));
    } finally {
      setLoading(false);
    }
  }, [targetDir, enabled, overlay]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const flush = useCallback(async () => {
    if (!targetDir || pending.current.size === 0) return;
    const changes = Array.from(pending.current.values());
    pending.current.clear();
    for (const change of changes) inFlight.current.set(changeId(change), change);
    setSaving(true);
    try {
      const result = await writeConfig(targetDir, changes);
      if (!result.ok) setError(result.error ?? "Write failed");

      // A change the running game already adopted needs no restart, so only
      // raise the restart flag for the parts that could not be applied live.
      const applied = result.live ?? null;
      setLive(applied);
      const fullyLive =
        Boolean(applied?.sent) && (applied?.deferred?.length ?? 0) === 0;
      if (!fullyLive) setDirty(true);

      const rejected = result.rejected ?? [];
      if (rejected.length > 0) {
        // Out of the in-flight set first: the re-read below has to be allowed
        // to bring these keys back to whatever the file actually holds.
        for (const change of rejected) inFlight.current.delete(changeId(change));
        // Put the controls back first — the read clears the error line, so
        // saying why has to come after it.
        await load();
        setError(
          `OptiScaler would not accept ${rejected
            .map((change) => `${change.key}=${change.value}`)
            .join(", ")}`
        );
      }
    } catch (exc) {
      setError(String(exc));
    } finally {
      // Keep anything a newer edit has replaced in the meantime.
      for (const change of changes) {
        const id = changeId(change);
        if (inFlight.current.get(id) === change) inFlight.current.delete(id);
      }
      setSaving(false);
    }
  }, [targetDir, load]);

  const queue = useCallback(
    (changes: OptionChange[]) => {
      for (const change of changes) {
        pending.current.set(changeId(change), change);
      }
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), FLUSH_DELAY_MS);
    },
    [flush]
  );

  const setOption = useCallback(
    (option: OptionMeta, value: string) => {
      setValues((current) => ({
        ...current,
        [option.section]: { ...(current[option.section] ?? {}), [option.key]: value },
      }));
      queue([{ section: option.section, key: option.key, value }]);
    },
    [queue]
  );

  /** Apply several keys at once, for Basic mode's composite controls. */
  const setOptions = useCallback(
    (changes: OptionChange[]) => {
      if (changes.length === 0) return;
      setValues((current) => {
        const next = { ...current };
        for (const item of changes) {
          next[item.section] = { ...(next[item.section] ?? {}), [item.key]: item.value };
        }
        return next;
      });
      queue(changes);
    },
    [queue]
  );

  const resetSection = useCallback(
    (section: string) => {
      const options = optionsInSection(section);
      setValues((current) => {
        const next = { ...(current[section] ?? {}) };
        for (const option of options) next[option.key] = AUTO;
        return { ...current, [section]: next };
      });
      queue(options.map((option) => ({ section, key: option.key, value: AUTO })));
    },
    [queue]
  );

  // Never leave edits sitting in the debounce buffer when the view goes away.
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      void flush();
    };
  }, [flush]);

  return {
    values,
    loading,
    error,
    dirty,
    saving,
    live,
    setOption,
    setOptions,
    resetSection,
    reload: load,
    clearDirty: () => setDirty(false),
    clearLive: () => setLive(null),
  };
}
