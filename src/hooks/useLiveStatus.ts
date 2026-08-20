import { useCallback, useEffect, useState } from "react";
import { getLiveStatus } from "../api";
import type { LiveStatus } from "../types";

const POLL_MS = 4000;

/**
 * Tracks whether the in-game live-control plugin is answering for this install.
 *
 * It only reports "attached" while the ASI is loaded in a running game, so the
 * UI can tell the difference between a setting that took effect immediately and
 * one that is waiting for a restart.
 */
export function useLiveStatus(targetDir: string | null, active: boolean) {
  const [status, setStatus] = useState<LiveStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!targetDir) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await getLiveStatus(targetDir));
    } catch {
      /* the panel just shows the restart path instead */
    }
  }, [targetDir]);

  useEffect(() => {
    void refresh();
    if (!active || !targetDir) return;
    // Only poll while the game is running; there is nothing to watch otherwise.
    const handle = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(handle);
  }, [refresh, active, targetDir]);

  return { status, refresh };
}
