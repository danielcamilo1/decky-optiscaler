import { useCallback, useEffect, useRef, useState } from "react";
import { getAdaptiveFg, setAdaptiveFg } from "../api";
import type { AdaptiveFgConfig, AdaptiveFgState } from "../types";

export function useAdaptiveFg(targetDir: string | null, enabled = true) {
  const [state, setState] = useState<AdaptiveFgState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeTarget = useRef<string | null>(targetDir);
  activeTarget.current = targetDir;

  const refresh = useCallback(async () => {
    if (!targetDir || !enabled) {
      setState(null);
      return;
    }
    try {
      const result = await getAdaptiveFg(targetDir);
      if (activeTarget.current === targetDir && result && result.config) {
        setState(result);
        setError(null);
      }
    } catch (exc) {
      if (activeTarget.current === targetDir) {
        setError(String(exc));
      }
    }
  }, [targetDir, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = useCallback(
    async (patch: Partial<AdaptiveFgConfig>) => {
      if (!targetDir) return false;
      setSaving(true);
      setError(null);
      try {
        const result = await setAdaptiveFg(targetDir, patch);
        if (!result?.ok) {
          setError(result?.error ?? "Could not save Adaptive FG settings.");
          return false;
        }
        if (activeTarget.current === targetDir && result.config && result.display && result.resolved) {
          setState({
            config: result.config,
            display: result.display,
            resolved: result.resolved,
          });
        }
        return true;
      } catch (exc) {
        if (activeTarget.current === targetDir) {
          setError(String(exc));
        }
        return false;
      } finally {
        if (activeTarget.current === targetDir) {
          setSaving(false);
        }
      }
    },
    [targetDir],
  );

  return {
    state,
    saving,
    error,
    refresh,
    update,
  };
}
