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
import { createRestorePoint, getLaunchOptions, recordLaunchOptions } from "./api";
import { readLaunchOptions, setLaunchOptions } from "./hooks/useRunningGame";
import { preferRecentLaunchOptions } from "./launchOptionState";
import { t } from "./i18n";
import {
  clearAppliedLaunchMetadata,
  readAppliedLaunchMetadata,
  setAppliedLaunchMetadata,
} from "./prefs";
import type { AppliedLaunchMetadata, LaunchRecord } from "./types";

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

interface ShellToken {
  start: number;
  end: number;
  raw: string;
}

/** Find shell words while keeping the exact source ranges and quoted arguments. */
function shellTokens(source: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length) break;
    const start = index;
    let quote = "";
    while (index < source.length) {
      const char = source[index];
      if (quote) {
        if (char === "\\" && quote === '"' && index + 1 < source.length) {
          index += 2;
          continue;
        }
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (/\s/.test(char)) {
        break;
      }
      index += 1;
    }
    tokens.push({ start, end: index, raw: source.slice(start, index) });
  }
  return tokens;
}

function assignmentValue(raw: string): { prefix: string; value: string; quote: string } | null {
  const match = raw.match(/^([A-Za-z_][A-Za-z0-9_]*=)(.*)$/);
  if (!match) return null;
  const rest = match[2];
  const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : "";
  if (quote) {
    if (rest[rest.length - 1] !== quote) return null;
    const value = rest.slice(1, -1);
    // Concatenated shell fragments and escaped double quotes need shell
    // evaluation to interpret. Keep those forms outside this small parser.
    if (value.includes(quote) || (quote === '"' && value.includes("\\"))) return null;
    return { prefix: match[1], value, quote };
  }
  if (/["']/.test(rest)) return null;
  return { prefix: match[1], value: rest, quote: "" };
}

function isEnvironmentAssignment(raw: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw);
}

function isAssignmentLike(raw: string): boolean {
  return /^["']?[A-Za-z_][A-Za-z0-9_]*=/.test(raw);
}

function simpleWordValue(raw: string): string {
  const quote = raw[0];
  if ((quote === '"' || quote === "'") && raw[raw.length - 1] === quote) {
    const value = raw.slice(1, -1);
    if (!value.includes(quote) && !(quote === '"' && value.includes("\\"))) return value;
  }
  return raw;
}

/**
 * Accept only the plain shell subset this editor can preserve safely. Quoted
 * semicolons are valid Wine override separators; shell control operators,
 * escaped words and command substitutions are deliberately left untouched.
 */
function supportedShellSyntax(source: string): boolean {
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote === "'") {
      if (char === "'") quote = "";
      continue;
    }
    if (quote === '"') {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === '"') quote = "";
      else if (char === "`" || (char === "$" && source[index + 1] === "(")) return false;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\\" || char === "\n" || char === "\r" || /[;&|<>`()]/.test(char)) return false;
    if (char === "#" && (index === 0 || /\s/.test(source[index - 1]))) return false;
    if (char === "$" && source[index + 1] === "(") return false;
  }
  return quote === "";
}

interface EnvironmentPrefix {
  assignments: ShellToken[];
  envToken: ShellToken | null;
  insertionOffset: number;
}

