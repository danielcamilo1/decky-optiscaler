import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { useState } from "react";
import { FEATURED, optionById, optionsInSection, sectionTitle } from "../config/tabs";
import { countOverrides, optionId } from "../config/values";
import type { ConfigValues, OptionMeta } from "../types";
import { Notice } from "./Common";
import { OptionControl } from "./OptionControl";

interface Props {
  tabId: string;
  sections: string[];
  blurb?: string;
  values: ConfigValues;
  disabled?: boolean;
  onChange: (option: OptionMeta, value: string) => void;
  onResetSection: (section: string) => void;
}

export function ConfigTab({
  tabId,
  sections,
  blurb,
  values,
  disabled,
  onChange,
  onResetSection,
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
            <PanelSectionRow key={optionId(option)}>
              <OptionControl
                option={option}
                values={values}
                onChange={onChange}
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
  startOpen,
}: {
  section: string;
  values: ConfigValues;
  disabled?: boolean;
  skip: Set<string>;
  onChange: (option: OptionMeta, value: string) => void;
  onResetSection: (section: string) => void;
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
                option={option}
                values={values}
                onChange={onChange}
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
