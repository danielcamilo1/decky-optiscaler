import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveGame } from "../shortcuts";
import { useAutoPlan } from "../hooks/useAutoPlan";
import { useConfig } from "../hooks/useConfig";
import { useLiveStatus } from "../hooks/useLiveStatus";
import { liveStatusMessage } from "../liveControl";
import { restartGame } from "../hooks/useRunningGame";
import type { Game, GameDetail, LiveStatus, RunningGame } from "../types";
import { BasicPanel } from "./BasicPanel";
import { GamesList } from "./GamesList";
import { LiveTiles } from "./LiveStats";
import { LiveOutcome } from "./LiveOutcome";
import { TabStrip } from "./TabStrip";
import { Centered, Notice, Pill } from "./Common";

/**
 * The Quick Access panel: the plugin's front door, opened over a running game.
 *
 * Two tabs, because those are the two things worth doing without leaving the
 * game — change what the running game is doing, or pick a different game to set
 * up. Everything else (all the INI options, monitoring, library management)
 * lives on the full page, which this hands off to.
 *
 * It is deliberately terse. This column is ~310px wide and is read with a game
 * running behind it, so the explanations live on the full page and what is here
 * is the controls, their current state, and nothing else.
 */
export function QuickPanel({
  runningGame,
  onOpenManager,
}: Readonly<{
  runningGame: RunningGame | null;
  onOpenManager: (gamePath?: string, gameName?: string, appid?: string) => void;
}>) {
  // Land on the running game when there is one; otherwise the list is the only
  // thing this panel can usefully show.
  const [tab, setTab] = useState(runningGame ? "now" : "games");

  return (
    <>
      <TabStrip
        tabs={[
          { id: "now", title: "Now Playing" },
          { id: "games", title: "Games" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "now" ? (
        <NowPlayingTab
          key={runningGame?.appid ?? "none"}
          runningGame={runningGame}
          onOpenManager={onOpenManager}
          onBrowse={() => setTab("games")}
        />
      ) : (
        <>
          <GamesList
            onOpenGame={(game: Game) =>
              onOpenManager(game.path, game.name, game.appid ?? undefined)
            }
          />
          <PanelSection>
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => onOpenManager()}>
                Libraries & all settings
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>
        </>
      )}
    </>
  );
}

function NowPlayingTab({
  runningGame,
  onOpenManager,
  onBrowse,
}: Readonly<{
  runningGame: RunningGame | null;
  onOpenManager: (gamePath?: string, gameName?: string, appid?: string) => void;
  onBrowse: () => void;
}>) {
  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [resolving, setResolving] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const activeAppid = useRef(runningGame?.appid ?? null);
  activeAppid.current = runningGame?.appid ?? null;
  const resolveSequence = useRef(0);

  const resolve = useCallback(async () => {
    const request = ++resolveSequence.current;
    const appid = runningGame?.appid ?? null;
    if (!runningGame) {
      setDetail(null);
      setNotFound(false);
      setResolving(false);
      return;
    }
    setResolving(true);
    setNotFound(false);
    try {
      const result = await resolveGame(runningGame.appid);
      if (activeAppid.current !== appid || resolveSequence.current !== request) return;
      if (result.found && result.detail) {
        setDetail(result.detail);
      } else {
        setDetail(null);
        setNotFound(true);
      }
    } catch {
      if (activeAppid.current === appid && resolveSequence.current === request) setNotFound(true);
    } finally {
      if (activeAppid.current === appid && resolveSequence.current === request) {
        setResolving(false);
      }
    }
  }, [runningGame]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  const installed = Boolean(detail?.install.installed);
  const targetDir = installed && detail ? detail.install.path : null;
  // Re-read after the game exits so overlay-side Save is not overwritten.
  const config = useConfig(
    targetDir,
    installed,
    runningGame?.appid ?? null,
    `quick-panel:${runningGame?.appid ?? "none"}`,
    { gamePath: detail?.path ?? "", appid: runningGame ? String(runningGame.appid) : null },
  );
  // This tab is only ever shown over a running game, so the live channel is
  // always worth polling here.
  const { status: live, statusEpoch: liveStatusEpoch, refresh: refreshLive } = useLiveStatus(targetDir, Boolean(runningGame));
  useEffect(() => config.reconcileLiveStatus(live, liveStatusEpoch), [
    config.reconcileLiveStatus, live, liveStatusEpoch, config.livePending,
  ]);
  const runtimeCurrent =
    detail?.install.runtime_current === true && config.runtimeCurrent === true;
  // Read-only over a running game: the mode is chosen on the full page, where
  // the plan it comes from can actually be read.
  const { plan, auto } = useAutoPlan(detail?.path ?? null, detail?.name ?? null, installed);

  if (!runningGame) {
    return (
      <PanelSection title="Nothing running">
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={onBrowse}>
            Browse games
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <>
      <PanelSection title={runningGame.name}>
        {installed ? (
          <PanelSectionRow>
            <LiveTiles live={live} />
          </PanelSectionRow>
        ) : null}
        <PanelSectionRow>
          <div style={{ padding: "2px 0" }}>
            <InstallPill filename={detail?.install.filename} resolving={resolving} />
            {installed ? <LivePill live={live} /> : null}
          </div>
        </PanelSectionRow>
      </PanelSection>

      {resolving ? <Centered>Looking up this game…</Centered> : null}

      {!resolving && notFound ? (
        <PanelSection>
          <PanelSectionRow>
            <Notice tone="warn">Not an installed Steam game — add its folder as a library.</Notice>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => onOpenManager()}>
              Manage games
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {!resolving && !notFound && !installed ? (
        <PanelSection>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() =>
                onOpenManager(detail?.path, detail?.name, String(runningGame.appid))
              }
            >
              Set up OptiScaler
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {installed && detail ? (
        <>
          {/* A write the backend would not take reaches neither the file nor
              the running game, and this is the surface those changes are made
              from, so it has to say so rather than leave the control looking
              as if it worked. */}
          {config.error ? (
            <PanelSection>
              <PanelSectionRow>
                <Notice tone="error" title="Could not save settings">{config.error}</Notice>
              </PanelSectionRow>
            </PanelSection>
          ) : null}

          <LiveOutcome result={config.live} status={live} saving={config.saving} />

          {!runtimeCurrent ? (
            <PanelSection>
              <PanelSectionRow>
                <Notice tone="warn" title="Settings are read-only">
                  Upgrade the OptiScaler runtime in Setup before changing settings.
                </Notice>
              </PanelSectionRow>
            </PanelSection>
          ) : null}

          {config.loading ? (
            <Centered>Reading config…</Centered>
          ) : (
            <BasicPanel
              values={config.values}
              disabled={
                config.loading || config.saving || !runtimeCurrent
              }
              gpu={detail.gpu}
              live={live}
              ffx={detail.install.fsr4?.ffx}
              targetDir={detail.install.path}
              liveResult={config.live}
              onLiveResult={config.recordLiveAction}
              onFlush={config.flush}
              plan={plan}
              auto={auto}
              compact
              onLiveChanged={() => void refreshLive()}
              fsr4Build={config.fsr4Build}
              onEnableFsr4={config.enableFsr4}
              onApply={config.setOptions}
            />
          )}

          {config.restartRequired ? (
            <PanelSection>
              <PanelSectionRow>
                <ButtonItem
                  layout="below"
                  onClick={() => {
                    if (restartGame(runningGame)) {
                      config.clearDirty();
                      toaster.toast({ title: "Restarting", body: runningGame.name });
                    } else {
                      toaster.toast({
                        title: "Could not restart",
                        body: "Relaunch the game manually.",
                      });
                    }
                  }}
                >
                  Restart game to apply
                </ButtonItem>
              </PanelSectionRow>
            </PanelSection>
          ) : null}

          <PanelSection>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                onClick={() =>
                  onOpenManager(detail.path, detail.name, String(runningGame.appid))
                }
              >
                All settings & logs
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>
        </>
      ) : null}
    </>
  );
}

/** Whether OptiScaler is set up for this game, and under which name. */
function InstallPill({
  filename,
  resolving,
}: Readonly<{ filename?: string | null; resolving: boolean }>) {
  if (filename) return <Pill color="#2f6b3f">{filename}</Pill>;
  return <Pill>{resolving ? "checking…" : "not installed"}</Pill>;
}

/** Whether the in-game plugin is answering, shown wherever the game is. */
function LivePill({ live }: Readonly<{ live: LiveStatus | null }>) {
  const state = liveStatusMessage(live);
  if (state.ready) return <Pill color="#2f6b3f">live · ready</Pill>;
  if (state.code === "old") return <Pill color="#5a4a20">live · old module</Pill>;
  if (state.code === "unknown") return <Pill color="#5a4a20">live · unknown</Pill>;
  if (state.code === "not-installed") return <Pill color="#5a4a20">live control off</Pill>;
  return <Pill color="#5a4a20">live · {state.code}</Pill>;
}
