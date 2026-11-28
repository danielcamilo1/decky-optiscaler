import { DropdownItem, SliderField, TextField, ToggleField } from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useState } from "react";
import { keyName } from "../config/keys";
import { t as translate, useI18n } from "../i18n";
import type { ConfigValues, LiveContext, OptionMeta } from "../types";
import {
  AUTO,
  asBool,
  asNumber,
  effectiveValue,
  isOverridden,
  labelFor,
  rawValue,
} from "../config/values";

interface Props {
  option: OptionMeta;
  values: ConfigValues;
  onChange: (option: OptionMeta, value: string, context?: LiveContext | null) => void;
  /** Runtime ordered version choices for FFX fields, when a game reported them. */
  runtimeChoices?: { value: string; label: string; context: LiveContext | null }[];
  disabled?: boolean;
}

/** Marks options the user has explicitly set, so overrides are easy to spot. */
function labelWithState(option: OptionMeta, values: ConfigValues) {
  return isOverridden(values, option) ? `${option.label} •` : option.label;
}

function describe(option: OptionMeta, values: ConfigValues) {
  const raw = rawValue(values, option);
  const effective = effectiveValue(values, option);
  const parts: string[] = [];
  if (option.description) parts.push(option.description);
  if (option.type === "keycode") {
    parts.push(translate("Key: {name}.", { name: keyName(effective) }));
  }
  if (raw.toLowerCase() === AUTO) {
    parts.push(translate("Auto — OptiScaler uses {value}.", { value: option.default }));
  }
  return parts.join(" ");
}

/** Parse a decimal or 0x-hex integer matching backend schema.py::_as_int. */
function parseIntegerInput(trimmed: string): number | null {
  const hex = /^([+-]?)0x([0-9a-f]+)$/i.exec(trimmed);
  if (hex) {
    const parsed = Number.parseInt(hex[2], 16) * (hex[1] === "-" ? -1 : 1);
    return Number.isInteger(parsed) ? parsed : null;
  }
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}

