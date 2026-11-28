/**
 * The answers the user asked not to be asked for twice.
 *
 * Two questions in this plugin interrupt something: whether to set the Steam
 * launch options after an install, and what to do with them when OptiScaler is
 * removed. Both carry "Remember my choice", and a remembered answer is applied
 * silently from then on — which is only acceptable if it can be taken back.
 * That is what the Settings tab is for, and why every read goes through here:
 * turning remembering off makes `recall` return nothing at all, so the question
 * comes back without anything having to be un-stored first.
 */
import { getPref, setPref } from "./api";
import { t } from "./i18n";
import type { LaunchAction } from "./launchOptions";
import type { AppliedLaunchMetadata } from "./types";

export { PREF_LANGUAGE } from "./i18n";
export type { AppliedLaunchMetadata } from "./types";

/** Whether answers are remembered at all. Absent means yes. */
export const PREF_REMEMBER = "remember_choices";
/** "always" | "never" — set the launch options after an install? */
export const PREF_INSTALL_LAUNCH = "launch_options";
/** A `LaunchAction` — what to do with them when OptiScaler is removed. */
export const PREF_REMOVE_LAUNCH = "remove_launch_options";

/** The questions the Settings tab can show and forget, in the order it shows them. */
export const REMEMBERED_QUESTIONS: {
  key: string;
  title: string;
  describe: (value: unknown) => string;
}[] = [
  {
    key: PREF_INSTALL_LAUNCH,
    title: "Setting the launch options after an install",
    describe: (value) =>
      value === "always"
        ? t("Set them without asking.")
        : t("Never set them; the game is left as Steam has it."),
  },
  {
    key: PREF_REMOVE_LAUNCH,
    title: "The launch options when OptiScaler is removed",
    describe: (value) =>
      value === "restore"
        ? t("Put back what was there before the install.")
        : value === "clear"
          ? t("Take the OptiScaler override back out.")
          : t("Leave them exactly as they are."),
  },
];

export async function isRemembering(): Promise<boolean> {
  try {
    return (await getPref(PREF_REMEMBER, true)).value !== false;
  } catch {
    return true;
  }
}

/** A stored answer, or null when there is none — or when remembering is off. */
export async function recall(key: string): Promise<unknown | null> {
  if (!(await isRemembering())) return null;
  try {
    const { value } = await getPref(key);
    return value ?? null;
  } catch {
    return null;
  }
}

export async function recallLaunchAction(key: string): Promise<LaunchAction | null> {
  const value = await recall(key);
  return value === "restore" || value === "clear" || value === "keep" ? value : null;
}

/** Store an answer, unless the user has turned remembering off. */
export async function remember(key: string, value: unknown): Promise<void> {
  if (!(await isRemembering())) return;
  try {
    await setPref(key, value);
  } catch {
    /* a preference that will not save is a question asked again, not a failure */
  }
}

export async function forget(key: string): Promise<void> {
  await setPref(key, null);
}

/**
 * Turn remembering on or off.
 *
 * Switching it off also drops what is already stored: leaving the answers in
 * place would mean turning it back on silently restored decisions the user has
 * just said they wanted to be asked about again.
 */
export async function setRemembering(enabled: boolean): Promise<void> {
  await setPref(PREF_REMEMBER, enabled);
  if (!enabled) {
    for (const question of REMEMBERED_QUESTIONS) await forget(question.key);
  }
}

export type ReadAppliedLaunchResult =
  | { ok: true; metadata: AppliedLaunchMetadata }
  | { ok: false };

const PREF_APPLIED_LAUNCH_PREFIX = "applied_launch:";

function appliedLaunchKey(appid: string): string {
  return `${PREF_APPLIED_LAUNCH_PREFIX}${appid}`;
}

function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Normalize an explicit `applied_launch` object from a restore point while
 * preserving `null` for legacy restore points that did not record metadata.
 */
export function normalizeRestoredAppliedLaunch(raw: unknown): AppliedLaunchMetadata | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as { flags?: unknown; extraOverrides?: unknown };
  return {
    flags: normalizeStringList(record.flags),
    extraOverrides: normalizeStringList(record.extraOverrides),
  };
}

/**
 * Read the plugin-applied Steam launch flags and extra DLL overrides persisted
 * for a Steam appid, distinguishing a genuine absence (`{ ok: true }`) from a
 * backend/pref read failure (`{ ok: false }`).
 */
export async function readAppliedLaunchMetadata(
  appid: string | null,
): Promise<ReadAppliedLaunchResult> {
  if (!appid) return { ok: true, metadata: { flags: [], extraOverrides: [] } };
  try {
    const { value } = await getPref(appliedLaunchKey(appid), null);
    const parsed = normalizeRestoredAppliedLaunch(value);
    return { ok: true, metadata: parsed ?? { flags: [], extraOverrides: [] } };
  } catch {
    return { ok: false };
  }
}

/**
 * Best-effort read of the plugin-applied Steam launch metadata for display
 * previews. Mutations must use `readAppliedLaunchMetadata` and fail closed.
 */
export async function getAppliedLaunchMetadata(appid: string | null): Promise<AppliedLaunchMetadata> {
  const result = await readAppliedLaunchMetadata(appid);
  return result.ok ? result.metadata : { flags: [], extraOverrides: [] };
}

export async function setAppliedLaunchMetadata(
  appid: string | null,
  flags: string[],
  extraOverrides: string[],
): Promise<void> {
  if (!appid) return;
  const cleanFlags = normalizeStringList(flags);
  const cleanOverrides = normalizeStringList(extraOverrides);
  try {
    if (cleanFlags.length === 0 && cleanOverrides.length === 0) {
      await setPref(appliedLaunchKey(appid), null);
    } else {
      await setPref(appliedLaunchKey(appid), {
        flags: cleanFlags,
        extraOverrides: cleanOverrides,
      });
    }
  } catch {
    /* best-effort tracking; never fail launch-option mutations */
  }
}

export async function clearAppliedLaunchMetadata(appid: string | null): Promise<void> {
  if (!appid) return;
  try {
    await setPref(appliedLaunchKey(appid), null);
  } catch {
    /* best-effort cleanup */
  }
}
