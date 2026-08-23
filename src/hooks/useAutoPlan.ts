import { useCallback, useEffect, useRef, useState } from "react";
import { getAutoPlan, getWikiStatus, setAutoMode } from "../api";
import type { AutoPlan, Recommendation } from "../types";

/** How long to keep watching for a background refresh, and how often. */
const WATCH_INTERVAL_MS = 2000;
const WATCH_ATTEMPTS = 10;

/**
 * The wiki's set-up plan for one game, plus whether the user has asked for it.
 *
 * Three surfaces need this — the Setup tab, the Settings tab and the Quick
 * Access panel — and all three ask the same question of the same game, so it
 * lives here rather than being fetched three ways. The backend answers from its
 * wiki cache, so repeating the call is cheap.
 *
 * `auto` is deliberately separate from `plan.available`: a plan can exist for a
 * game whose owner would rather set it up by hand, and switching automatic mode
 * off must not make the plan disappear from view.
 *
 * The answer is always the cached list, which is why it arrives at once even on
 * a Deck with no route to the wiki. When that cache is old the backend
 * refreshes it behind the answer, and this then watches for the result: the
 * list carries a content fingerprint, so "something new arrived" is exactly
 * "the fingerprint changed", and the plan is quietly rebuilt when it does. A
 * refresh that brings back the same list — the usual outcome — redraws nothing.
 */
export function useAutoPlan(
  gamePath: string | null,
  gameName: string | null,
  enabled = true
) {
  const [plan, setPlan] = useState<AutoPlan | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(false);
  /** The fingerprint of the list this plan was built from, and whether a
   *  refresh that could change it is running. */
  const [revision, setRevision] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  // Reloading must not re-run the effect that reloads.
  const reload = useRef<(force?: boolean) => Promise<void>>(async () => {});

  const load = useCallback(
    async (force = false) => {
      if (!gamePath || !enabled) {
        setPlan(null);
        setRecommendation(null);
        return;
      }
      setLoading(true);
      try {
        // The install folder's name is often the only thing that matches the
        // wiki, so it is searched alongside the Steam title — the same pair the
        // Setup tab has always used.
        const folder = gamePath.split("/").filter(Boolean).pop() ?? gameName ?? "";
        const result = await getAutoPlan(gameName ?? folder, [folder], force, gamePath);
        setPlan(result.plan);
        setRecommendation(result.recommendation);
        setAuto(Boolean(result.plan.enabled));
        const meta = result.recommendation?.list_meta;
        setRevision(meta?.revision ?? null);
        // Only worth watching when the list behind this answer is old enough
        // for the backend to be refreshing it.
        setWatching(Boolean(meta?.stale));
      } catch {
        // A wiki lookup that fails is not an error the user can act on here;
        // the Setup tab reports it in full, and everything else simply carries
        // on without an automatic option.
        setPlan(null);
        setRecommendation(null);
        setWatching(false);
      } finally {
        setLoading(false);
      }
    },
    [gamePath, gameName, enabled]
  );

  useEffect(() => {
    reload.current = load;
  }, [load]);

  useEffect(() => {
    void load(false);
  }, [load]);

  /**
   * Watch for the refresh running behind the answer already given.
   *
   * Bounded on purpose: a handful of cheap reads of the cached status, and it
   * stops as soon as the refresh finishes — whether or not it brought anything
   * new. It is not a poll of the wiki; nothing here goes to the network.
   */
  useEffect(() => {
    if (!watching) return;
    let live = true;
    let attempts = 0;
    const timer = window.setInterval(() => {
      void (async () => {
        attempts += 1;
        let status;
        try {
          status = await getWikiStatus(false);
        } catch {
          if (live) setWatching(false);
          return;
        }
        if (!live) return;
        if (status.revision && status.revision !== revision) {
          // Something new: rebuild this game's plan from it. `load` sets the
          // new fingerprint, which ends this watch.
          setWatching(false);
          void reload.current(false);
          return;
        }
        if (!status.revalidating || attempts >= WATCH_ATTEMPTS) setWatching(false);
      })();
    }, WATCH_INTERVAL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [watching, revision]);

  const changeAuto = useCallback(
    async (value: boolean) => {
      setAuto(value);
      if (gamePath) await setAutoMode(gamePath, value);
    },
    [gamePath]
  );

  return {
    plan,
    recommendation,
    loading,
    auto,
    setAuto: changeAuto,
    reload: load,
    /** True while a background refresh could still change this answer. */
    refreshing: watching,
  };
}
