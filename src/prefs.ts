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
import type { LaunchAction } from "./launchOptions";

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
        ? "Set them without asking."
        : "Never set them; the game is left as Steam has it.",
  },
  {
    key: PREF_REMOVE_LAUNCH,
    title: "The launch options when OptiScaler is removed",
    describe: (value) =>
      value === "restore"
        ? "Put back what was there before the install."
        : value === "clear"
          ? "Take the OptiScaler override back out."
          : "Leave them exactly as they are.",
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
