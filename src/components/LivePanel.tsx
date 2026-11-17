import { ButtonItem, Field, PanelSection, PanelSectionRow } from "@decky/ui";
import { useState } from "react";
import { getLiveLog, installLive } from "../api";
import { liveFfxFgLabel, liveFrameRates, livePresentPathFps } from "../config/basic";
import { hasVerifiedLiveRuntime, liveStatusMessage } from "../liveControl";
import type { LiveStatus } from "../types";
import { KeyValue, Mono, Notice } from "./Common";

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
/**
 * Why the upscaler cannot be switched, when everything else is working.
 *
 * The two causes need different words: OptiScaler registers a backend only
 * once the game has created an upscaler, which is a matter of waiting, whereas
 * a map this plugin could not locate at all is a build mismatch and waiting
 * will not fix it.
 */
/**
 * What the in-game plugin is actually measuring, when it is attached.
 *
 * The two frame rates come from three separate readings — a frame counter and
 * two frame intervals — and when one of them is missing the panel above simply
 * shows fewer numbers, which is indistinguishable from a game that is not
 * generating any frames. This is where the difference is visible: an interval
 * of "—" is a reading the plugin could not take, and an interval that matches
 * the other is a generator that is not running.
 */
function Measurements({ status }: Readonly<{ status: LiveStatus }>) {
  if (!hasVerifiedLiveRuntime(status)) return null;
  const ms = (value: number | null | undefined) =>
    typeof value === "number" && value > 0 ? `${value.toFixed(2)} ms` : "—";
  const fps = (value: number | null | undefined) =>
    typeof value === "number" && value > 0 ? `${value.toFixed(1)} fps` : "—";
  const rates = liveFrameRates(status);
  const coreIntervals = status.telemetry_ready === true && status.telemetry_source === "core_intervals";
  const presentPathFps = livePresentPathFps(status);
  return (
    <PanelSectionRow>
      <div style={{ padding: "2px 0" }}>
        {rates ? (
          <>
            <KeyValue label="Presented rate" value={fps(rates.total)} />
            <KeyValue
              label="Rendered rate"
              value={
                rates.base === null
                  ? "not reported by the in-game plugin"
                  : fps(rates.base)
              }
            />
          </>
        ) : coreIntervals ? (
          <KeyValue
            label="Present path FPS"
            value={presentPathFps === null ? "unavailable" : fps(presentPathFps)}
          />
        ) : (
          <KeyValue label="Frame counter rate" value={fps(status.fps)} />
        )}
        {status.fg_enabled !== null ? (
          <KeyValue
            label="Frame generation active"
            value={status.fg_enabled ? "on" : "off"}
          />
        ) : null}
        {typeof status.configured_fg_enabled === "boolean" ? (
          <KeyValue
            label="Frame generation configured"
            value={status.configured_fg_enabled ? "on" : "off"}
          />
        ) : null}
        {status.ffx_fg_versions?.length ? (
          <KeyValue
            label="FFX frame generator"
            value={liveFfxFgLabel(status) ?? "not identified by the runtime"}
          />
        ) : null}
        {status.telemetry_ready === true ? (
          <KeyValue
            label="Intervals"
            value={`${ms(status.presented_ms)} present · ${ms(status.rendered_ms)} fg`}
          />
        ) : null}
        {/* Which build of the in-game plugin produced the line above. An older
            one does not report the intervals at all, and the two rates are then
            missing for a reason that has nothing to do with how they are
            derived — so the version belongs next to the numbers, not somewhere
            else on the page. */}
        <KeyValue
          label="In-game plugin"
          value={
            status.schema === null || status.schema === undefined
              ? "did not report a version"
              : `format ${status.schema}${
                  status.asi_current === false
                    ? " · older than the one shipped here"
                    : status.asi_current
                      ? " · current"
                      : ""
                }`
          }
        />
        {rates && !rates.generating ? (
          <KeyValue
            label="Frame generation"
            value="on, but no frames are being generated"
          />
        ) : null}
      </div>
    </PanelSectionRow>
  );
}

export function LivePanel({ targetDir, status, running = false, onBeforeMutation, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);

  if (!status) {
    return (
      <PanelSection title="Live in-game control">
        <PanelSectionRow>
          <Notice tone="info" title="Waiting for live status">
            The game has not reported a live-control state for this target yet.
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
    <PanelSection title="Live in-game control">
      {error ? (
        <PanelSectionRow>
          <Notice tone="error" title="Live control action failed">{error}</Notice>
        </PanelSectionRow>
      ) : null}
      {restartNeeded ? (
        <PanelSectionRow>
          <Notice tone="info" title="Restart the game to load the change">
            Live control was installed successfully. Close and relaunch the game before checking
            its status.
          </Notice>
        </PanelSectionRow>
      ) : null}
      <PanelSectionRow>{body}</PanelSectionRow>

      <Measurements status={status} />

      {/* The plugin derives its own folder from where OptiScaler loaded it. If
          that ever disagrees with the folder being managed, it is writing where
          nothing is reading — which is exactly how it failed silently before. */}
      {status.dir_matches === false ? (
        <PanelSectionRow>
          <Notice tone="warn" title="Reporting from a different folder">
            The in-game plugin is writing to <Mono>{status.dir}</Mono>, which is not this
            game's OptiScaler folder. Reinstall live control below.
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
                  setError(result.error ?? "Could not install live control.");
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
            {status.asi_installed ? "Reinstall live control" : "Add live control"}
          </ButtonItem>
        </PanelSectionRow>
      ) : null}
      {status.can_install === true && !status.attached && gameRunning ? (
        <PanelSectionRow>
          <Notice tone="info" title="Close the game before repairing live control">
            The running module may be mapped into the game process. Stop the game, then add or reinstall it here.
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
            {log ? "Refresh diagnostics" : "Show diagnostics"}
          </ButtonItem>
        </PanelSectionRow>
      ) : null}

      {log ? (
        <PanelSectionRow>
          <Field label="Plugin log" bottomSeparator="none">
            <div style={{ fontSize: "11px", opacity: 0.8, maxHeight: "160px", overflowY: "auto" }}>
              {log.length === 0 ? (
                <div>No log yet — it is written the first time the game runs.</div>
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
