import { ButtonItem, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { clearLog, getMonitor, setLogging } from "../api";
import type { MonitorReport } from "../types";
import { KeyValue, Mono, Notice, Pill } from "./Common";

const REFRESH_MS = 3000;

const LEVEL_COLORS: Record<string, string> = {
  error: "#e05c5c",
  critical: "#e05c5c",
  warning: "#e8a33d",
  info: "#9fb4c7",
  debug: "#7d8b99",
  trace: "#6b7681",
};

export function MonitorTab({
  targetDir,
  live,
  onNeedsRestart,
}: {
  targetDir: string;
  live: boolean;
  onNeedsRestart: () => void;
}) {
  const [report, setReport] = useState<MonitorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setReport(await getMonitor(targetDir));
    } catch {
      /* the game may be mid-write; the next tick will pick it up */
    }
  }, [targetDir]);

  useEffect(() => {
    void refresh();
    if (!live) return;
    timer.current = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [refresh, live]);

  if (!report) {
    return (
      <PanelSection title="Monitoring">
        <PanelSectionRow>
          <Notice tone="info">Reading OptiScaler log…</Notice>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const loggingOn = report.logging_enabled === "true";
  const state = report.state ?? {};
  const problems = report.problems ?? [];

  return (
    <>
      <PanelSection title="Monitoring">
        <PanelSectionRow>
          <ToggleField
            label="Write OptiScaler log"
            description="Monitoring reads OptiScaler.log. Turning this on takes effect at the next game launch."
            checked={loggingOn}
            disabled={busy}
            bottomSeparator="standard"
            onChange={async (checked) => {
              setBusy(true);
              await setLogging(targetDir, checked);
              await refresh();
              onNeedsRestart();
              setBusy(false);
            }}
          />
        </PanelSectionRow>

        {!report.log_present ? (
          <PanelSectionRow>
            <Notice tone="warn" title="No log yet">
              {loggingOn
                ? "Logging is enabled. Launch the game once and the runtime details will appear here."
                : "Enable logging above, then launch the game to see what OptiScaler actually loaded."}
            </Notice>
          </PanelSectionRow>
        ) : null}
      </PanelSection>

      {report.log_present ? (
        <>
          <PanelSection title="Detected at Runtime">
            <PanelSectionRow>
              <div style={{ padding: "2px 0" }}>
                <KeyValue label="Upscaler in use" value={state.upscaler ?? "—"} />
                <KeyValue
                  label="Frame generation"
                  value={
                    report.frame_generation.length > 0
                      ? report.frame_generation.join(", ")
                      : "none detected"
                  }
                />
                <KeyValue label="Loaded as" value={state.proxy ? <Mono>{state.proxy}</Mono> : "—"} />
                <KeyValue label="GPU" value={state.gpu ?? "—"} />
                <KeyValue label="Game" value={state.game_name ?? "—"} />
                <KeyValue label="Executable" value={state.game_exe ? <Mono>{state.game_exe}</Mono> : "—"} />
                <KeyValue label="Game version" value={state.game_version ?? "—"} />
                <KeyValue label="Wine/Proton" value={state.wine ?? "—"} />
                <KeyValue
                  label="Log updated"
                  value={
                    report.log_modified
                      ? new Date(report.log_modified * 1000).toLocaleTimeString()
                      : "—"
                  }
                />
              </div>
            </PanelSectionRow>
          </PanelSection>

          <PanelSection title="Configured (next launch)">
            <PanelSectionRow>
              <div style={{ padding: "2px 0" }}>
                {Object.entries(report.configured ?? {}).map(([key, value]) => (
                  <KeyValue key={key} label={prettyKey(key)} value={value} />
                ))}
              </div>
            </PanelSectionRow>
          </PanelSection>

          <PanelSection title="Log Health">
            <PanelSectionRow>
              <div style={{ padding: "4px 0" }}>
                {Object.entries(report.counts ?? {})
                  .filter(([, count]) => count > 0)
                  .map(([level, count]) => (
                    <Pill key={level} color={LEVEL_COLORS[level]}>
                      {level} {count}
                    </Pill>
                  ))}
                <div style={{ fontSize: "12px", opacity: 0.6, marginTop: "6px" }}>
                  {(report.log_size / 1024).toFixed(0)} KB · {report.total_lines ?? 0} lines read
                </div>
              </div>
            </PanelSectionRow>
          </PanelSection>

          {(report.hints ?? []).length > 0 ? (
            <PanelSection title="What the log is telling you">
              {report.hints.map((hint, index) => (
                <PanelSectionRow key={index}>
                  <Notice tone="warn">{hint}</Notice>
                </PanelSectionRow>
              ))}
            </PanelSection>
          ) : null}

          {problems.length > 0 ? (
            <PanelSection title="Warnings & Errors">
              <PanelSectionRow>
                <LogList entries={problems} />
              </PanelSectionRow>
            </PanelSection>
          ) : null}

          <PanelSection title="Recent Log">
            <PanelSectionRow>
              <LogList entries={(report.recent ?? []).slice(-40)} />
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await clearLog(targetDir);
                  await refresh();
                  setBusy(false);
                }}
              >
                Clear log file
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>
        </>
      ) : null}
    </>
  );
}

function LogList({ entries }: { entries: MonitorReport["recent"] }) {
  return (
    <div
      style={{
        maxHeight: "260px",
        overflowY: "auto",
        background: "rgba(0,0,0,0.25)",
        borderRadius: "3px",
        padding: "6px 8px",
        fontFamily: "monospace",
        fontSize: "11px",
        lineHeight: 1.4,
      }}
    >
      {entries.length === 0 ? (
        <div style={{ opacity: 0.5 }}>Nothing logged.</div>
      ) : (
        entries.map((entry, index) => (
          <div key={index} style={{ color: LEVEL_COLORS[entry.level] ?? "#c8d3dd" }}>
            {entry.time ? <span style={{ opacity: 0.5 }}>{entry.time} </span> : null}
            {entry.message}
          </div>
        ))
      )}
    </div>
  );
}

function prettyKey(key: string) {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
