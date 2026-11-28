import { ButtonItem, PanelSection, PanelSectionRow, Tabs } from "@decky/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { getStatus, preparePayload } from "../api";
import { resolveGame } from "../shortcuts";
import {
  subscribeManagerTarget,
  takePendingTarget,
  targetFromUrl,
} from "../navigation";
import type { ManagerTarget } from "../navigation";
import { useRunningGame } from "../hooks/useRunningGame";
import { setBackendLocale, syncLanguagePrefFromBackend, useI18n } from "../i18n";
import type { Game, PayloadStatus } from "../types";
import { Notice } from "./Common";
import { GameDetail } from "./GameDetail";
import { GamesList } from "./GamesList";
import { LibraryBrowser } from "./LibraryBrowser";
import { SettingsTab } from "./SettingsTab";

interface Selection {
  path: string;
  name: string;
  appid: string | null;
}

/** Full-screen page: library browser, or one game's detail view. */
export function ManagerPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<PayloadStatus | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const runningGame = useRunningGame();
  const resolveSequence = useRef(0);
  const [tab, setTab] = useState("games");

  /**
   * Open at whichever game was asked for.
   *
   * The Quick Access panel knows the folder and can hand it over directly; the
   * Steam context menu only knows the app id, so that has to be looked up
   * first. A request naming neither is a request for the library list.
   */
  const openTarget = useCallback((target: ManagerTarget) => {
    const request = ++resolveSequence.current;
    setResolveError(null);
    if (target.path && target.name) {
      setResolving(false);
      setSelection({ path: target.path, name: target.name, appid: target.appid ?? null });
      return;
    }
    if (!target.appid) {
      setResolving(false);
      setSelection(null);
      return;
    }
    const appid = target.appid;
    setSelection(null);
    setResolving(true);
    void (async () => {
      try {
        const game = await resolveGame(appid);
        if (resolveSequence.current !== request) return;
        if (game.found && game.path && game.name) {
          setSelection({ path: game.path, name: game.name, appid });
        } else {
          // A Steam game with no manifest, or a non-Steam shortcut whose
          // target has moved: the folder was worked out from the shortcut's
          // executable and there was no executable there to work from.
          setResolveError(
            t(
              "Neither Steam nor this game's shortcut points at a folder that exists, so it cannot be opened directly. Pick it from the library list, or add the folder it lives in as a custom library.",
            ),
          );
        }
      } catch (err) {
        if (resolveSequence.current === request) setResolveError(String(err));
      } finally {
        if (resolveSequence.current === request) setResolving(false);
      }
    })();
  }, []);

  const openGame = useCallback((game: Game) => {
    setResolveError(null);
    setSelection({ path: game.path, name: game.name, appid: game.appid ?? null });
  }, []);

  const handleBack = useCallback(() => {
    setResolveError(null);
    setSelection(null);
  }, []);

  const handleShowTab = useCallback((nextTab: string) => {
    setResolveError(null);
    setTab(nextTab);
  }, []);

  // The request the page was opened with, plus any that arrives while it stays
  // open — the Quick Access panel can be pulled up over this page, so picking a
  // game there has to reach a component that is already mounted.
  useEffect(() => {
    const initial = takePendingTarget() ?? targetFromUrl();
    if (initial) openTarget(initial);
    return subscribeManagerTarget(openTarget);
  }, [openTarget]);

  const loadAndPreparePayload = useCallback(async () => {
    setPayloadError(null);
    let unpacking = false;
    try {
      void syncLanguagePrefFromBackend();
      const value = await getStatus();
      setStatus(value);
      setBackendLocale(value.locale);
      if (value.archive_present && !value.extracted && value.extractor) {
        unpacking = true;
        setPreparing(true);
        const result = await preparePayload(false);
        if (!result?.ok) {
          setPayloadError(
            result?.error ?? t("Could not unpack the bundled OptiScaler archive."),
          );
          return;
        }
        const refreshed = await getStatus();
        setStatus(refreshed);
        setBackendLocale(refreshed.locale);
      }
    } catch (err) {
      setPayloadError(String(err));
    } finally {
      if (unpacking) setPreparing(false);
    }
  }, [t]);

  useEffect(() => {
    void loadAndPreparePayload();
  }, [loadAndPreparePayload]);

  const blocked =
    status && (!status.archive_present || (!status.extracted && !status.extractor));

  return (
    <div
      style={{
        marginTop: "40px",
        height: "calc(100% - 40px)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        // Only the library list scrolls as a page; the detail view lays out its
        // own header and scrolling tab body.
        overflowY: selection ? "hidden" : "auto",
        padding: selection ? "0" : "0 12px 40px",
      }}
    >
      {blocked ? (
        <PanelSection title={t("OptiScaler payload")}>
          <PanelSectionRow>
            {!status?.archive_present ? (
              <Notice tone="error" title={t("Bundled release is missing")}>
                {t("The plugin was installed without its OptiScaler archive. Reinstall the plugin.")}
              </Notice>
            ) : (
              <Notice tone="error" title={t("No archive tool found")}>
                {t("Extracting OptiScaler needs one of 7z, 7zz, 7za, 7zr or bsdtar, none of which are on this system.")}
              </Notice>
            )}
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {preparing ? (
        <PanelSection>
          <PanelSectionRow>
            <Notice tone="info">
              {t("Unpacking OptiScaler {version}…", { version: status?.optiscaler_version ?? "" })}
            </Notice>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {payloadError && !preparing ? (
        <PanelSection title={t("OptiScaler payload")}>
          <PanelSectionRow>
            <Notice tone="error" title={t("Could not unpack OptiScaler")}>
              {payloadError}
            </Notice>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={preparing} onClick={() => void loadAndPreparePayload()}>
              {t("Retry")}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {resolving ? (
        <PanelSection>
          <PanelSectionRow>
            <Notice tone="info">{t("Looking up this game's install folder…")}</Notice>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {resolveError ? (
        <PanelSection>
          <PanelSectionRow>
            <Notice tone="error" title={t("Could not open this game")}>
              {resolveError}
            </Notice>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {selection ? (
        <GameDetail
          key={`${selection.appid ?? ""}:${selection.path}:${selection.name}`}
          gamePath={selection.path}
          gameName={selection.name}
          appid={selection.appid}
          status={status}
          runningGame={runningGame}
          onBack={handleBack}
        />
      ) : (
        <Tabs
          activeTab={tab}
          onShowTab={handleShowTab}
          tabs={[
            {
              id: "games",
              title: t("Games"),
              content: (
                <GamesList
                  runningGame={runningGame}
                  onOpenGame={openGame}
                />
              ),
            },
            { id: "libraries", title: t("Libraries"), content: <LibraryBrowser /> },
            // Plugin-wide, so it belongs here rather than in the Quick Access
            // panel: nothing on it is about the game currently running.
            { id: "settings", title: t("Plugin Settings"), content: <SettingsTab status={status} /> },
          ]}
        />
      )}
    </div>
  );
}
