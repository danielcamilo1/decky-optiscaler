import {
  ButtonItem,
  Field,
  PanelSection,
  PanelSectionRow,
  ToggleField,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useState } from "react";
import { getPref, getWikiStatus, refreshWiki } from "../api";
import {
  REMEMBERED_QUESTIONS,
  forget,
  isRemembering,
  setRemembering,
} from "../prefs";
import type { PayloadStatus, WikiStatus } from "../types";
import { Centered, KeyValue, Mono, Notice, Pill } from "./Common";

/** How old the list is, in the terms someone would actually ask it in. */
function describeAge(age: number | null): string {
  if (age === null) return "at an unknown time";
  const hours = age / 3600;
  if (hours < 1) return "in the last hour";
  if (hours < 48) return `${Math.round(hours)} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

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
  const [wiki, setWiki] = useState<WikiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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
    try {
      setWiki(await getWikiStatus(false));
    } catch (exc) {
      setWiki({
        url: "", entry_count: 0, available: false, source: null, fetched_at: null,
        age: null, stale: true, revision: "", revalidating: false, last_attempt: null,
        error: String(exc), tls: null, cache_path: "",
      });
    }
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

  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await refreshWiki();
      setWiki(await getWikiStatus(false));
      toaster.toast({
        title: result.count > 0 ? "Compatibility list downloaded" : "Still could not download it",
        body: result.count > 0
          ? `${result.count} entries.`
          : String(result.meta?.error ?? "The wiki could not be reached."),
      });
    } catch (exc) {
      toaster.toast({ title: "Still could not download it", body: String(exc) });
    } finally {
      setRefreshing(false);
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

      <PanelSection title="Compatibility list">
        <PanelSectionRow>
          {wiki === null ? (
            <Notice tone="info">Checking the OptiScaler wiki…</Notice>
          ) : wiki.available ? (
            // Available and *current* are different questions now that answers
            // come from cache: a list can be perfectly usable and months old,
            // and a refresh can be failing behind it without anything breaking.
            <Notice
              tone={wiki.error ? "warn" : "success"}
              title={`${wiki.entry_count} games on the list`}
            >
              {wiki.source === "bundled"
                ? "The copy bundled with the plugin — this Deck has not downloaded one yet."
                : `Downloaded ${describeAge(wiki.age)}.`}
              {wiki.error ? (
                <>
                  {" "}
                  The last refresh did not go through, so this list is what is being used
                  meanwhile. <Mono>{wiki.error}</Mono>
                </>
              ) : wiki.revalidating ? (
                " Checking for a newer one now."
              ) : (
                ""
              )}
            </Notice>
          ) : (
            // The sentence the rest of the plugin could never show: when the
            // list will not download, every game reads as "not in the list",
            // and without the actual error there is nothing to act on.
            <Notice tone="error" title="The compatibility list could not be downloaded">
              Automatic setup needs this list, so without it every game looks as though it has
              no wiki entry. {wiki.error ? <Mono>{wiki.error}</Mono> : null}
            </Notice>
          )}
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? "Downloading…" : "Download it again"}
          </ButtonItem>
        </PanelSectionRow>
        {wiki && (!wiki.available || wiki.error) ? (
          <PanelSectionRow>
            <Field bottomSeparator="none" focusable>
              <div style={{ width: "100%" }}>
                <KeyValue label="Address" value={<Mono>{wiki.url}</Mono>} />
                <KeyValue label="Certificates" value={wiki.tls ?? "none worked"} />
                <KeyValue
                  label="Last tried"
                  value={
                    wiki.last_attempt
                      ? new Date(wiki.last_attempt * 1000).toLocaleString()
                      : "not yet"
                  }
                />
              </div>
            </Field>
          </PanelSectionRow>
        ) : null}
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
