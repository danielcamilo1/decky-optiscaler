import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { useState } from "react";
import { FEATURED, optionById, optionsInSection, sectionTitle } from "../config/tabs";
import { countOverrides, optionId } from "../config/values";
import { useI18n } from "../i18n";
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
  onResetOptions?: (ids: string[]) => void;
  onResetSection?: (section: string) => void;
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
  onResetOptions,
  onResetSection,
  runtimeChoices,
  runtimeGeneration,
}: Props) {
  const { t } = useI18n();
  const featuredIds = FEATURED[tabId] ?? [];
  const featured = featuredIds
    .map((id) => optionById(id))
    .filter((option): option is OptionMeta => Boolean(option));
  const featuredSet = new Set(featured.map(optionId));
  const featuredOverrides = countOverrides(values, featured);

  const resetOptionList = (options: OptionMeta[], fallbackSection?: string) => {
    if (onResetOptions) {
      onResetOptions(options.map(optionId));
      return;
    }
    if (fallbackSection) {
      onResetSection?.(fallbackSection);
      return;
    }
    for (const section of new Set(options.map((option) => option.section))) {
      onResetSection?.(section);
    }
  };

  return (
    <>
      {blurb ? (
        <PanelSectionRow>
          <Notice tone="info">{t(blurb)}</Notice>
        </PanelSectionRow>
      ) : null}

      {featured.length > 0 ? (
        <PanelSection title={t("Main Settings")}>
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
          {featuredOverrides > 0 ? (
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={disabled}
                onClick={() => resetOptionList(featured)}
              >
                {t("Reset main settings to auto")}
              </ButtonItem>
            </PanelSectionRow>
          ) : null}
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
          onResetOptions={(options) => resetOptionList(options, section)}
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
  onResetOptions,
  runtimeChoices,
  runtimeGeneration,
  startOpen,
}: {
  section: string;
  values: ConfigValues;
  disabled?: boolean;
  skip: Set<string>;
  onChange: (option: OptionMeta, value: string, context?: LiveContext | null) => void;
  onResetOptions: (options: OptionMeta[]) => void;
  runtimeChoices?: Record<string, RuntimeEnumChoice[]>;
  runtimeGeneration?: string | null;
  startOpen?: boolean;
}) {
  const { t } = useI18n();
  const all = optionsInSection(section);
  const options = all.filter((option) => !skip.has(optionId(option)));
  const [open, setOpen] = useState(Boolean(startOpen));

  if (options.length === 0) return null;

  // Count and reset only the options visible in this section (excluding Main Settings).
  const overrides = countOverrides(values, options);
  const summary =
    overrides > 0
      ? t(options.length === 1 ? "{count} option · {overrides} changed" : "{count} options · {overrides} changed", {
          count: options.length,
          overrides,
        })
      : t(options.length === 1 ? "{count} option" : "{count} options", {
          count: options.length,
        });

  return (
    <PanelSection title={sectionTitle(section)}>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setOpen((value) => !value)}>
          {open ? t("Hide {summary}", { summary }) : t("Show {summary}", { summary })}
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
                onClick={() => onResetOptions(options)}
              >
                {t("Reset this section to auto")}
              </ButtonItem>
            </PanelSectionRow>
          ) : null}
        </>
      ) : null}
    </PanelSection>
  );
}