/** Parse leading assignments and one simple `env NAME=value` wrapper. */
function environmentPrefix(source: string): EnvironmentPrefix | null {
  if (!supportedShellSyntax(source)) return null;
  const tokens = shellTokens(source);
  const assignments: ShellToken[] = [];
  let index = 0;
  while (index < tokens.length && isEnvironmentAssignment(tokens[index].raw)) {
    assignments.push(tokens[index]);
    index += 1;
  }

  const command = tokens[index];
  const commandValue = command ? simpleWordValue(command.raw) : "";
  if (commandValue === "env" && command?.raw !== "env") return null;
  let prefix: EnvironmentPrefix;
  if (command?.raw === "env") {
    const envToken = command;
    index += 1;
    const outerCount = assignments.length;
    while (index < tokens.length && isEnvironmentAssignment(tokens[index].raw)) {
      assignments.push(tokens[index]);
      index += 1;
    }
    if (index < tokens.length && (tokens[index].raw.startsWith("-") || isAssignmentLike(tokens[index].raw))) {
      // env options and quoted/otherwise unusual assignment spellings are not
      // interpreted here, since they can change which value reaches the game.
      return null;
    }
    const envAssignments = assignments.slice(outerCount);
    prefix = {
      assignments,
      envToken,
      insertionOffset: envAssignments.length > 0
        ? envAssignments[envAssignments.length - 1].end
        : envToken.end,
    };
  } else {
    if (command && /(?:^|\/)env$/i.test(commandValue)) return null;
    prefix = {
      assignments,
      envToken: null,
      insertionOffset: assignments.length > 0 ? assignments[assignments.length - 1].end : 0,
    };
  }
  const commandPlaceholder = tokens.find((token) => token.raw.toLowerCase() === "%command%");
  const environmentCommands = tokens.filter((token) => {
    if (commandPlaceholder && token.start >= commandPlaceholder.start) return false;
    const value = simpleWordValue(token.raw);
    return value === "env" || /(?:^|\/)env$/i.test(value);
  });
  if (environmentCommands.some((token) => token.start !== prefix.envToken?.start)) return null;
  return prefix;
}

function quoteAssignment(value: string, quote: string): string {
  if (quote === "'" && !value.includes("'")) return `'${value}'`;
  if (quote === '"' || /[;\s]/.test(value)) {
    return `"${value.replace(/[\\"$`]/g, "\\$&")}"`;
  }
  return value;
}

function pluginMode(mode: string): boolean {
  const members = mode.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return members.length === 2 && members[0] === "n" && members[1] === "b";
}

function targetModes(value: string, filename: string): string[] {
  const stem = overrideStem(filename).toLowerCase();
  return value.split(";").flatMap((clause) => {
    const equals = clause.indexOf("=");
    if (equals < 0) return [];
    const names = clause.slice(0, equals).split(",");
    return names.some((name) => name.trim().toLowerCase() === stem)
      ? [clause.slice(equals + 1)]
      : [];
  });
}

function removeLibraryMember(left: string, stem: string): { left: string; found: boolean } {
  const members = Array.from(left.matchAll(/[^,]+/g));
  const targetIndex = members.findIndex(
    (member) => (member[0] ?? "").trim().toLowerCase() === stem,
  );
  if (targetIndex < 0) return { left, found: false };
  const target = members[targetIndex];
  const start = target.index ?? 0;
  const end = start + target[0].length;
  if (members.length === 1) return { left: "", found: true };
  if (targetIndex < members.length - 1) {
    const next = members[targetIndex + 1];
    const nextStart = next.index ?? end;
    return { left: left.slice(0, start) + left.slice(nextStart), found: true };
  }
  const previous = members[targetIndex - 1];
  const previousEnd = (previous.index ?? 0) + previous[0].length;
  const comma = left.indexOf(",", previousEnd);
  return {
    left: left.slice(0, comma < 0 ? start : comma) + left.slice(end),
    found: true,
  };
}

/** Remove only this plugin's exact DLL clause from a Wine override value. */
function withoutOwnedClause(value: string, filename: string): { value: string; found: boolean } {
  const stem = overrideStem(filename).toLowerCase();
  const clauses = value.split(";");
  let found = false;
  const kept = clauses.flatMap((clause) => {
    const equals = clause.indexOf("=");
    if (equals < 0) return [clause];
    const removed = removeLibraryMember(clause.slice(0, equals), stem);
    if (!removed.found) return [clause];
    found = true;
    return removed.left.trim()
      ? [`${removed.left}=${clause.slice(equals + 1)}`]
      : [];
  });
  return { value: found ? kept.join(";") : value, found };
}

function withoutPluginClause(value: string, filename: string): { value: string; found: boolean } {
  const stem = overrideStem(filename).toLowerCase();
  const clauses = value.split(";");
  let found = false;
  const kept = clauses.flatMap((clause) => {
    const equals = clause.indexOf("=");
    if (equals < 0 || !pluginMode(clause.slice(equals + 1))) return [clause];
    const removed = removeLibraryMember(clause.slice(0, equals), stem);
    if (!removed.found) return [clause];
    found = true;
    return removed.left.trim()
      ? [`${removed.left}=${clause.slice(equals + 1)}`]
      : [];
  });
  return { value: found ? kept.join(";") : value, found };
}

