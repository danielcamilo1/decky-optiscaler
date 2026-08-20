import { PanelSection, PanelSectionRow, Tabs } from "@decky/ui";
import { useCallback, useEffect, useState } from "react";
import { findRunningGame, getStatus, preparePayload } from "../api";
import {
  subscribeManagerTarget,
  takePendingTarget,
  targetFromUrl,
} from "../navigation";
import type { ManagerTarget } from "../navigation";
import { useRunningGame } from "../hooks/useRunningGame";
import type { Game, PayloadStatus } from "../types";
import { Notice } from "./Common";
import { GameDetail } from "./GameDetail";
import { GamesList } from "./GamesList";
import { LibraryBrowser } from "./LibraryBrowser";
import { NowPlaying } from "./NowPlaying";

interface Selection {
  path: string;
  name: string;
  appid: string | null;
}

/** Full-screen page: library browser, or one game's detail view. */
export function ManagerPage() {
  const [status, setStatus] = useState<PayloadStatus | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const runningGame = useRunningGame();
  // Land on the running game when there is one; otherwise the games list is
  // what the page is for. The current app is read synchronously on mount, so
  // this is the real answer rather than a guess that corrects itself.
  const [tab, setTab] = useState(() => (runningGame ? "now" : "games"));

  /**
   * Open at whichever game was asked for.
   *
   * The Quick Access panel knows the folder and can hand it over directly; the
   * Steam context menu only knows the app id, so that has to be looked up
   * first. A request naming neither is a request for the library list.
   */
  const openTarget = useCallback((target: ManagerTarget) => {
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
    setResolving(true);
    void (async () => {
      try {
        const game = await findRunningGame(appid);
        if (game.found && game.path && game.name) {
          setSelection({ path: game.path, name: game.name, appid });
        } else {
          setResolveError(
            "Steam did not report an install folder for this game, so it cannot be " +
              "opened directly. Pick it from the library list instead.",
          );
        }
      } catch (err) {
        setResolveError(String(err));
      } finally {
        setResolving(false);
      }
    })();
  }, []);

  // The request the page was opened with, plus any that arrives while it stays
  // open — the Quick Access panel can be pulled up over this page, so picking a
  // game there has to reach a component that is already mounted.
  useEffect(() => {
    const initial = takePendingTarget() ?? targetFromUrl();
    if (initial) openTarget(initial);
    return subscribeManagerTarget(openTarget);
  }, [openTarget]);

  useEffect(() => {
    void (async () => {
      try {
        const value = await getStatus();
        setStatus(value);
        if (value.archive_present && !value.extracted && value.extractor) {
          setPreparing(true);
          await preparePayload(false);
          setStatus(await getStatus());
          setPreparing(false);
        }
      } catch {
        /* surfaced by the banner below */
      }
    })();
  }, []);

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
        <PanelSection title="OptiScaler payload">
          <PanelSectionRow>
            {!status?.archive_present ? (
              <Notice tone="error" title="Bundled release is missing">
                The plugin was installed without its OptiScaler archive. Reinstall the plugin.
              </Notice>
            ) : (
              <Notice tone="error" title="No archive tool found">
                Extracting OptiScaler needs one of <code>7z</code>, <code>7zz</code>,
                <code> 7za</code>, <code>7zr</code> or <code>bsdtar</code>, none of which are on
                this system.
              </Notice>
            )}
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {preparing ? (
        <PanelSection>
          <PanelSectionRow>
            <Notice tone="info">Unpacking OptiScaler {status?.optiscaler_version}…</Notice>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {resolving ? (
        <PanelSection>
          <PanelSectionRow>
            <Notice tone="info">Looking up this game's install folder…</Notice>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {resolveError ? (
        <PanelSection>
          <PanelSectionRow>
            <Notice tone="error" title="Could not open this game">
              {resolveError}
            </Notice>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {selection ? (
        <GameDetail
          gamePath={selection.path}
          gameName={selection.name}
          appid={selection.appid}
          status={status}
          runningGame={runningGame}
          onBack={() => setSelection(null)}
        />
      ) : (
        <Tabs
          activeTab={tab}
          onShowTab={setTab}
          tabs={[
            {
              id: "now",
              title: "Now Playing",
              content: (
                <NowPlaying
                  runningGame={runningGame}
                  onOpenGame={(game: Game) =>
                    setSelection({ path: game.path, name: game.name, appid: game.appid })
                  }
                  onBrowse={() => setTab("games")}
                />
              ),
            },
            {
              id: "games",
              title: "Games",
              content: (
                <GamesList
                  onOpenGame={(game: Game) =>
                    setSelection({ path: game.path, name: game.name, appid: game.appid })
                  }
                />
              ),
            },
            { id: "libraries", title: "Libraries", content: <LibraryBrowser /> },
          ]}
        />
      )}
    </div>
  );
}
