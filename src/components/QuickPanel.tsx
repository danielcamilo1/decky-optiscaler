import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useState } from "react";
import { findRunningGame } from "../api";
import { useAutoPlan } from "../hooks/useAutoPlan";
import { useConfig } from "../hooks/useConfig";
import { useLiveStatus } from "../hooks/useLiveStatus";
import { restartGame } from "../hooks/useRunningGame";
import type { Game, GameDetail, LiveStatus, RunningGame } from "../types";
import { BasicPanel } from "./BasicPanel";
import { GamesList } from "./GamesList";
import { LiveTiles } from "./LiveStats";
import { TabStrip } from "./TabStrip";
import { Centered, Notice, Pill } from "./Common";
import { MULTIPLIER_KEY, MULTIPLIER_SECTION, supportsMultiplier } from "../config/basic";
import { curatedLabel } from "../config/labels";

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

  const resolve = useCallback(async () => {
    if (!runningGame) {
      setDetail(null);
      setNotFound(false);
      return;
    }
    setResolving(true);
    setNotFound(false);
    try {
      const result = await findRunningGame(String(runningGame.appid));
      if (result.found && result.detail) {
        setDetail(result.detail);
      } else {
        setDetail(null);
        setNotFound(true);
      }
    } catch {
      setNotFound(true);
    } finally {
      setResolving(false);
    }
  }, [runningGame]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  const installed = Boolean(detail?.install.installed);
  const targetDir = installed && detail ? detail.install.path : null;
  // Re-read after the game exits so overlay-side Save is not overwritten.
  const config = useConfig(targetDir, installed, runningGame?.appid ?? null);
  // This tab is only ever shown over a running game, so the live channel is
  // always worth polling here.
  const { status: live, refresh: refreshLive } = useLiveStatus(targetDir, Boolean(runningGame));
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

  // Only meaningful on the XeSS frame generator, which is the one that can do
  // more than 2X; anywhere else it would be a number that means nothing.
  const multiplier = supportsMultiplier(config.values)
    ? config.values[MULTIPLIER_SECTION]?.[MULTIPLIER_KEY]
    : null;
  const fgSub = multiplier
    ? curatedLabel(`${MULTIPLIER_SECTION}.${MULTIPLIER_KEY}`, multiplier)
    : undefined;

  return (
    <>
      <PanelSection title={runningGame.name}>
        {installed ? (
          <PanelSectionRow>
            <LiveTiles live={live} fgSub={fgSub} />
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
          {config.loading ? (
            <Centered>Reading config…</Centered>
          ) : (
            <BasicPanel
              values={config.values}
              gpu={detail.gpu}
              live={live}
              targetDir={detail.install.path}
              plan={plan}
              auto={auto}
              compact
              onLiveChanged={() => void refreshLive()}
              onApply={config.setOptions}
            />
          )}

          {config.dirty ? (
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
  if (!live) return null;
  if (live.attached) {
    return <Pill color="#2f6b3f">live{live.can_switch_upscaler ? "" : " · fg only"}</Pill>;
  }
  if (!live.asi_installed) return <Pill color="#5a4a20">live control off</Pill>;
  return <Pill color="#5a4a20">not connected</Pill>;
}
