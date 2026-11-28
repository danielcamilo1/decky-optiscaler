import { ButtonItem, Field, PanelSection, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";
import { getLiveLog, installLive } from "../api";
import { useI18n } from "../i18n";
import { hasVerifiedLiveRuntime, liveStatusMessage } from "../liveControl";
import type { LiveStatus } from "../types";
import { Notice } from "./Common";
import { LiveTelemetryList } from "./LiveStats";

interface Props {
  targetDir: string;
  status: LiveStatus | null;
  /** Steam reports the game running even if its live module never attached. */
  running?: boolean;
  onBeforeMutation?: () => Promise<void> | void;
  onChanged: () => Promise<void> | void;
}

/**
 * Status and repair for the in-game live-control plugin.
 *
 * OptiScaler reads its config once, at startup. The plugin shipped here is an
 * .asi that OptiScaler loads into the game, letting frame generation and the
 * upscaler change while playing instead of on the next launch.
 */
export function LivePanel({ targetDir, status, running = false, onBeforeMutation, onChanged }: Props) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);

  // Clear the post-install hint whenever switching targets or once the game attaches.
  useEffect(() => {
    setRestartNeeded(false);
  }, [targetDir, status?.attached]);

  if (!status) {
    return (
      <PanelSection title={t("Live in-game control")}>
        <PanelSectionRow>
          <Notice tone="info" title={t("Waiting for live status")}>
            {t("Waiting for live-control status from this game.")}
          </Notice>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const liveState = liveStatusMessage(status);
  const gameRunning = running || status.legacy_running === true;
  const body = (
    <Notice tone={liveState.tone} title={liveState.title}>
      {liveState.detail}
    </Notice>
  );

  return (
    <PanelSection title={t("Live in-game control")}>
      {error ? (
        <PanelSectionRow>
          <Notice tone="error" title={t("Live control action failed")}>{error}</Notice>
        </PanelSectionRow>
      ) : null}
      {restartNeeded ? (
        <PanelSectionRow>
          <Notice tone="info" title={t("Start the game to activate live control")}>
            {t("Installed — start the game to activate live control.")}
          </Notice>
        </PanelSectionRow>
      ) : null}
      <PanelSectionRow>{body}</PanelSectionRow>

      {hasVerifiedLiveRuntime(status) ? (
        <PanelSectionRow>
          <LiveTelemetryList live={status} diagnostic />
        </PanelSectionRow>
      ) : null}

      {/* The plugin derives its own folder from where OptiScaler loaded it. If
          that ever disagrees with the folder being managed, it is writing where
          nothing is reading — which is exactly how it failed silently before. */}
      {status.dir_matches === false ? (
        <PanelSectionRow>
          <Notice tone="warn" title={t("Reporting from a different folder")}>
            {t("Plugin is writing to {dir} instead of this folder. Reinstall live control below.", {
              dir: status.dir ?? "",
            })}
          </Notice>
        </PanelSectionRow>
      ) : null}

      {status.can_install === true && !status.attached ? (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy || gameRunning}
            onClick={async () => {
              if (busy || gameRunning) return;
              setBusy(true);
              setError(null);
              setRestartNeeded(false);
              try {
                await onBeforeMutation?.();
                const result = await installLive(targetDir);
                if (!result.ok) {
                  setError(result.error ?? t("Could not install live control."));
                  return;
                }
                setRestartNeeded(true);
                await onChanged();
              } catch (exc) {
                setError(String(exc));
              } finally {
                setBusy(false);
              }
            }}
          >
            {status.asi_installed ? t("Reinstall live control") : t("Add live control")}
          </ButtonItem>
        </PanelSectionRow>
      ) : null}
      {status.can_install === true && !status.attached && gameRunning ? (
        <PanelSectionRow>
          <Notice tone="info" title={t("Close the game before repairing live control")}>
            {t("Stop the game before adding or reinstalling the live module.")}
          </Notice>
        </PanelSectionRow>
      ) : null}

      {status.asi_installed ? (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setLog((await getLiveLog(targetDir, 30)).lines);
              } catch (exc) {
                setError(String(exc));
              } finally {
                setBusy(false);
              }
            }}
          >
            {log ? t("Refresh diagnostics") : t("Show diagnostics")}
          </ButtonItem>
        </PanelSectionRow>
      ) : null}

      {log ? (
        <PanelSectionRow>
          <Field label={t("Plugin log")} bottomSeparator="none">
            <div style={{ fontSize: "11px", opacity: 0.8, maxHeight: "160px", overflowY: "auto" }}>
              {log.length === 0 ? (
                <div>{t("No log yet — it is written the first time the game runs.")}</div>
              ) : (
                log.map((line, index) => <div key={index}>{line}</div>)
              )}
            </div>
          </Field>
        </PanelSectionRow>
      ) : null}
    </PanelSection>
  );
}
