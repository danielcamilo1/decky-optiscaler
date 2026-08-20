import { ButtonItem, Field, PanelSection, PanelSectionRow } from "@decky/ui";
import { useState } from "react";
import { getLiveLog, installLive } from "../api";
import type { LiveStatus } from "../types";
import { Mono, Notice } from "./Common";

interface Props {
  targetDir: string;
  status: LiveStatus | null;
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
function upscalerBlockedReason(status: LiveStatus) {
  if (status.backend_entries === 0) {
    return "Upscaler switching turns on once the game has drawn its first upscaled frame.";
  }
  return "Upscaler switching is unavailable: OptiScaler's backend list could not be read.";
}

export function LivePanel({ targetDir, status, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[] | null>(null);

  if (!status) return null;

  // Each of these is a different failure with a different fix, and the whole
  // point of reporting them separately is that "not connected" on its own tells
  // the user nothing about what to do next.
  const chain = status.attached ? null : !status.asi_available ? (
    <Notice tone="warn" title="Not included in this build">
      This copy of the plugin was packaged without the live-control module, so every setting
      needs a game restart.
    </Notice>
  ) : !status.asi_installed ? (
    <Notice tone="info" title="Not installed for this game">
      Add it below to change frame generation and the upscaler without restarting.
    </Notice>
  ) : status.load_enabled === false ? (
    <Notice tone="warn" title="OptiScaler is not set to load plugins">
      <b>LoadAsiPlugins</b> is off in OptiScaler.ini, and it defaults to off — so the plugin
      is installed but never loaded. Use <b>Add live control</b> below to switch it on.
    </Notice>
  ) : status.loaded_by_optiscaler === false ? (
    <Notice tone="warn" title="OptiScaler did not load it">
      OptiScaler searched its plugins folder this run and did not load the module. Check that
      it is still in <Mono>plugins/</Mono> next to OptiScaler.
    </Notice>
  ) : null;

  const body = chain ? (
    chain
  ) : status.attached ? (
    <Notice tone="success" title="Connected to the running game">
      Frame generation
      {status.can_switch_upscaler ? " and the upscaler apply" : " applies"} immediately.
      {status.can_switch_upscaler ? "" : ` ${upscalerBlockedReason(status)}`}
    </Notice>
  ) : status.state === "failed" ? (
    <Notice tone="warn" title="Loaded, but could not attach">
      {status.error || "It could not locate OptiScaler's settings in memory."} This usually
      means the game is running a different OptiScaler build than the one bundled here.
      Everything still works through a restart.
    </Notice>
  ) : (
    <Notice tone="info" title="Installed, waiting for the game">
      It reports in a few seconds after the game starts.
      {status.state !== "absent" ? ` Last state: ${status.state}.` : ""}
      {status.loaded_by_optiscaler ? " OptiScaler's log says it was loaded." : ""}
    </Notice>
  );

  return (
    <PanelSection title="Live in-game control">
      <PanelSectionRow>{body}</PanelSectionRow>

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

      {status.asi_available && !status.attached ? (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await installLive(targetDir);
                await onChanged();
              } finally {
                setBusy(false);
              }
            }}
          >
            {status.asi_installed ? "Reinstall live control" : "Add live control"}
          </ButtonItem>
        </PanelSectionRow>
      ) : null}

      {status.asi_installed ? (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setLog((await getLiveLog(targetDir, 30)).lines);
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
