import { DropdownItem, SliderField, TextField, ToggleField } from "@decky/ui";
import { useEffect, useState } from "react";
import type { ConfigValues, OptionMeta } from "../types";
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
  onChange: (option: OptionMeta, value: string) => void;
  disabled?: boolean;
}

/** Marks options the user has explicitly set, so overrides are easy to spot. */
function labelWithState(option: OptionMeta, values: ConfigValues) {
  return isOverridden(values, option) ? `${option.label} •` : option.label;
}

function describe(option: OptionMeta, values: ConfigValues) {
  const raw = rawValue(values, option);
  const parts: string[] = [];
  if (option.description) parts.push(option.description);
  if (raw.toLowerCase() === AUTO) {
    parts.push(`Auto — OptiScaler uses ${option.default}.`);
  }
  return parts.join(" ");
}

export function OptionControl({ option, values, onChange, disabled }: Props) {
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
    const choices = [AUTO, ...(option.options ?? [])];
    return (
      <DropdownItem
        label={label}
        description={description}
        disabled={disabled}
        bottomSeparator="standard"
        rgOptions={choices.map((choice) => ({
          data: choice,
          label: choice === AUTO ? `Auto (${labelFor(option, option.default)})` : labelFor(option, choice),
        }))}
        selectedOption={raw.toLowerCase() === AUTO ? AUTO : raw}
        onChange={(selected) => onChange(option, String(selected.data))}
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

  return <TextOption option={option} raw={raw} label={label} description={description}
                     disabled={disabled} onChange={onChange} />;
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

  useEffect(() => {
    setDraft(raw);
  }, [raw]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === raw) return;
    if (option.type === "int" || option.type === "float" || option.type === "keycode") {
      if (trimmed && trimmed.toLowerCase() !== AUTO && !Number.isFinite(Number(trimmed))) {
        setDraft(raw);
        return;
      }
    }
    onChange(option, trimmed || AUTO);
  };

  return (
    <TextField
      label={label}
      description={description}
      disabled={disabled}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
    />
  );
}
