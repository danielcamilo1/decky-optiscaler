import { useCallback, useEffect, useState } from "react";
import { getAutoPlan, setAutoMode } from "../api";
import type { AutoPlan, Recommendation } from "../types";

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
      } catch {
        // A wiki lookup that fails is not an error the user can act on here;
        // the Setup tab reports it in full, and everything else simply carries
        // on without an automatic option.
        setPlan(null);
        setRecommendation(null);
      } finally {
        setLoading(false);
      }
    },
    [gamePath, gameName, enabled]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const changeAuto = useCallback(
    async (value: boolean) => {
      setAuto(value);
      if (gamePath) await setAutoMode(gamePath, value);
    },
    [gamePath]
  );

  return { plan, recommendation, loading, auto, setAuto: changeAuto, reload: load };
}