function isWineAssignmentToken(token: ShellToken): boolean {
  return /^WINEDLLOVERRIDES=/.test(token.raw);
}

function effectiveWineAssignment(tokens: ShellToken[]): ShellToken | undefined {
  return [...tokens].reverse().find(isWineAssignmentToken);
}

function isSafeWineValue(assignment: { value: string; quote: string }): boolean {
  // Requoting an expanded value would turn it into a different literal value.
  return assignment.quote === "'" || !/[$`]/.test(assignment.value);
}

function renderAssignment(
  assignment: { prefix: string; quote: string },
  value: string,
): string {
  return `${assignment.prefix}${quoteAssignment(value, assignment.quote)}`;
}

function insertAt(source: string, offset: number, word: string): string {
  const before = source.slice(0, offset);
  const after = source.slice(offset);
  const beforeSpace = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const afterSpace = after.length > 0 && !/^\s/.test(after) ? " " : "";
  return `${before}${beforeSpace}${word}${afterSpace}${after}`;
}

export function hasOverride(options: string | null, filename: string): boolean {
  if (!options) return false;
  const prefix = environmentPrefix(options);
  const token = prefix && effectiveWineAssignment(prefix.assignments);
  const assignment = token && assignmentValue(token.raw);
  return Boolean(assignment && targetModes(assignment.value, filename).some(pluginMode));
}

/** Whether every planned game flag is already present in Steam's launch options. */
export function hasLaunchFlags(options: string | null, flags: string[]): boolean {
  const wanted = flags.map((flag) => flag.trim()).filter(Boolean);
  if (wanted.length === 0) return true;
  if (!options) return false;
  const args = gameArgumentTokens(options);
  if (!args) return false;
  const present = new Set(args.map((token) => token.raw));
  return wanted.every((flag) => present.has(flag));
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
  const prefix = environmentPrefix(options);
  if (!prefix) return options;
  let result = options;
  const updates: Array<{ start: number; end: number; value: string }> = [];
  for (const token of prefix.assignments) {
    if (!isWineAssignmentToken(token)) continue;
    const assignment = assignmentValue(token.raw);
    if (!assignment || !isSafeWineValue(assignment)) return options;
    const stripped = withoutPluginClause(assignment.value, filename);
    if (!stripped.found) continue;
    updates.push({
      start: token.start,
      end: token.end,
      value: stripped.value.trim()
        ? renderAssignment(assignment, stripped.value)
        : "",
    });
  }
  for (const update of updates.reverse()) {
    result = result.slice(0, update.start) + update.value + result.slice(update.end);
  }
  if (updates.some((update) => update.start === 0 && update.value === "")) result = result.trimStart();
  return result.trim() === "%command%" ? "" : result;
}

/** Add/update our Wine override and planned flags while preserving other shell text. */
export function mergeLaunchOptions(
  current: string | null,
  filename: string,
  flags: string[] = [],
  additionalOverrides: string[] = [],
): string | null {
  if (current === null) return null;
  const stems = [
    ...(filename.toLowerCase().endsWith(".asi") ? [] : [overrideStem(filename)]),
    ...additionalOverrides.map((item) => overrideStem(item)),
  ];
  return mergeWineOverrides(current, stems, flags);
}

/** Merge exact DLL stems into WINEDLLOVERRIDES and append missing game flags. */
export function mergeWineOverrides(
  current: string | null,
  stems: string[],
  flags: string[] = [],
): string | null {
  if (current === null) return null;
  const wanted = Array.from(new Set(stems.map((stem) => stem.toLowerCase()).filter(Boolean)));
  if (wanted.length === 0 && flags.length === 0) return current;
  const prefix = environmentPrefix(current);
  if (!prefix) return null;
  let merged = current;
  if (wanted.length > 0) {
    const token = effectiveWineAssignment(prefix.assignments);
    if (token) {
      const assignment = assignmentValue(token.raw);
      if (!assignment || !isSafeWineValue(assignment)) return null;
      let remaining = assignment.value;
      for (const stem of wanted) {
        const removed = withoutOwnedClause(remaining, `${stem}.dll`);
        remaining = removed.value;
      }
      const additions = wanted.map((stem) => `${stem}=n,b`).join(";");
      const value = remaining.trim() ? `${remaining};${additions}` : additions;
      const replacement = renderAssignment(assignment, value);
      merged = current.slice(0, token.start) + replacement + current.slice(token.end);
    } else {
      const assignment = `WINEDLLOVERRIDES=${quoteAssignment(
        wanted.map((stem) => `${stem}=n,b`).join(";"),
        '"',
      )}`;
      merged = insertAt(current, prefix.insertionOffset, assignment);
    }
  }
  const withCommand = ensureCommandPlaceholder(merged);
  if (withCommand === null) return null;
  merged = withCommand;
  return mergeFlags(merged, flags);
}

function ensureCommandPlaceholder(source: string): string | null {
  if (!supportedShellSyntax(source)) return null;
  const tokens = shellTokens(source);
  const commandTokens = tokens.filter((token) => token.raw.toLowerCase() === "%command%");
  if (commandTokens.length === 1) return source;
  if (commandTokens.length > 1 || source.toLowerCase().includes("%command%")) return null;
  const argumentsOnly = argumentOnlyTokens(source, tokens);
  if (!argumentsOnly) return null;
  const offset = argumentsOnly[0]?.start ?? source.length;
  return insertAt(source, offset, "%command%");
}

function argumentOnlyTokens(source: string, tokens: ShellToken[]): ShellToken[] | null {
  const prefix = environmentPrefix(source);
  if (!prefix) return null;
  const boundary = Math.max(0, prefix.envToken?.end ?? 0, ...prefix.assignments.map((token) => token.end));
  const argumentsOnly = tokens.filter((token) => token.start >= boundary);
  // Without %command%, only a plain flag/value list is unambiguous.
  return argumentsOnly.length === 0 || /^[+-]/.test(argumentsOnly[0].raw) ? argumentsOnly : null;
}

function gameArgumentTokens(source: string): ShellToken[] | null {
  if (!supportedShellSyntax(source)) return null;
  const tokens = shellTokens(source);
  const commands = tokens.filter((token) => token.raw.toLowerCase() === "%command%");
  if (commands.length > 1 || (commands.length === 0 && source.toLowerCase().includes("%command%"))) return null;
  if (commands.length === 0) return argumentOnlyTokens(source, tokens);
  return tokens.filter((token) => token.start >= commands[0].end);
}

/** Remove the owned DLL clause and any exact wiki flags, preserving other text. */
export function stripLaunchOptions(
  current: string,
  filename: string,
  flags: string[] = [],
  additionalOverrides: string[] = [],
  originalOptions: string | null = null,
): string {
  let result = current;
  const trimmedFilename = filename.trim();
  const stems = [
    ...(trimmedFilename && !trimmedFilename.toLowerCase().endsWith(".asi") ? [trimmedFilename] : []),
    ...additionalOverrides.map((item) => item.trim()).filter(Boolean),
  ];
  for (const stem of stems) {
    const originalPrefix = originalOptions === null ? null : environmentPrefix(originalOptions);
    const originalWine = originalPrefix && effectiveWineAssignment(originalPrefix.assignments);
    const originalAssignment = originalWine && assignmentValue(originalWine.raw);
    const originalModes = originalAssignment
      ? targetModes(originalAssignment.value, stem)
      : [];
    result = stripOverride(result, stem);
    if (originalModes.length > 0) {
      result = mergeOriginalModes(result, stem, originalModes);
    }
  }
  const wanted = new Set(flags.map((flag) => flag.trim()).filter(Boolean));
  if (wanted.size > 0 && originalOptions !== null) {
    const originalArguments = gameArgumentTokens(originalOptions);
    const currentArguments = gameArgumentTokens(result);
    if (!originalArguments || !currentArguments) return result;
    const originalCounts = new Map<string, number>();
    for (const token of originalArguments) {
      originalCounts.set(token.raw, (originalCounts.get(token.raw) ?? 0) + 1);
    }
    const seenCounts = new Map<string, number>();
    const ranges = currentArguments
      .filter((token) => {
        if (!wanted.has(token.raw)) return false;
        const seen = (seenCounts.get(token.raw) ?? 0) + 1;
        seenCounts.set(token.raw, seen);
        return seen > (originalCounts.get(token.raw) ?? 0);
      })
      .map(({ start, end }) => ({ start, end }));
    for (const range of ranges.reverse()) {
      let cutStart = range.start;
      let cutEnd = range.end;
      if (cutStart > 0 && /\s/.test(result[cutStart - 1])) {
        while (cutStart > 0 && /\s/.test(result[cutStart - 1])) cutStart -= 1;
      } else if (cutEnd < result.length && /\s/.test(result[cutEnd])) {
        while (cutEnd < result.length && /\s/.test(result[cutEnd])) cutEnd += 1;
      }
      result = result.slice(0, cutStart) + result.slice(cutEnd);
    }
  }
  return result.trim() === "%command%" ? "" : result;
}

function mergeOriginalModes(current: string, filename: string, modes: string[]): string {
  const wanted = overrideStem(filename).toLowerCase();
  const prefix = environmentPrefix(current);
  if (!prefix) return current;
  const token = effectiveWineAssignment(prefix.assignments);
  const restored = modes.map((mode) => `${wanted}=${mode}`).join(";");
  if (token) {
    const assignment = assignmentValue(token.raw);
    if (!assignment || !isSafeWineValue(assignment)) return current;
    const value = assignment.value.trim() ? `${assignment.value};${restored}` : restored;
    const replacement = renderAssignment(assignment, value);
    return current.slice(0, token.start) + replacement + current.slice(token.end);
  }
  const wineAssignment = `WINEDLLOVERRIDES=${quoteAssignment(restored, '"')}`;
  return insertAt(current, prefix.insertionOffset, wineAssignment);
}

function mergeFlags(current: string, flags: string[]): string | null {
  const gameArguments = gameArgumentTokens(current);
  if (!gameArguments) return null;
  const present = new Set(gameArguments.map((token) => token.raw));
  const missing = flags.map((flag) => flag.trim()).filter((flag) => flag && !present.has(flag));
  if (missing.length === 0) return current;
  const command = shellTokens(current).find((token) => token.raw.toLowerCase() === "%command%");
  if (!command) return null;
  return current.slice(0, command.end) + ` ${missing.join(" ")}` + current.slice(command.end);
}

/**
 * What the user can be offered when OptiScaler is removed, best answer first.
 *
 * "Put back what was there" is only offered when there was something — which is
 * exactly the condition the question is worth asking under. Clearing is offered
 * whenever the result is known: the record says the game had no launch options
 * at all, or the override we installed is visibly in what Steam reports.
 *
 * When neither is true, nothing here is known to be ours — and the honest
 * answer used to be to offer nothing, which is how a client build with no way
 * to read launch options turned this whole feature into a dialog that did
 * nothing. Clearing is offered even then, last and never as the default, and
 * says plainly that it empties the field rather than pruning it. Doing nothing
 * has to be a choice the user makes, not one made for them by a missing API.
 *
 * Two choices that would produce the same launch options are collapsed into
 * one, because a dialog offering the same outcome twice is one nobody can
 * answer.
 */
export function launchChoices(state: LaunchState): LaunchChoice[] {
  const { current, recorded, filename } = state;
  const restore: LaunchChoice[] =
    recorded !== null && recorded.trim() !== "" && recorded !== current
      ? [{
          action: "restore",
          label: t("Put back what was there before"),
          description: recorded,
          value: recorded,
        }]
      : [];

  const keep: LaunchChoice = {
    action: "keep",
    label: t("Leave them as they are"),
    description: current
      ? t("Steam keeps passing: {value}", { value: current })
      : t("Nothing in Steam is changed."),
    value: null,
  };

  // What removing our half would leave behind, when that is knowable.
  const known =
    recorded === ""
      ? ""
      : current !== null && hasOverride(current, filename)
        ? recorded !== null
          ? stripLaunchOptions(current, filename, [], [], recorded)
          : stripOverride(current, filename)
        : null;
  if (known === null) return [...restore, keep];

  const cleared = known;
  const clear: LaunchChoice = {
    action: "clear",
    label: cleared === "" ? t("Clear the launch options") : t("Remove only the OptiScaler override"),
    description: cleared === ""
      ? recorded === ""
        ? t("This game had none before OptiScaler was installed.")
        : t("Leaves the launch options empty.")
      : t("Leaves: {value}", { value: cleared }),
    value: cleared,
  };

  // A choice that would write back what Steam already has, or that lands on
  // the same string as one already on offer, is not a choice.
  const duplicate =
    cleared === current || restore.some((choice) => choice.value === cleared);
  if (duplicate) return [...restore, keep];
  // Blind clearing is a guess, so it never leads — the safe answer does.
  return [...restore, clear, keep];
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
 * What Steam passes this game right now, from whichever source can say.
 *
 * The client is asked first because it is live; Steam only flushes its config
 * file periodically, so a value written seconds ago may not be in it yet. But
 * the client getter is missing from some builds entirely, and on those this
 * was the single point of failure that made the whole feature inert — the
 * plugin could see neither its own override nor anything it had replaced.
 */
export async function currentLaunchOptions(appid: string | null): Promise<string | null> {
  if (!appid) return null;
  const fromClient = await readLaunchOptions(Number(appid));
  if (fromClient !== null) return fromClient;
  try {
    const found = await getLaunchOptions(appid);
    return preferRecentLaunchOptions(appid, found.found ? found.value : null);
  } catch {
    return preferRecentLaunchOptions(appid, null);
  }
}

export interface ReconcileLaunchOptionsInput {
  current: string;
  oldFilename?: string | null;
  nextFilename: string;
  nextFlags: string[];
  nextExtraOverrides: string[];
  persisted: AppliedLaunchMetadata;
  recordedOriginal: string | null;
  applyNext?: boolean;
}

export interface ReconcileLaunchOptionsResult {
  value: string | null;
  removedFlags: string[];
  removedExtraOverrides: string[];
  nextOwned: AppliedLaunchMetadata;
}

function normalizeTokenList(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeOverrideList(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const stem = overrideStem(trimmed).toLowerCase();
    if (!stem || seen.has(stem)) continue;
    seen.add(stem);
    out.push(trimmed);
  }
  return out;
}

/**
 * Reconcile Steam launch options against previously plugin-applied flags and
 * extra overrides while preserving user-managed entries.
 *
 * Only entries explicitly recorded in `persisted` are eligible for removal
 * (plus `oldFilename` when switching proxy filenames or turning launch options
 * off). When `applyNext` is true, ownership of a flag or extra override is only
 * claimed if this plugin already owned it or actually had to add it.
 */
export function reconcileLaunchOptions(
  input: ReconcileLaunchOptionsInput,
): ReconcileLaunchOptionsResult {
  const applyNext = input.applyNext ?? true;
  const nextFlags = applyNext ? normalizeTokenList(input.nextFlags) : [];
  const nextExtraOverrides = applyNext ? normalizeOverrideList(input.nextExtraOverrides) : [];
  const persistedFlags = normalizeTokenList(input.persisted.flags);
  const persistedExtraOverrides = normalizeOverrideList(input.persisted.extraOverrides);

  const trimmedOld = (input.oldFilename ?? "").trim();
  const trimmedNext = input.nextFilename.trim();
  const nextNeedsProxy =
    applyNext && Boolean(trimmedNext) && !trimmedNext.toLowerCase().endsWith(".asi");
  const filenameChanged =
    Boolean(trimmedOld) && (!applyNext || trimmedOld.toLowerCase() !== trimmedNext.toLowerCase());

  const nextFlagSet = new Set(nextFlags);
  const removedFlags = persistedFlags.filter((flag) => !nextFlagSet.has(flag));

  const nextOverrideStems = new Set<string>([
    ...(nextNeedsProxy ? [overrideStem(trimmedNext).toLowerCase()] : []),
    ...nextExtraOverrides.map((item) => overrideStem(item).toLowerCase()),
  ]);
  const removedExtraOverrides = persistedExtraOverrides.filter(
    (item) => !nextOverrideStems.has(overrideStem(item).toLowerCase()),
  );

  const oldProxyToStrip =
    filenameChanged && !trimmedOld.toLowerCase().endsWith(".asi") ? [trimmedOld] : [];
  const stemsToStrip = [...oldProxyToStrip, ...removedExtraOverrides];
  const needsOverrideStrip = stemsToStrip.length > 0;
  const needsFlagStrip = removedFlags.length > 0;
  const needsStrip = needsOverrideStrip || needsFlagStrip;

  if (needsStrip && input.current.trim() !== "") {
    if (needsOverrideStrip) {
      const prefix = environmentPrefix(input.current);
      const safeWine =
        prefix !== null &&
        prefix.assignments.every((token) => {
          if (!isWineAssignmentToken(token)) return true;
          const assignment = assignmentValue(token.raw);
          return Boolean(assignment && isSafeWineValue(assignment));
        });
      if (!safeWine) {
        return {
          value: null,
          removedFlags,
          removedExtraOverrides,
          nextOwned: { flags: persistedFlags, extraOverrides: persistedExtraOverrides },
        };
      }
    }
    if (needsFlagStrip) {
      const currentArgs = gameArgumentTokens(input.current);
      const originalArgs =
        input.recordedOriginal === null ? [] : gameArgumentTokens(input.recordedOriginal);
      if (currentArgs === null || originalArgs === null) {
        return {
          value: null,
          removedFlags,
          removedExtraOverrides,
          nextOwned: { flags: persistedFlags, extraOverrides: persistedExtraOverrides },
        };
      }
    }
  }

  const base = needsStrip
    ? stripLaunchOptions(
        input.current,
        filenameChanged ? trimmedOld : "",
        removedFlags,
        removedExtraOverrides,
        input.recordedOriginal,
      )
    : input.current;

  let nextOwned: AppliedLaunchMetadata;
  if (!applyNext) {
    nextOwned = { flags: [], extraOverrides: [] };
  } else {
    const baseArgs = gameArgumentTokens(base);
    const baseArgSet = new Set((baseArgs ?? []).map((token) => token.raw));
    const persistedFlagSet = new Set(persistedFlags);
    const nextOwnedFlags = nextFlags.filter(
      (flag) => persistedFlagSet.has(flag) || !baseArgSet.has(flag),
    );

    const persistedOverrideStems = new Set(
      persistedExtraOverrides.map((item) => overrideStem(item).toLowerCase()),
    );
    const nextOwnedOverrides = nextExtraOverrides.filter(
      (ov) =>
        persistedOverrideStems.has(overrideStem(ov).toLowerCase()) || !hasOverride(base, ov),
    );
    nextOwned = {
      flags: nextOwnedFlags,
      extraOverrides: nextOwnedOverrides,
    };
  }

  const value = applyNext
    ? mergeLaunchOptions(base, trimmedNext, nextFlags, nextExtraOverrides)
    : base;

  return {
    value,
    removedFlags,
    removedExtraOverrides,
    nextOwned,
  };
}

/**
 * Keep this game's launch options as they were, before we write our own.
 *
 * Called after a successful install and before the override is set, which is
 * the only moment Steam still holds the answer. Write-once in the backend, so
 * calling it again — a reinstall, or the checklist's launch-options toggle
 * being switched back on — cannot overwrite the original with our own override.
 *
 * What the client reads is passed along rather than looked up again in the
 * backend, because it is the fresher of the two; `null` tells the backend to
 * fall back to Steam's config file instead of recording a value nobody read.
 */
export async function preserveOriginalLaunchOptions(
  appid: string | null,
  targetDir: string,
  currentKnown?: string | null,
): Promise<{ ok: boolean; recordedValue: string | null }> {
  if (!appid) return { ok: true, recordedValue: null };
  const current = currentKnown !== undefined ? currentKnown : await currentLaunchOptions(appid);
  if (current === null) return { ok: false, recordedValue: null };
  try {
    const result = await recordLaunchOptions(targetDir, current, appid);
    if (!result.ok || !result.recorded) return { ok: false, recordedValue: null };
    return {
      ok: true,
      recordedValue: typeof result.value === "string" ? result.value : current,
    };
  } catch {
    return { ok: false, recordedValue: null };
  }
}

export async function recordPreviousLaunchOptions(
  appid: string | null,
  targetDir: string,
): Promise<boolean> {
  return (await preserveOriginalLaunchOptions(appid, targetDir)).ok;
}

export interface ApplyManagedLaunchOptionsInput {
  appid: string;
  oldFilename?: string | null;
  nextFilename: string;
  nextFlags: string[];
  nextExtraOverrides: string[];
  recordedOriginal: string | null;
  recordTarget?: string | null;
  skipRecord?: boolean;
  applyNext?: boolean;
  skipIfUnchanged?: boolean;
}

export type ApplyManagedLaunchOptionsResult =
  | { ok: true; value: string; changed: boolean; nextOwned: AppliedLaunchMetadata }
  | {
      ok: false;
      reason:
        | "unreadable"
        | "metadata_unreadable"
        | "preserve_failed"
        | "manual_merge"
        | "steam_rejected";
      value?: string;
    };

/**
 * Read Steam's current launch options, preserve the pre-install value if not
 * yet recorded, reconcile against persisted plugin-owned flags/overrides, write
 * to Steam, and persist the updated ownership metadata only if Steam succeeds.
 */
export async function applyManagedLaunchOptions(
  input: ApplyManagedLaunchOptionsInput,
): Promise<ApplyManagedLaunchOptionsResult> {
  const applyNext = input.applyNext ?? true;
  let latest = await currentLaunchOptions(input.appid);
  if (latest === null) {
    return { ok: false, reason: "unreadable" };
  }

  const persistedResult = await readAppliedLaunchMetadata(input.appid);
  if (!persistedResult.ok) {
    return { ok: false, reason: "metadata_unreadable" };
  }

  let effectiveRecordedOriginal = input.recordedOriginal;
  if (applyNext && !input.skipRecord && effectiveRecordedOriginal === null && input.recordTarget) {
    const preserved = await preserveOriginalLaunchOptions(
      input.appid,
      input.recordTarget,
      latest,
    );
    if (!preserved.ok) {
      return { ok: false, reason: "preserve_failed" };
    }
    effectiveRecordedOriginal = preserved.recordedValue;
    latest = await currentLaunchOptions(input.appid);
    if (latest === null) {
      return { ok: false, reason: "unreadable" };
    }
  }

  const reconciled = reconcileLaunchOptions({
    current: latest,
    oldFilename: input.oldFilename,
    nextFilename: input.nextFilename,
    nextFlags: input.nextFlags,
    nextExtraOverrides: input.nextExtraOverrides,
    persisted: persistedResult.metadata,
    recordedOriginal: effectiveRecordedOriginal,
    applyNext,
  });

  if (reconciled.value === null) {
    return { ok: false, reason: "manual_merge" };
  }

  const changed = reconciled.value !== latest;
  if (!changed && input.skipIfUnchanged) {
    if (applyNext) {
      await setAppliedLaunchMetadata(
        input.appid,
        reconciled.nextOwned.flags,
        reconciled.nextOwned.extraOverrides,
      );
    } else {
      await clearAppliedLaunchMetadata(input.appid);
    }
    return { ok: true, value: reconciled.value, changed: false, nextOwned: reconciled.nextOwned };
  }

  if (!setLaunchOptions(Number(input.appid), reconciled.value)) {
    return { ok: false, reason: "steam_rejected", value: reconciled.value };
  }

  if (applyNext) {
    await setAppliedLaunchMetadata(
      input.appid,
      reconciled.nextOwned.flags,
      reconciled.nextOwned.extraOverrides,
    );
  } else {
    await clearAppliedLaunchMetadata(input.appid);
  }

  return { ok: true, value: reconciled.value, changed, nextOwned: reconciled.nextOwned };
}

/** Snapshot an existing install before a managed file/runtime mutation. */
export async function preserveExistingInstall(
  targetDir: string,
  gamePath: string,
  appid: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const launchOptions = await currentLaunchOptions(appid);
  if (appid && launchOptions === null) {
    return {
      ok: false,
      error: t("Steam did not report the current launch options, so the install was left unchanged."),
    };
  }
  let appliedLaunch: AppliedLaunchMetadata | null = null;
  if (appid) {
    const persisted = await readAppliedLaunchMetadata(appid);
    if (!persisted.ok) {
      return {
        ok: false,
        error: t("Could not read saved launch option records, so the install was left unchanged."),
      };
    }
    appliedLaunch = persisted.metadata;
  }
  try {
    const result = await createRestorePoint(targetDir, gamePath, launchOptions, appliedLaunch);
    return result.ok
      ? result
      : { ok: false, error: result.error ?? t("Could not preserve the current install.") };
  } catch (exc) {
    return { ok: false, error: String(exc) };
  }
}
