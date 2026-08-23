/**
 * The Steam launch options this plugin writes, and how to take them back out.
 *
 * Installing OptiScaler is two changes, not one: a folder full of files, and a
 * `WINEDLLOVERRIDES` entry in Steam. Removing it used to undo only the first,
 * so a game that had been "removed" still carried an override for a DLL that
 * was no longer there — harmless, but it is litter this plugin left behind and
 * nothing on screen admitted to it.
 *
 * Undoing the second half properly needs to know what was there first, which
 * only Steam can say and only while the plugin is running. `record_launch_options`
 * is therefore called at install time with whatever Steam currently passes, and
 * the answer is kept next to the install. Three things then become tellable
 * apart, which is the whole point:
 *
 * - **recorded and empty** — the game had no launch options at all, so removing
 *   OptiScaler can clear the field outright.
 * - **recorded and not empty** — there is something to put back, verbatim.
 * - **not recorded** — the install predates this, or Steam would not say. Only
 *   the override this plugin recognises is removed; anything else is left, on
 *   the grounds that it is not ours to guess about.
 */
import { recordLaunchOptions } from "./api";
import { readLaunchOptions } from "./hooks/useRunningGame";
import type { LaunchRecord } from "./types";

/** What to do with the launch options when OptiScaler is removed. */
export type LaunchAction = "restore" | "clear" | "keep";

export interface LaunchState {
  /** Steam's current launch options, or null when the client will not say. */
  current: string | null;
  /** What was there before the install, or null when nothing was recorded. */
  recorded: string | null;
  /** The proxy filename OptiScaler is installed as, e.g. `dxgi.dll`. */
  filename: string;
}

export interface LaunchChoice {
  action: LaunchAction;
  label: string;
  description: string;
  /** What Steam would be set to, or null to leave the field untouched. */
  value: string | null;
}

/** The `WINEDLLOVERRIDES` entry an install under this filename adds. */
export function overrideStem(filename: string): string {
  return filename.replace(/\.(dll|asi)$/i, "");
}

export function launchOptionFor(filename: string): string {
  if (filename.toLowerCase().endsWith(".asi")) return "%command%";
  return `WINEDLLOVERRIDES="${overrideStem(filename)}=n,b" %command%`;
}

export function hasOverride(options: string | null, filename: string): boolean {
  if (!options) return false;
  return options.toLowerCase().includes(`${overrideStem(filename).toLowerCase()}=n,b`);
}

/**
 * The same launch options with our override taken out and nothing else.
 *
 * Conservative on purpose: a user may have added `-dx12` or a gamescope
 * wrapper of their own alongside the override, and those are not this plugin's
 * to delete. Only a `WINEDLLOVERRIDES=` assignment naming the proxy we
 * installed is dropped. A leftover bare `%command%` is Steam's own default
 * written out longhand, so that collapses to an empty field.
 */
export function stripOverride(options: string, filename: string): string {
  const stem = overrideStem(filename).toLowerCase();
  const withoutOurs = options.replace(
    /WINEDLLOVERRIDES=(?:"[^"]*"|'[^']*'|\S+)/gi,
    (match) => (match.toLowerCase().includes(`${stem}=`) ? "" : match),
  );
  const collapsed = withoutOurs.replace(/\s+/g, " ").trim();
  return collapsed === "%command%" ? "" : collapsed;
}

/**
 * What the user can be offered when OptiScaler is removed, best answer first.
 *
 * "Put back what was there" is only offered when there was something — which is
 * exactly the condition the question is worth asking under. Clearing is only
 * offered when the result is actually known: either the record says the game
 * had no launch options at all, or Steam is readable and the override we
 * installed is visibly in it. Neither being true means nothing here is ours to
 * touch, so the only answer left is to leave them alone.
 *
 * Two choices that would produce the same launch options are collapsed into
 * one, because a dialog offering the same outcome twice is one nobody can
 * answer.
 */
export function launchChoices(state: LaunchState): LaunchChoice[] {
  const { current, recorded, filename } = state;
  const choices: LaunchChoice[] = [];

  if (recorded !== null && recorded.trim() !== "" && recorded !== current) {
    choices.push({
      action: "restore",
      label: "Put back what was there before",
      description: recorded,
      value: recorded,
    });
  }

  const cleared =
    recorded === ""
      ? ""
      : current !== null && hasOverride(current, filename)
        ? stripOverride(current, filename)
        : null;
  // A choice that would write back what Steam already has is not a choice.
  if (cleared !== null && cleared !== current &&
      !choices.some((choice) => choice.value === cleared)) {
    choices.push({
      action: "clear",
      label: cleared === "" ? "Clear the launch options" : "Remove only the OptiScaler override",
      description:
        cleared === ""
          ? recorded === ""
            ? "This game had none before OptiScaler was installed."
            : "Leaves the launch options empty."
          : `Leaves: ${cleared}`,
      value: cleared,
    });
  }

  choices.push({
    action: "keep",
    label: "Leave them as they are",
    description: current
      ? `Steam keeps passing: ${current}`
      : "Nothing in Steam is changed.",
    value: null,
  });
  return choices;
}

/**
 * The choice to act on, honouring a remembered answer only if it still applies.
 *
 * Undefined when there is nothing to choose between — a game Steam does not
 * own, which has no launch options to decide about at all.
 */
export function resolveChoice(
  choices: LaunchChoice[],
  remembered: LaunchAction | null,
): LaunchChoice | undefined {
  const match = remembered && choices.find((choice) => choice.action === remembered);
  return match || choices[0];
}

/** Whether the removal dialog has anything to ask about at all. */
export function hasLaunchQuestion(appid: string | null, state: LaunchState): boolean {
  if (!appid) return false;
  return launchChoices(state).some((choice) => choice.action !== "keep");
}

/** The record as the backend reports it, as the nullable string the UI reasons in. */
export function recordedValue(record: LaunchRecord | undefined): string | null {
  return record?.recorded ? record.value : null;
}

/**
 * Keep this game's launch options as they were, before we write our own.
 *
 * Called after a successful install and before the override is set, which is
 * the only moment Steam still holds the answer. Write-once in the backend, so
 * calling it again — a reinstall, or the checklist's launch-options toggle
 * being switched back on — cannot overwrite the original with our own override.
 */
export async function recordPreviousLaunchOptions(
  appid: string | null,
  targetDir: string,
): Promise<void> {
  if (!appid) return;
  const current = await readLaunchOptions(Number(appid));
  // Null means the client build will not answer. Recording "" then would be a
  // lie the removal dialog would later act on by clearing a field it never read.
  if (current === null) return;
  try {
    await recordLaunchOptions(targetDir, current);
  } catch {
    /* the record is a convenience; failing to write it must not fail an install */
  }
}
