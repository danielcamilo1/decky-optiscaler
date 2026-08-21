import { ButtonItem, Field, PanelSection, PanelSectionRow } from "@decky/ui";
import { useState } from "react";
import { getLiveLog, installLive } from "../api";
import { liveFrameRates } from "../config/basic";
import type { LiveStatus } from "../types";
import { KeyValue, Mono, Notice } from "./Common";

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
  if (!status.attached) return null;
  const ms = (value: number | null | undefined) =>
    typeof value === "number" && value > 0 ? `${value.toFixed(2)} ms` : "—";
  const fps = (value: number | null | undefined) =>
    typeof value === "number" && value > 0 ? `${value.toFixed(1)} fps` : "—";
  const rates = liveFrameRates(status);
  return (
    <PanelSectionRow>
      <div style={{ padding: "2px 0" }}>
        <KeyValue label="Presented" value={fps(status.total_fps)} />
        <KeyValue label="Rendered" value={fps(status.base_fps)} />
        {/* The raw slots, named after where in State they came from rather than
            after a role: which one is the presented interval is decided from
            the numbers above, and seeing both is how a slot that was never
            written tells itself apart from a generator that is idle. */}
        <KeyValue
          label="Intervals"
          value={`${ms(status.presented_ms)} present · ${ms(status.rendered_ms)} fg · ${fps(status.fps)} counted`}
        />
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

      {/* The plugin ships an ASI; each game holds its own copy of it, taken at
          set-up time. Updating the plugin does not update those, so a game can
          be attached and answering while missing everything added since — which
          reads as the new feature not existing rather than as an old plugin.
          The copy is deliberately not offered while the game is running: the
          DLL is mapped into it, and truncating a mapped file is how you take
          the game down with you. */}
      {status.asi_current === false ? (
        <PanelSectionRow>
          <Notice tone="warn" title="The in-game plugin is out of date">
            This game has an older build of the live-control plugin than the one shipped here.
            It still works, but anything added since is missing — including the rendered frame
            rate and the FSR version list.
            {status.attached
              ? " Close the game, then reinstall live control here."
              : " Reinstall live control below."}
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
