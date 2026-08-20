import {
  ButtonItem,
  DialogButton,
  Field,
  Focusable,
  PanelSection,
  PanelSectionRow,
  Tabs,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useState } from "react";
import { applyAutoSettings, getGame } from "../api";
import { TABS } from "../config/tabs";
import { useAutoPlan } from "../hooks/useAutoPlan";
import { useConfig } from "../hooks/useConfig";
import { restartGame } from "../hooks/useRunningGame";
import { useLiveStatus } from "../hooks/useLiveStatus";
import type { GameDetail as GameDetailData, PayloadStatus, RunningGame } from "../types";
import { BasicPanel } from "./BasicPanel";
import { Centered, Pill } from "./Common";
import { ConfigTab } from "./ConfigTab";
import { DetailHeader, ModeSwitch } from "./DetailHeader";
import { InstallPanel } from "./InstallPanel";
import { LiveStats } from "./LiveStats";
import { MonitorTab } from "./MonitorTab";
import { SetupChecklist } from "./SetupChecklist";

const ADVANCED_KEY = "decky-optiscaler:advanced";

function loadAdvanced(): boolean {
  try {
    return window.localStorage.getItem(ADVANCED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveAdvanced(value: boolean) {
  try {
    window.localStorage.setItem(ADVANCED_KEY, value ? "1" : "0");
  } catch {
    /* storage is unavailable in some Steam UI contexts */
  }
}

interface Props {
  gamePath: string;
  gameName: string;
  appid: string | null;
  status: PayloadStatus | null;
  runningGame: RunningGame | null;
  onBack: () => void;
}

/**
 * The way back out of "Manual setup" and "Logs".
 *
 * A real button rather than a styled `Focusable`: these views open in the Setup
 * tab's place, so B is the page's own back action and cannot be the one that
 * returns here — the row *is* the only way back, and a `Focusable` that happens
 * to take activation was too easy to read as a heading and scroll straight past.
 * It is rendered at both ends of the view it heads, because the manual panel is
 * several screens long and scrolling back to the top to leave it is not a way
 * out either.
 */
function BackRow({
  label,
  onBack,
  position = "top",
}: {
  label: string;
  onBack: () => void;
  position?: "top" | "bottom";
}) {
  const top = position === "top";
  return (
    <Focusable
      style={{ display: "flex", margin: top ? "2px 0 6px" : "10px 0 4px", padding: "0 2px" }}
    >
      <DialogButton
        onClick={onBack}
        onOKActionDescription="Back to setup"
        // Marker for the UI harness, the same way TabStrip marks its tabs.
        {...({ "data-back": "setup" } as Record<string, string>)}
        style={{
          flexGrow: 1,
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          fontSize: "14px",
          minWidth: 0,
        }}
      >
        <span style={{ opacity: 0.7 }}>‹</span>
        {top ? (
          <>
            <span style={{ opacity: 0.7 }}>Setup</span>
            <span style={{ opacity: 0.4 }}>/</span>
            <span style={{ fontWeight: 600 }}>{label}</span>
          </>
        ) : (
          <span style={{ fontWeight: 600 }}>Back to guided setup</span>
        )}
      </DialogButton>
    </Focusable>
  );
}

/** Wraps a tab's content so it scrolls within the tab area when it can, and
 *  falls back to scrolling the page when the flex height does not resolve. */
function TabBody({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ maxHeight: "100%", overflowY: "auto", paddingBottom: "24px" }}>
      {children}
    </div>
  );
}

export function GameDetail({
  gamePath,
  gameName,
  appid,
  status,
  runningGame,
  onBack,
}: Props) {
  const [detail, setDetail] = useState<GameDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("install");
  const [advanced, setAdvanced] = useState(loadAdvanced);
  // The Setup tab is a checklist; the two things it links to open in its place
  // rather than as tabs of their own, because neither is a place to live.
  const [setupView, setSetupView] = useState<"checklist" | "manual" | "logs">("checklist");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await getGame(gamePath, gameName));
    } catch (exc) {
      toaster.toast({ title: "Could not read game", body: String(exc) });
    } finally {
      setLoading(false);
    }
  }, [gamePath, gameName]);

  useEffect(() => {
    void load();
  }, [load]);

  // A different game starts at the top of its own checklist.
  useEffect(() => {
    setSetupView("checklist");
  }, [gamePath]);

  const installed = Boolean(detail?.install.installed);
  const targetDir = detail?.install.installed ? detail.install.path : null;
  const isRunning =
    runningGame !== null && appid !== null && String(runningGame.appid) === appid;
  // OptiScaler's overlay writes the ini when the user hits Save in-game, so
  // re-read it whenever this game stops running rather than trusting our copy.
  const config = useConfig(targetDir, installed, isRunning);
  const { status: liveStatus } = useLiveStatus(targetDir, isRunning);
  const {
    plan,
    recommendation,
    loading: loadingWiki,
    auto,
    setAuto,
    reload: reloadPlan,
  } = useAutoPlan(gamePath, gameName);

  /**
   * Switching automatic on re-applies the wiki's settings; switching it off
   * only stops them being maintained.
   *
   * Turning it off deliberately does not undo anything. The wiki's settings are
   * the ones that make the game work at all, so reverting them on the way to
   * "let me adjust one thing myself" would break the game to grant a wish
   * nobody made — the point of the switch is that every option becomes
   * editable, not that the game goes back to stock.
   */
  const changeAuto = async (enabled: boolean) => {
    await setAuto(enabled);
    if (!enabled || !targetDir) return;
    const folder = gamePath.split("/").filter(Boolean).pop() ?? gameName;
    const result = await applyAutoSettings(targetDir, gamePath, gameName, [folder]);
    if (result.ok) {
      await config.reload();
      toaster.toast({ title: "Automatic settings applied", body: detailName(plan, gameName) });
    } else {
      toaster.toast({ title: "Could not apply the wiki settings", body: String(result.error) });
    }
  };

  // Land on the settings tab once a game is set up; Setup is only interesting
  // before that, or when changing the install.
  useEffect(() => {
    if (installed) setActiveTab(advanced ? TABS[0].id : "basic");
  }, [installed]);

  /** Basic and advanced are the same switch, reached from two places. */
  const showAdvanced = (value: boolean) => {
    setAdvanced(value);
    saveAdvanced(value);
    setActiveTab(value ? TABS[0].id : "basic");
  };

  const isThisGameRunning = isRunning;

  if (loading && !detail) return <Centered>Reading game folder…</Centered>;
  if (!detail) {
    return (
      <Centered>
        <div>Could not read that game folder.</div>
        <ButtonItem layout="below" onClick={onBack}>
          Back
        </ButtonItem>
      </Centered>
    );
  }

  // Changes the running game already took need no restart, so say so instead of
  // nagging: this is the whole point of the in-game live-control plugin.
  const liveBanner =
    installed && !config.dirty && config.live?.sent ? (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          margin: "0 12px 4px",
          padding: "5px 9px",
          borderLeft: "3px solid #4c9b4c",
          background: "rgba(76,155,76,0.12)",
          borderRadius: "3px",
          fontSize: "12px",
          flexShrink: 0,
        }}
      >
        <span style={{ flexGrow: 1 }}>
          Applied in-game — no restart needed.
          {config.live.backend_change ? " The upscaler reloads on the next frame." : ""}
        </span>
      </div>
    ) : null;

  const restartBanner =
    installed && config.dirty ? (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          margin: "0 12px 4px",
          padding: "5px 9px",
          borderLeft: "3px solid #e8a33d",
          background: "rgba(232,163,61,0.12)",
          borderRadius: "3px",
          fontSize: "12px",
          flexShrink: 0,
        }}
      >
        <span style={{ flexGrow: 1 }}>
          Saved. OptiScaler reads its config at launch, so restart the game to apply.
        </span>
        {isThisGameRunning && runningGame ? (
          <button
            onClick={() => {
              if (restartGame(runningGame)) {
                config.clearDirty();
                toaster.toast({ title: "Restarting", body: detail.name });
              } else {
                toaster.toast({ title: "Could not restart", body: "Relaunch manually." });
              }
            }}
            style={{
              background: "#e8a33d",
              border: "none",
              borderRadius: "3px",
              color: "#241a08",
              cursor: "pointer",
              font: "inherit",
              fontSize: "11px",
              fontWeight: 600,
              padding: "3px 9px",
              whiteSpace: "nowrap",
            }}
          >
            Restart now
          </button>
        ) : null}
      </div>
    ) : null;

  const tabs = [
    {
      id: "install",
      title: "Setup",
      content: (
        <TabBody>
          {setupView === "checklist" ? (
            <SetupChecklist
              detail={detail}
              appid={appid}
              plan={plan}
              recommendation={recommendation}
              loadingWiki={loadingWiki}
              auto={auto}
              live={liveStatus}
              running={isThisGameRunning}
              onSetAuto={(enabled) => changeAuto(enabled)}
              onManual={() => setSetupView("manual")}
              onLogs={() => setSetupView("logs")}
              onChanged={async () => {
                await load();
                config.forgetLocal();
                await config.reload();
              }}
              onReloadPlan={() => reloadPlan(false)}
              onResetConfig={async () => {
                // Reset copies the stock ini in; the record of what we last
                // wrote belongs to the file that just went away.
                config.forgetLocal();
                await config.reload();
              }}
            />
          ) : (
            <>
              <BackRow
                label={setupView === "manual" ? "Manual setup" : "Logs"}
                onBack={() => setSetupView("checklist")}
              />
              {setupView === "manual" ? (
                <InstallPanel
                  detail={detail}
                  status={status}
                  appid={appid}
                  live={liveStatus}
                  onChanged={async () => {
                    await load();
                    config.forgetLocal();
                    await config.reload();
                  }}
                />
              ) : (
                <MonitorTab
                  targetDir={targetDir ?? detail.target}
                  live={isThisGameRunning}
                  onNeedsRestart={() => undefined}
                />
              )}
              <BackRow
                label={setupView === "manual" ? "Manual setup" : "Logs"}
                onBack={() => setSetupView("checklist")}
                position="bottom"
              />
            </>
          )}
        </TabBody>
      ),
    },
    ...(installed && !advanced
      ? [
          {
            id: "basic",
            title: "Settings",
            content: (
              <TabBody>
                <LiveStats live={liveStatus} />
                {/* No targetDir here on purpose: switching the upscaler in the
                    running game belongs in the Quick Access panel, which is
                    where the game is actually being driven from. This tab is
                    for setting a game up, and its changes take effect at
                    launch. */}
                <BasicPanel
                  values={config.values}
                  disabled={config.loading}
                  gpu={detail.gpu}
                  live={liveStatus}
                  plan={plan}
                  auto={auto}
                  onAutoChange={(enabled) => void changeAuto(enabled)}
                  onApply={config.setOptions}
                />
                <PanelSection>
                  <PanelSectionRow>
                    <Field
                      label="Every OptiScaler option"
                      description="Frame Gen, Upscaling, HUD Fix, Image, Compatibility, Overlay."
                      onClick={() => showAdvanced(true)}
                      onActivate={() => showAdvanced(true)}
                      focusable
                      bottomSeparator="standard"
                      childrenLayout="inline"
                      childrenContainerWidth="min"
                    >
                      <span style={{ opacity: 0.5 }}>›</span>
                    </Field>
                  </PanelSectionRow>
                </PanelSection>
              </TabBody>
            ),
          },
        ]
      : []),
    ...(installed && advanced
      ? TABS.map((tab) => ({
          id: tab.id,
          title: tab.title,
          content: (
            <TabBody>
              <ConfigTab
                tabId={tab.id}
                sections={tab.sections}
                blurb={tab.blurb}
                values={config.values}
                disabled={config.loading}
                onChange={config.setOption}
                onResetSection={config.resetSection}
              />
            </TabBody>
          ),
        }))
      : []),
  ];

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <DetailHeader
        title={detail.name}
        onBack={onBack}
        badges={
          <>
            {installed ? (
              <Pill color="#2f6b3f">{detail.install.filename}</Pill>
            ) : (
              <Pill>not set up</Pill>
            )}
            {detail.install.fsr4?.ffx?.version ? (
              <Pill>FFX {detail.install.fsr4.ffx.version}</Pill>
            ) : null}
            {isThisGameRunning ? <Pill color="#3a6ea5">running</Pill> : null}
          </>
        }
        action={
          installed ? (
            <ModeSwitch advanced={advanced} onChange={showAdvanced} />
          ) : null
        }
      />

      {liveBanner}
      {restartBanner}

      {config.error && installed ? (
        <div
          style={{
            margin: "0 12px 4px",
            padding: "5px 9px",
            borderLeft: "3px solid #e05c5c",
            background: "rgba(224,92,92,0.12)",
            borderRadius: "3px",
            fontSize: "12px",
            flexShrink: 0,
          }}
        >
          {config.error}
        </div>
      ) : null}

      <div style={{ flexGrow: 1, minHeight: 0 }}>
        <Tabs activeTab={activeTab} onShowTab={setActiveTab} tabs={tabs} autoFocusContents />
      </div>
    </div>
  );
}

/** The wiki entry's own name for a game, for a toast that names what was used. */
function detailName(plan: { game: string | null } | null, fallback: string) {
  return plan?.game ?? fallback;
}
