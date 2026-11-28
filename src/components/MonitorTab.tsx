import { ButtonItem, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { clearLog, getMonitor, setLogging } from "../api";
import { useI18n } from "../i18n";
import type { MonitorReport } from "../types";
import { KeyValue, Mono, Notice, Pill, TONE_COLORS } from "./Common";

const REFRESH_MS = 3000;

const LEVEL_COLORS: Record<string, string> = {
  error: TONE_COLORS.error,
  critical: TONE_COLORS.error,
  warning: TONE_COLORS.warn,
  info: "#9fb4c7",
  debug: "#7d8b99",
  trace: "#6b7681",
};

export function MonitorTab({
  targetDir,
  live,
  readOnly = false,
  onBeforeMutation,
  onNeedsRestart,
}: {
  targetDir: string;
  live: boolean;
  readOnly?: boolean;
  onBeforeMutation?: () => Promise<void> | void;
  onNeedsRestart: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<MonitorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);
  const reportRef = useRef<MonitorReport | null>(null);
  reportRef.current = report;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (background = false) => {
      const seq = ++requestSeqRef.current;
      if (!background && reportRef.current === null) {
        setLoading(true);
      }
      if (!background) {
        setError(null);
      }
      try {
        const next = await getMonitor(targetDir);
        if (!mountedRef.current || requestSeqRef.current !== seq) return;
        setReport(next);
      } catch (exc) {
        if (!mountedRef.current || requestSeqRef.current !== seq) return;
        if (!background || reportRef.current === null) {
          setError(String(exc));
        }
      } finally {
        if (mountedRef.current && requestSeqRef.current === seq) {
          setLoading(false);
        }
      }
    },
    [targetDir],
  );

  useEffect(() => {
    void refresh(false);
    if (!live) return;
    timer.current = window.setInterval(() => void refresh(true), REFRESH_MS);
    return () => {
      if (timer.current !== null) {
        window.clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [refresh, live]);

  if (!report) {
    return (
      <PanelSection title={t("Monitoring")}>
        <PanelSectionRow>
          {loading ? (
            <Notice tone="info">{t("Reading OptiScaler log…")}</Notice>
          ) : error ? (
            <Notice tone="error" title={t("Could not read OptiScaler log")}>{error}</Notice>
          ) : (
            <Notice tone="info">{t("No OptiScaler log is available yet.")}</Notice>
          )}
        </PanelSectionRow>
        {!loading ? (
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => void refresh(false)}>
              {t("Try again")}
            </ButtonItem>
          </PanelSectionRow>
        ) : null}
      </PanelSection>
    );
  }

  const runLogging = async (checked: boolean) => {
    if (readOnly || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onBeforeMutation?.();
      const result = await setLogging(targetDir, checked);
      if (!result.ok) throw new Error(result.error ?? t("Could not update logging."));
      await refresh(false);
      await onNeedsRestart();
    } catch (exc) {
      if (mountedRef.current) setError(String(exc));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const runClear = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await clearLog(targetDir);
      if (!result.ok) throw new Error(result.error ?? t("Could not clear the log."));
      await refresh(false);
    } catch (exc) {
      if (mountedRef.current) setError(String(exc));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const loggingOn = report.logging_enabled === "true";
  const state = report.state ?? {};
  const problems = report.problems ?? [];

  return (
    <>
      {error ? (
        <PanelSection title={t("Monitoring")}>
          <PanelSectionRow>
            <Notice tone="error" title={t("Monitoring action failed")}>{error}</Notice>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => void refresh(false)}>
              {t("Refresh log")}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      <PanelSection title={t("Monitoring")}>
        <PanelSectionRow>
          <ToggleField
            label={t("Write OptiScaler log")}
            description={
              readOnly
                ? t("Upgrade runtime in Setup before changing.")
                : t("Writes OptiScaler.log on next game launch.")
            }
            checked={loggingOn}
            disabled={busy || readOnly}
            bottomSeparator="standard"
            onChange={(checked) => void runLogging(checked)}
          />
        </PanelSectionRow>

        {!report.log_present ? (
          <PanelSectionRow>
            <Notice tone="warn" title={t("No log yet")}>
              {loggingOn
                ? t("Logging is on — launch the game once to populate details.")
                : t("Turn on logging above, then launch the game.")}
            </Notice>
          </PanelSectionRow>
        ) : null}
      </PanelSection>

      {report.log_present ? (
        <>
          <PanelSection title={t("Detected at Runtime")}>
            <PanelSectionRow>
              <div style={{ padding: "2px 0" }}>
                <KeyValue label={t("Upscaler in use")} value={state.upscaler ?? "—"} />
                <KeyValue
                  label={t("Frame generation")}
                  value={
                    report.frame_generation.length > 0
                      ? report.frame_generation.join(", ")
                      : t("none detected")
                  }
                />
                <KeyValue label={t("Loaded as")} value={state.proxy ? <Mono>{state.proxy}</Mono> : "—"} />
                <KeyValue label={t("GPU")} value={state.gpu ?? "—"} />
                <KeyValue label={t("Game")} value={state.game_name ?? "—"} />
                <KeyValue label={t("Executable")} value={state.game_exe ? <Mono>{state.game_exe}</Mono> : "—"} />
                <KeyValue label={t("Game version")} value={state.game_version ?? "—"} />
                <KeyValue label={t("Wine/Proton")} value={state.wine ?? "—"} />
                <KeyValue
                  label={t("Log updated")}
                  value={
                    report.log_modified
                      ? new Date(report.log_modified * 1000).toLocaleTimeString()
                      : "—"
                  }
                />
              </div>
            </PanelSectionRow>
          </PanelSection>

          <PanelSection title={t("Configured (next launch)")}>
            <PanelSectionRow>
              <div style={{ padding: "2px 0" }}>
                {Object.entries(report.configured ?? {}).map(([key, value]) => (
                  <KeyValue key={key} label={prettyKey(key)} value={value} />
                ))}
              </div>
            </PanelSectionRow>
          </PanelSection>

          <PanelSection title={t("Log Health")}>
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
                  {t("{kb} KB · {lines} lines read", {
                    kb: (report.log_size / 1024).toFixed(0),
                    lines: report.total_lines ?? 0,
                  })}
                </div>
              </div>
            </PanelSectionRow>
          </PanelSection>

          {(report.hints ?? []).length > 0 ? (
            <PanelSection title={t("What the log is telling you")}>
              {report.hints.map((hint, index) => (
                <PanelSectionRow key={index}>
                  <Notice tone="warn">{hint}</Notice>
                </PanelSectionRow>
              ))}
            </PanelSection>
          ) : null}

          {problems.length > 0 ? (
            <PanelSection title={t("Warnings & Errors")}>
              <PanelSectionRow>
                <LogList entries={problems} />
              </PanelSectionRow>
            </PanelSection>
          ) : null}

          <PanelSection title={t("Recent Log")}>
            <PanelSectionRow>
              <LogList entries={(report.recent ?? []).slice(-40)} />
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={busy}
                onClick={() => void runClear()}
              >
                {t("Clear log file")}
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>
        </>
      ) : null}
    </>
  );
}

function LogList({ entries }: { entries: MonitorReport["recent"] }) {
  const { t } = useI18n();
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
        <div style={{ opacity: 0.5 }}>{t("Nothing logged.")}</div>
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
