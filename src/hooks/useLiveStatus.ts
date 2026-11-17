import { useCallback, useEffect, useRef, useState } from "react";
import { getLiveStatus } from "../api";
import { beginTargetLiveStatusRequest } from "../config/liveRecord";
import type { LiveStatus } from "../types";

const POLL_MS = 4000;

/** Tracks live support and connection state for one install, ignoring stale replies. */
export function useLiveStatus(targetDir: string | null, active: boolean) {
  const [snapshot, setSnapshot] = useState<{
    target: string | null;
    status: LiveStatus | null;
    statusEpoch: number | null;
  }>({
    target: null,
    status: null,
    statusEpoch: null,
  });
  const targetRef = useRef(targetDir);
  targetRef.current = targetDir;
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const target = targetDir;
    const sequence = ++request.current;
    if (!target) {
      setSnapshot({ target: null, status: null, statusEpoch: null });
      return;
    }
    const statusEpoch = beginTargetLiveStatusRequest(target);
    try {
      const status = await getLiveStatus(target);
      if (targetRef.current === target && request.current === sequence) {
        setSnapshot({ target, status, statusEpoch });
      }
    } catch {
      if (targetRef.current === target && request.current === sequence) {
        setSnapshot((current) => current.target === target && current.status
          ? {
              target,
              status: {
                ...current.status,
                attached: false,
                ready: false,
                state: "disconnected",
                ack: undefined,
                accepted_keys: [],
                failed_keys: [],
                error: "Could not refresh live status for this game.",
              },
              statusEpoch: null,
            }
          : current);
      }
    }
  }, [targetDir]);

  useEffect(() => {
    void refresh();
    if (!active || !targetDir) return;
    const handle = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(handle);
  }, [refresh, active, targetDir]);

  return {
    status: snapshot.target === targetDir ? snapshot.status : null,
    statusEpoch: snapshot.target === targetDir ? snapshot.statusEpoch : null,
    refresh,
  };
}
