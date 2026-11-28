import {
  ButtonItem,
  DropdownItem,
  Field,
  PanelSection,
  PanelSectionRow,
  ToggleField,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useState } from "react";
import { getPref, getWikiStatus, refreshWiki } from "../api";
import {
  setLanguagePref,
  syncLanguagePrefFromBackend,
  t as translate,
  useI18n,
} from "../i18n";
import type { LanguagePref } from "../i18n";
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
  if (age === null) return translate("at an unknown time");
  const hours = age / 3600;
  if (hours < 1) return translate("in the last hour");
  if (hours < 48) return translate("{hours} hours ago", { hours: Math.round(hours) });
  return translate("{days} days ago", { days: Math.round(hours / 24) });
}

/**
 * The plugin's own settings, as opposed to one game's.
 */
export function SettingsTab({ status }: Readonly<{ status: PayloadStatus | null }>) {
  const { locale, pref: languagePref, systemLocale, t } = useI18n();
  const [remembering, setRememberingState] = useState<boolean | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [wiki, setWiki] = useState<WikiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    void syncLanguagePrefFromBackend();
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

  const changeLanguage = async (next: LanguagePref) => {
    setBusy(true);
    try {
      await setLanguagePref(next);
    } finally {
      setBusy(false);
    }
  };

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
      const succeeded = result.ok !== false && !result.meta?.error && result.count > 0;
      toaster.toast({
        title: succeeded
          ? t("Compatibility list downloaded")
          : t("Could not refresh compatibility list"),
        body: succeeded
          ? t("{count} entries.", { count: result.count })
          : String(
              result.meta?.error ??
                (result.count > 0
                  ? t("The wiki could not be reached. Using the cached list.")
                  : t("The wiki could not be reached.")),
            ),
      });
    } catch (exc) {
      toaster.toast({ title: t("Still could not download it"), body: String(exc) });
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

  if (remembering === null) return <Centered>{t("Reading settings…")}</Centered>;

  const stored = REMEMBERED_QUESTIONS.filter((question) => question.key in answers);
  const systemLocaleLabel = systemLocale === "zh-CN" ? "简体中文" : "English";

  return (
    <>
      <PanelSection title={t("Language")}>
        <PanelSectionRow>
          <DropdownItem
            key={`lang-${locale}-${languagePref}-${systemLocale}`}
            label="Language / 语言"
            description={t(
              "Auto-detects Simplified Chinese from Steam or system settings; defaults to English.",
            )}
            disabled={busy}
            bottomSeparator="standard"
            rgOptions={[
              {
                data: "auto",
                label: t("Follow system ({locale})", { locale: systemLocaleLabel }),
              },
              { data: "en", label: "English" },
              { data: "zh-CN", label: "简体中文" },
            ]}
            selectedOption={languagePref}
            onChange={(picked) => void changeLanguage(String(picked.data) as LanguagePref)}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t("Remembered answers")}>
        <PanelSectionRow>
          <ToggleField
            label={t("Remember my choices")}
            description={
              remembering
                ? t("Save answers from “Remember my choice” prompts so they stop asking.")
                : t("Always ask again and clear stored answers.")
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
                ? t("No saved answers yet — launch-options prompts offer “Remember my choice”.")
                : t("Previously stored answers were cleared.")}
            </Notice>
          </PanelSectionRow>
        ) : (
          stored.map((question) => (
            <PanelSectionRow key={question.key}>
              <Field
                label={t(question.title)}
                description={question.describe(answers[question.key])}
                onClick={() => void forgetOne(question.key)}
                onActivate={() => void forgetOne(question.key)}
                focusable={!busy}
                bottomSeparator="standard"
                childrenLayout="inline"
                childrenContainerWidth="min"
                {...({ "data-forget": question.key } as Record<string, string>)}
              >
                <Pill>{t("ask me again")}</Pill>
              </Field>
            </PanelSectionRow>
          ))
        )}
      </PanelSection>

      <PanelSection title={t("Compatibility list")}>
        <PanelSectionRow>
          {wiki === null ? (
            <Notice tone="info">{t("Checking the OptiScaler wiki…")}</Notice>
          ) : wiki.available ? (
            <Notice
              tone={wiki.error ? "warn" : "success"}
              title={t("{count} games on the list", { count: wiki.entry_count })}
            >
              {wiki.source === "bundled"
                ? t("Using the copy bundled with the plugin (not updated online yet).")
                : t("Downloaded {age}.", { age: describeAge(wiki.age) })}
              {wiki.error ? (
                <>
                  {" "}
                  {t("The last refresh did not go through, so this copy is still in use.")}{" "}
                  <Mono>{wiki.error}</Mono>
                </>
              ) : wiki.revalidating ? (
                t(" Checking for updates…")
              ) : (
                ""
              )}
            </Notice>
          ) : (
            <Notice tone="error" title={t("The compatibility list could not be downloaded")}>
              {t("Automatic setup needs this list; without it, games show as having no wiki entry.")}{" "}
              {wiki.error ? <Mono>{wiki.error}</Mono> : null}
            </Notice>
          )}
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? t("Downloading…") : t("Download it again")}
          </ButtonItem>
        </PanelSectionRow>
        {wiki && (!wiki.available || wiki.error) ? (
          <PanelSectionRow>
            <Field bottomSeparator="none" focusable>
              <div style={{ width: "100%" }}>
                <KeyValue label={t("Address")} value={<Mono>{wiki.url}</Mono>} />
                <KeyValue label={t("Certificates")} value={wiki.tls ?? t("none worked")} />
                <KeyValue
                  label={t("Last tried")}
                  value={
                    wiki.last_attempt
                      ? new Date(wiki.last_attempt * 1000).toLocaleString()
                      : t("not yet")
                  }
                />
              </div>
            </Field>
          </PanelSectionRow>
        ) : null}
      </PanelSection>

      <PanelSection title={t("About")}>
        <PanelSectionRow>
          <Field bottomSeparator="none" focusable>
            <div style={{ width: "100%" }}>
              <KeyValue label={t("Bundled OptiScaler")} value={status?.optiscaler_version ?? "—"} />
              <KeyValue
                label={t("Release payload")}
                value={
                  !status?.archive_present
                    ? t("missing")
                    : status.extracted
                      ? t("unpacked")
                      : t("not unpacked yet")
                }
              />
              <KeyValue label={t("Default proxy")} value={status?.default_proxy ?? "—"} />
            </div>
          </Field>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}
