import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { useState } from "react";
import { FEATURED, optionById, optionsInSection, sectionTitle } from "../config/tabs";
import { countOverrides, optionId } from "../config/values";
import type { ConfigValues, LiveContext, OptionMeta } from "../types";
import { Notice } from "./Common";
import { OptionControl } from "./OptionControl";

export interface RuntimeEnumChoice {
  value: string;
  label: string;
  context: LiveContext | null;
}

interface Props {
  tabId: string;
  sections: string[];
  blurb?: string;
  values: ConfigValues;
  disabled?: boolean;
  onChange: (option: OptionMeta, value: string, context?: LiveContext | null) => void;
  onResetSection: (section: string) => void;
  runtimeChoices?: Record<string, RuntimeEnumChoice[]>;
  runtimeGeneration?: string | null;
}

export function ConfigTab({
  tabId,
  sections,
  blurb,
  values,
  disabled,
  onChange,
  onResetSection,
  runtimeChoices,
  runtimeGeneration,
}: Props) {
  const featuredIds = FEATURED[tabId] ?? [];
  const featured = featuredIds
    .map((id) => optionById(id))
    .filter((option): option is OptionMeta => Boolean(option));
  const featuredSet = new Set(featured.map(optionId));

  return (
    <>
      {blurb ? (
        <PanelSectionRow>
          <Notice tone="info">{blurb}</Notice>
        </PanelSectionRow>
      ) : null}

      {featured.length > 0 ? (
        <PanelSection title="Main Settings">
          {featured.map((option) => (
            <PanelSectionRow key={`${optionId(option)}:${runtimeGeneration ?? "static"}`}>
              <OptionControl
                key={`${optionId(option)}:${runtimeGeneration ?? "static"}`}
                option={option}
                values={values}
                onChange={onChange}
                runtimeChoices={runtimeChoices?.[optionId(option)]}
                disabled={disabled}
              />
            </PanelSectionRow>
          ))}
        </PanelSection>
      ) : null}

      {sections.map((section) => (
        <CollapsibleSection
          key={section}
          section={section}
          values={values}
          disabled={disabled}
          skip={featuredSet}
          onChange={onChange}
          onResetSection={onResetSection}
          runtimeChoices={runtimeChoices}
          runtimeGeneration={runtimeGeneration}
          startOpen={featured.length === 0 && sections.length === 1}
        />
      ))}
    </>
  );
}

function CollapsibleSection({
  section,
  values,
  disabled,
  skip,
  onChange,
  onResetSection,
  runtimeChoices,
  runtimeGeneration,
  startOpen,
}: {
  section: string;
  values: ConfigValues;
  disabled?: boolean;
  skip: Set<string>;
  onChange: (option: OptionMeta, value: string, context?: LiveContext | null) => void;
  onResetSection: (section: string) => void;
  runtimeChoices?: Record<string, RuntimeEnumChoice[]>;
  runtimeGeneration?: string | null;
  startOpen?: boolean;
}) {
  const all = optionsInSection(section);
  const options = all.filter((option) => !skip.has(optionId(option)));
  const [open, setOpen] = useState(Boolean(startOpen));

  if (options.length === 0) return null;

  const overrides = countOverrides(values, all);
  const summary = `${options.length} option${options.length === 1 ? "" : "s"}${
    overrides > 0 ? ` · ${overrides} changed` : ""
  }`;

  return (
    <PanelSection title={sectionTitle(section)}>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setOpen((value) => !value)}>
          {open ? `Hide ${summary}` : `Show ${summary}`}
        </ButtonItem>
      </PanelSectionRow>
      {open ? (
        <>
          {options.map((option) => (
            <PanelSectionRow key={optionId(option)}>
              <OptionControl
                key={`${optionId(option)}:${runtimeGeneration ?? "static"}`}
                option={option}
                values={values}
                onChange={onChange}
                runtimeChoices={runtimeChoices?.[optionId(option)]}
                disabled={disabled}
              />
            </PanelSectionRow>
          ))}
          {overrides > 0 ? (
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={disabled}
                onClick={() => onResetSection(section)}
              >
                Reset this section to auto
              </ButtonItem>
            </PanelSectionRow>
          ) : null}
        </>
      ) : null}
    </PanelSection>
  );
}