const DECIMAL_FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Parse a decimal float matching Python's float() syntax (rejecting 0x/0b/0o/NaN/Infinity). */
function parseFloatInput(trimmed: string): number | null {
  if (!DECIMAL_FLOAT_RE.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateTextValue(option: OptionMeta, trimmed: string): string | null {
  if (!trimmed || trimmed.toLowerCase() === AUTO) return null;
  if (option.type === "keycode") {
    const parsed = parseIntegerInput(trimmed);
    if (parsed === null || !Number.isInteger(parsed)) {
      return translate("Enter a whole key code (for example 45 or 0x2d), -1 to disable, or auto.");
    }
    return null;
  }
  if (option.type === "int") {
    const parsed = parseIntegerInput(trimmed);
    if (parsed === null || !Number.isInteger(parsed)) {
      return translate("Enter a whole number or auto.");
    }
    if (option.min !== undefined && parsed < option.min) {
      return translate("Must be at least {min} (or auto).", { min: option.min });
    }
    if (option.max !== undefined && parsed > option.max) {
      return translate("Must be at most {max} (or auto).", { max: option.max });
    }
    return null;
  }
  if (option.type === "float") {
    const parsed = parseFloatInput(trimmed);
    if (parsed === null) {
      return translate("Enter a valid number or auto.");
    }
    if (option.min !== undefined && parsed < option.min) {
      return translate("Must be at least {min} (or auto).", { min: option.min });
    }
    if (option.max !== undefined && parsed > option.max) {
      return translate("Must be at most {max} (or auto).", { max: option.max });
    }
    return null;
  }
  return null;
}

export function OptionControl({ option, values, onChange, runtimeChoices, disabled }: Props) {
  const { t } = useI18n();
  const raw = rawValue(values, option);
  const effective = effectiveValue(values, option);
  const label = labelWithState(option, values);
  const description = describe(option, values);

  if (option.type === "bool") {
    return (
      <ToggleField
        label={label}
        description={description}
        checked={asBool(effective)}
        disabled={disabled}
        bottomSeparator="standard"
        onChange={(checked) => onChange(option, checked ? "true" : "false")}
      />
    );
  }

  if (option.type === "enum") {
    const dynamicLabels = runtimeChoices
      ? Object.fromEntries(runtimeChoices.map((choice) => [choice.value.toLowerCase(), choice.label]))
      : null;
    const choices = [AUTO, ...(runtimeChoices
      ? runtimeChoices.filter((choice) => choice.value.toLowerCase() !== AUTO).map((choice) => choice.value)
      : option.options ?? [])];
    // OptiScaler's ini is case-insensitive and hand-edited files show it, so
    // the value is matched to a choice rather than compared to one. A value
    // that matches nothing keeps an option of its own: Steam's dropdown shows
    // the option whose data equals selectedOption and has nothing to fall back
    // on, so without this the control silently displays the wrong setting.
    const selected =
      choices.find((choice) => choice.toLowerCase() === raw.toLowerCase()) ?? raw;
    const known = choices.includes(selected);
    return (
      <DropdownItem
        key={selected}
        label={label}
        description={description}
        disabled={disabled}
        bottomSeparator="standard"
        rgOptions={(known ? choices : [...choices, selected]).map((choice) => ({
          data: choice,
          label:
            choice === AUTO
              ? dynamicLabels?.[choice.toLowerCase()] ??
                t("Auto ({label})", { label: labelFor(option, option.default) })
              : dynamicLabels?.[choice.toLowerCase()] ?? (runtimeChoices
                ? t("Index {choice} (not reported by the current FFX runtime)", { choice })
                : labelFor(option, choice)),
        }))}
        selectedOption={selected}
        onChange={(picked) => {
          const value = String(picked.data);
          if (runtimeChoices) {
            const choice = runtimeChoices.find((item) => item.value.toLowerCase() === value.toLowerCase());
            onChange(option, value, choice?.context ?? null);
          } else {
            onChange(option, value);
          }
        }}
      />
    );
  }

  if (
    (option.type === "int" || option.type === "float") &&
    option.min !== undefined &&
    option.max !== undefined
  ) {
    const step = option.type === "float" ? (option.max - option.min) / 100 : 1;
    return (
      <SliderField
        label={label}
        description={description}
        disabled={disabled}
        bottomSeparator="standard"
        value={asNumber(effective, option.min)}
        min={option.min}
        max={option.max}
        step={step}
        showValue
        editableValue
        validValues="range"
        onChange={(value) =>
          onChange(option, option.type === "int" ? String(Math.round(value)) : value.toFixed(3))
        }
      />
    );
  }

  return (
    <TextOption
      option={option}
      raw={raw}
      label={label}
      description={description}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

interface TextProps {
  option: OptionMeta;
  raw: string;
  label: string;
  description: string;
  disabled?: boolean;
  onChange: (option: OptionMeta, value: string) => void;
}

/** Free-text and unbounded numeric options commit on blur, not per keystroke. */
function TextOption({ option, raw, label, description, disabled, onChange }: TextProps) {
  const [draft, setDraft] = useState(raw);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(raw);
    setValidationError(null);
  }, [raw]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === raw) {
      setValidationError(null);
      return;
    }
    const invalidReason = validateTextValue(option, trimmed);
    if (invalidReason) {
      setValidationError(invalidReason);
      setDraft(raw);
      toaster.toast({
        title: translate("Invalid {label}", { label: option.label }),
        body: invalidReason,
      });
      return;
    }
    setValidationError(null);
    onChange(option, trimmed || AUTO);
  };

  return (
    <TextField
      label={label}
      description={validationError ? `${validationError} ${description}`.trim() : description}
      disabled={disabled}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        if (validationError) setValidationError(null);
      }}
      onBlur={commit}
    />
  );
}
