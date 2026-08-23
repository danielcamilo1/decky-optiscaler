import { Field, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import { useCallback, useEffect, useState } from "react";
import { getPref } from "../api";
import {
  REMEMBERED_QUESTIONS,
  forget,
  isRemembering,
  setRemembering,
} from "../prefs";
import type { PayloadStatus } from "../types";
import { Centered, KeyValue, Notice, Pill } from "./Common";

/**
 * The plugin's own settings, as opposed to one game's.
 *
 * It exists for one reason: two prompts here offer "Remember my choice", and an
 * answer that can only be given and never taken back is a trap. Whatever is
 * remembered is listed by name with what it will do, each with a way to forget
 * it, plus the switch that stops answers being kept at all.
 *
 * Deliberately not in the Quick Access panel. That panel drives the game that
 * is running; this changes how the plugin behaves for every game, which is not
 * something to be reached for mid-session by accident.
 */
export function SettingsTab({ status }: Readonly<{ status: PayloadStatus | null }>) {
  const [remembering, setRememberingState] = useState<boolean | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const enabled = await isRemembering();
    const stored: Record<string, unknown> = {};
    for (const question of REMEMBERED_QUESTIONS) {
      try {
        const { value } = await getPref(question.key);
        if (value !== null && value !== undefined) stored[question.key] = value;
      } catch {
        /* an unreadable preference is one that is not remembered */
      }
    }
    setRememberingState(enabled);
    setAnswers(stored);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changeRemembering = async (enabled: boolean) => {
    setBusy(true);
    try {
      await setRemembering(enabled);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const forgetOne = async (key: string) => {
    setBusy(true);
    try {
      await forget(key);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (remembering === null) return <Centered>Reading settings…</Centered>;

  const stored = REMEMBERED_QUESTIONS.filter((question) => question.key in answers);

  return (
    <>
      <PanelSection title="Remembered answers">
        <PanelSectionRow>
          <ToggleField
            label="Remember my choices"
            description={
              remembering
                ? "Prompts that offer “Remember my choice” can store the answer and stop asking."
                : "Every prompt asks again, and nothing is stored."
            }
            checked={remembering}
            disabled={busy}
            bottomSeparator="standard"
            onChange={(checked) => void changeRemembering(checked)}
          />
        </PanelSectionRow>

        {stored.length === 0 ? (
          <PanelSectionRow>
            <Notice tone="info">
              {remembering
                ? "Nothing is remembered yet. The launch-options prompts are the ones that offer it."
                : "Turning this off also cleared the answers that were stored."}
            </Notice>
          </PanelSectionRow>
        ) : (
          stored.map((question) => (
            <PanelSectionRow key={question.key}>
              <Field
                label={question.title}
                description={question.describe(answers[question.key])}
                onClick={() => void forgetOne(question.key)}
                onActivate={() => void forgetOne(question.key)}
                focusable={!busy}
                bottomSeparator="standard"
                childrenLayout="inline"
                childrenContainerWidth="min"
                {...({ "data-forget": question.key } as Record<string, string>)}
              >
                <Pill>ask me again</Pill>
              </Field>
            </PanelSectionRow>
          ))
        )}
      </PanelSection>

      <PanelSection title="About">
        <PanelSectionRow>
          <Field bottomSeparator="none" focusable>
            <div style={{ width: "100%" }}>
              <KeyValue label="Bundled OptiScaler" value={status?.optiscaler_version ?? "—"} />
              <KeyValue
                label="Release payload"
                value={
                  !status?.archive_present
                    ? "missing"
                    : status.extracted
                      ? "unpacked"
                      : "not unpacked yet"
                }
              />
              <KeyValue label="Default proxy" value={status?.default_proxy ?? "—"} />
            </div>
          </Field>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}
