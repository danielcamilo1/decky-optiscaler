import { useCallback, useEffect, useRef, useState } from "react";
import { readConfig, writeConfig } from "../api";
import { AUTO } from "../config/values";
import { optionsInSection } from "../config/tabs";
import type { ConfigValues, LiveApplyResult, OptionChange, OptionMeta } from "../types";

const FLUSH_DELAY_MS = 400;

/**
 * Edits OptiScaler.ini for one install directory.
 *
 * Values update locally straight away and are flushed to disk on a short
 * debounce, so dragging a slider does not issue a write per frame.
 */
export function useConfig(targetDir: string | null, enabled: boolean, reloadKey?: unknown) {
  const [values, setValues] = useState<ConfigValues>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [live, setLive] = useState<LiveApplyResult | null>(null);

  const pending = useRef<Map<string, OptionChange>>(new Map());
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!targetDir || !enabled) return;
    setLoading(true);
    setError(null);
    try {
      const result = await readConfig(targetDir);
      if (result.ok) {
        setValues(result.values);
      } else {
        setError(result.error ?? "Could not read OptiScaler.ini");
        setValues({});
      }
    } catch (exc) {
      setError(String(exc));
    } finally {
      setLoading(false);
    }
  }, [targetDir, enabled]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const flush = useCallback(async () => {
    if (!targetDir || pending.current.size === 0) return;
    const changes = Array.from(pending.current.values());
    pending.current.clear();
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
    } catch (exc) {
      setError(String(exc));
    } finally {
      setSaving(false);
    }
  }, [targetDir]);

  const queue = useCallback(
    (changes: OptionChange[]) => {
      for (const change of changes) {
        pending.current.set(`${change.section}.${change.key}`, change);
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
