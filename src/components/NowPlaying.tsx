import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { useCallback, useEffect, useState } from "react";
import { findRunningGame } from "../api";
import { useAutoPlan } from "../hooks/useAutoPlan";
import { useConfig } from "../hooks/useConfig";
import { useLiveStatus } from "../hooks/useLiveStatus";
import type { Game, GameDetail, RunningGame } from "../types";
import { BasicPanel } from "./BasicPanel";
import { Centered, KeyValue, Notice, Pill } from "./Common";
import { LiveStats } from "./LiveStats";

/**
 * The running game's controls, first thing on the page.
 *
 * This is the tab that makes the in-game overlay unnecessary: frame generation,
 * the upscaler and the live frame rate, without leaving the Steam UI.
 */
export function NowPlaying({
  runningGame,
  onOpenGame,
  onBrowse,
}: {
  runningGame: RunningGame | null;
  onOpenGame: (game: Game) => void;
  onBrowse: () => void;
}) {
  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [resolving, setResolving] = useState(false);

  const resolve = useCallback(async () => {
    if (!runningGame) {
      setDetail(null);
      return;
    }
    setResolving(true);
    try {
      const result = await findRunningGame(String(runningGame.appid));
      setDetail(result.found && result.detail ? result.detail : null);
    } catch {
      setDetail(null);
    } finally {
      setResolving(false);
    }
  }, [runningGame]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  const installed = Boolean(detail?.install.installed);
  const targetDir = installed && detail ? detail.install.path : null;
  const config = useConfig(targetDir, installed, runningGame?.appid ?? null);
  const { status: live, refresh } = useLiveStatus(targetDir, Boolean(runningGame));
  // Read-only here: whether a game is in automatic mode is decided where it is
  // set up, not mid-session over a running game.
  const { plan, auto } = useAutoPlan(detail?.path ?? null, detail?.name ?? null, installed);

  if (!runningGame) {
    return (
      <PanelSection title="Nothing running">
        <PanelSectionRow>
          <Notice tone="info">
            Start a game and its frame generation, upscaler and frame rate appear here. Until
            then, pick a game to set up.
          </Notice>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={onBrowse}>
            Browse games
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (resolving && !detail) return <Centered>Looking up {runningGame.name}…</Centered>;

  if (!installed) {
    return (
      <PanelSection title={runningGame.name}>
        <PanelSectionRow>
          <Notice tone="info">
            {detail
              ? "OptiScaler is not installed for this game yet."
              : "This does not look like an installed Steam game, so its folder could not be found."}
          </Notice>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={() => (detail ? onOpenGame(detail as unknown as Game) : onBrowse())}
          >
            {detail ? "Set up OptiScaler" : "Browse games"}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const ffx = detail?.install.fsr4?.ffx;

  return (
    <>
      <PanelSection title={runningGame.name}>
        <PanelSectionRow>
          <div style={{ padding: "2px 0" }}>
            <div style={{ marginBottom: "4px" }}>
              <Pill color="#2f6b3f">OptiScaler · {detail!.install.filename}</Pill>
              {live?.attached ? (
                <Pill color="#2f6b3f">live</Pill>
              ) : (
                <Pill color="#5a4a20">not connected</Pill>
              )}
            </div>
            {/* The version OptiScaler's own FFX Settings box prints. */}
            {ffx?.version ? (
              <KeyValue
                label="FidelityFX"
                value={`${ffx.version}${ffx.fsr4_capable ? " · FSR 4 capable" : ""}`}
              />
            ) : null}
          </div>
        </PanelSectionRow>
      </PanelSection>

      <LiveStats live={live} />

      {config.loading ? (
        <Centered>Reading config…</Centered>
      ) : (
        <BasicPanel
          values={config.values}
          gpu={detail!.gpu}
          live={live}
          targetDir={detail!.install.path}
          plan={plan}
          auto={auto}
          onLiveChanged={() => void refresh()}
          onApply={config.setOptions}
        />
      )}

      <PanelSection>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={() =>
              onOpenGame({
                path: detail!.path,
                name: detail!.name,
                appid: String(runningGame.appid),
              } as Game)
            }
          >
            All settings & monitoring
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}
