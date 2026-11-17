import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveGame } from "../shortcuts";
import { useAutoPlan } from "../hooks/useAutoPlan";
import { useConfig } from "../hooks/useConfig";
import { useLiveStatus } from "../hooks/useLiveStatus";
import { liveStatusMessage } from "../liveControl";
import type { Game, GameDetail, RunningGame } from "../types";
import { restartGame } from "../hooks/useRunningGame";
import { BasicPanel } from "./BasicPanel";
import { Centered, KeyValue, Notice, Pill } from "./Common";
import { LiveStats } from "./LiveStats";
import { LiveOutcome } from "./LiveOutcome";

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
  const activeAppid = useRef(runningGame?.appid ?? null);
  activeAppid.current = runningGame?.appid ?? null;
  const resolveSequence = useRef(0);

  const resolve = useCallback(async () => {
    const request = ++resolveSequence.current;
    const appid = runningGame?.appid ?? null;
    if (!runningGame) {
      setDetail(null);
      setResolving(false);
      return;
    }
    setResolving(true);
    try {
      const result = await resolveGame(runningGame.appid);
      if (activeAppid.current !== appid || resolveSequence.current !== request) return;
      setDetail(result.found && result.detail ? result.detail : null);
    } catch {
      if (activeAppid.current === appid && resolveSequence.current === request) setDetail(null);
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
  const config = useConfig(
    targetDir,
    installed,
    runningGame?.appid ?? null,
    `now-playing:${runningGame?.appid ?? "none"}`,
    { gamePath: detail?.path ?? "", appid: runningGame ? String(runningGame.appid) : null },
  );
  const { status: live, statusEpoch: liveStatusEpoch, refresh } = useLiveStatus(targetDir, Boolean(runningGame));
  useEffect(() => config.reconcileLiveStatus(live, liveStatusEpoch), [
    config.reconcileLiveStatus, live, liveStatusEpoch, config.livePending,
  ]);
  const runtimeCurrent =
    detail?.install.runtime_current === true && config.runtimeCurrent === true;
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
  const liveView = liveStatusMessage(live);

  return (
    <>
      <PanelSection title={runningGame.name}>
        <PanelSectionRow>
          <div style={{ padding: "2px 0" }}>
            <div style={{ marginBottom: "4px" }}>
              <Pill color="#2f6b3f">OptiScaler · {detail!.install.filename}</Pill>
              <Pill color={liveView.ready ? "#2f6b3f" : "#5a4a20"}>live · {liveView.code}</Pill>
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
          gpu={detail!.gpu}
          live={live}
          ffx={ffx}
          targetDir={detail!.install.path}
          liveResult={config.live}
          onLiveResult={config.recordLiveAction}
          onFlush={config.flush}
          plan={plan}
          auto={auto}
          onLiveChanged={() => void refresh()}
          fsr4Build={config.fsr4Build}
          onEnableFsr4={config.enableFsr4}
          onApply={config.setOptions}
        />
      )}

      {config.error ? (
        <PanelSection>
          <PanelSectionRow>
            <Notice tone="error" title="Could not save OptiScaler settings">
              {config.error}
            </Notice>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={config.loading} onClick={() => void config.reload()}>
              Reload settings
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {config.restartRequired ? (
        <PanelSection>
          <PanelSectionRow>
            <Notice tone="warn" title="Restart the game to apply">
              These settings were saved, but the running game did not confirm that they took effect.
            </Notice>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() => {
                if (restartGame(runningGame)) {
                  config.clearDirty();
                  toaster.toast({ title: "Restarting", body: runningGame.name });
                } else {
                  toaster.toast({ title: "Could not restart", body: "Relaunch the game manually." });
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
