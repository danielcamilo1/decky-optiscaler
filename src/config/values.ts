import type { ConfigValues, OptionMeta } from "../types";
import { curatedLabel } from "./labels";

export const AUTO = "auto";

/** The raw INI value for an option, or "auto" when unset. */
export function rawValue(values: ConfigValues, option: OptionMeta): string {
  return values[option.section]?.[option.key] ?? AUTO;
}

export function isAuto(value: string): boolean {
  return !value || value.toLowerCase() === AUTO;
}

/**
 * What OptiScaler will actually use. "auto" resolves to the default documented
 * in the shipped INI, so toggles show the real behaviour rather than a blank.
 */
export function effectiveValue(values: ConfigValues, option: OptionMeta): string {
  const raw = rawValue(values, option);
  return isAuto(raw) ? option.default : raw;
}

export function asBool(value: string): boolean {
  return value.toLowerCase() === "true" || value === "1";
}

export function asNumber(value: string, fallback = 0): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** True when the user has set this option to something explicit. */
export function isOverridden(values: ConfigValues, option: OptionMeta): boolean {
  return !isAuto(rawValue(values, option));
}

export function optionId(option: OptionMeta): string {
  return `${option.section}.${option.key}`;
}

export function labelFor(option: OptionMeta, value: string): string {
  if (isAuto(value)) return "Auto";
  return curatedLabel(optionId(option), value) ?? option.optionLabels?.[value] ?? value;
}

/** Count of explicitly-set options within a set of sections. */
export function countOverrides(values: ConfigValues, options: OptionMeta[]): number {
  return options.filter((option) => isOverridden(values, option)).length;
}
