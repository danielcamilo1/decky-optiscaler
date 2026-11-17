import { hasPbzIdentity, pbzTargetMismatch } from "../gameTarget";
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
import { useCallback, useEffect, useRef, useState } from "react";
import { applyAutoSettings, getGame, rollbackInstall, setAutoMode, upgradeRuntime } from "../api";
import { forgetTargetLiveRecord } from "../config/liveRecord";
import { invalidateTargetReads, serializeTargetWrite } from "../config/writeRecord";
import { TABS, optionsInSection } from "../config/tabs";
import { AUTO } from "../config/values";
import {
  bindLiveChanges,
  liveContextForField,
  liveFfxVersionChoices,
  liveResultIsComplete,
} from "../liveControl";
import { useAutoPlan } from "../hooks/useAutoPlan";
import { useConfig } from "../hooks/useConfig";
import { restartGame, setLaunchOptions } from "../hooks/useRunningGame";
import { useLiveStatus } from "../hooks/useLiveStatus";
import { currentLaunchOptions } from "../launchOptions";
import type {
  GameDetail as GameDetailData,
  LiveApplyResult,
  LiveContext,
  OptionMeta,
  PayloadStatus,
  RunningGame,
} from "../types";
import { BasicPanel } from "./BasicPanel";
import { Centered, Notice, Pill } from "./Common";
import { ConfigTab } from "./ConfigTab";
import { DetailHeader, ModeSwitch } from "./DetailHeader";
import { InstallPanel } from "./InstallPanel";
import { LiveStats } from "./LiveStats";
import { LiveOutcome } from "./LiveOutcome";
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
  const [autoBusy, setAutoBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreSteam, setRestoreSteam] = useState<{ appid: string; value: string } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [upgradingTarget, setUpgradingTarget] = useState<string | null>(null);
  const [upgradeDeferred, setUpgradeDeferred] = useState(false);
  const [upgradeError, setUpgradeError] = useState<{ target: string; message: string } | null>(null);
  const upgradeInFlight = useRef(false);
  const runtimeUpgradeAttempts = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const selectionKey = `${gamePath}\u0000${gameName}\u0000${appid ?? ""}`;
  const selectionKeyRef = useRef(selectionKey);
  selectionKeyRef.current = selectionKey;
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const requestedKey = `${gamePath}\u0000${gameName}\u0000${appid ?? ""}`;
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const result = await getGame(gamePath, gameName);
      if (selectionKeyRef.current !== requestedKey || loadSequence.current !== sequence) return null;
      setDetail(result);
      return result;
    } catch (exc) {
      if (selectionKeyRef.current === requestedKey && loadSequence.current === sequence) {
        toaster.toast({ title: "Could not read game", body: String(exc) });
      }
      return null;
    } finally {
      if (selectionKeyRef.current === requestedKey && loadSequence.current === sequence) {
        setLoading(false);
      }
    }
  }, [gamePath, gameName, appid]);

  useEffect(() => {
    setRestoreSteam(null);
    setRestoreError(null);
    void load();
  }, [load]);

  // A different game starts at the top of its own checklist.
  useEffect(() => {
    setSetupView("checklist");
    setRestoreSteam(null);
    setRestoreError(null);
  }, [gamePath, appid]);

  const installed = Boolean(detail?.install.installed);
  const targetDir = detail?.install.installed ? detail.install.path : null;
  const isRunning =
    runningGame !== null && appid !== null && String(runningGame.appid) === appid;
  // OptiScaler's overlay writes the ini when the user hits Save in-game, so
  // re-read it whenever this game stops running rather than trusting our copy.
  const config = useConfig(targetDir, installed, isRunning, selectionKey, { gamePath, appid });
  const beforeConfigMutation = async () => {
    await config.flush();
    if (targetDir) invalidateTargetReads(targetDir);
  };
  const upgradeKey = `${targetDir ?? ""}\u0000${status?.version ?? ""}`;
  const autoUpgradeCandidate = Boolean(
    detail?.install.managed && detail.install.runtime_current === false &&
    (detail.install.runtime_recovery_needed || !detail.install.runtime_upgrade_held) && !runtimeUpgradeAttempts.current.has(upgradeKey) &&
    !pbzTargetMismatch(detail, hasPbzIdentity(detail), targetDir ?? detail.target),
  );
  const { status: liveStatus, statusEpoch: liveStatusEpoch, refresh: refreshLive } = useLiveStatus(
    targetDir, isRunning || autoUpgradeCandidate,
  );
  const upgradeRunning = isRunning || Boolean(liveStatus?.attached || liveStatus?.legacy_running);
  useEffect(() => config.reconcileLiveStatus(liveStatus, liveStatusEpoch), [
    config.reconcileLiveStatus, liveStatus, liveStatusEpoch, config.livePending,
  ]);
  const applyAdvancedOption = (
    option: OptionMeta,
    value: string,
    selectedContext?: LiveContext | null,
  ) => {
    const selected = selectedContext === undefined
      ? bindLiveChanges(
          [{ section: option.section, key: option.key, value }],
          liveStatus,
          targetDir,
        )[0]?.live_context
      : selectedContext;
    config.setOption(option, value, selected ?? undefined);
  };
  const resetAdvancedSection = (section: string) => {
    const changes = optionsInSection(section).map((option) => ({
      section: option.section,
      key: option.key,
      value: AUTO,
    }));
    const bindings: Record<string, LiveContext> = {};
    for (const change of bindLiveChanges(changes, liveStatus, targetDir)) {
      if (change.live_context) bindings[`${change.section}.${change.key}`] = change.live_context;
    }
    config.resetSection(section, bindings);
  };
  const liveFfxFgChoices = liveFfxVersionChoices(liveStatus, targetDir, "fg");
  const liveFfxUpscalerChoices = liveFfxVersionChoices(liveStatus, targetDir, "upscaler");
  const fgRuntimeIndex = liveStatus?.fg_index;
  const fgRuntimeVersion = typeof fgRuntimeIndex === "number"
    ? liveStatus?.ffx_fg_versions?.[fgRuntimeIndex]
    : null;
  const upscalerRuntimeIndex = liveStatus?.ffx_upscaler_index;
  const upscalerRuntimeVersion = typeof upscalerRuntimeIndex === "number"
    ? liveStatus?.ffx_upscaler_versions?.[upscalerRuntimeIndex]
    : null;
  const runtimeChoices = liveFfxFgChoices.length || liveFfxUpscalerChoices.length
    ? {
        ...(liveFfxFgChoices.length > 0 ? {
          "FSR.FGIndex": [
            {
              value: AUTO,
              label: fgRuntimeVersion
                ? `Auto · running FSR ${fgRuntimeVersion}`
                : "Auto · runtime unknown",
              context: liveStatus?.capabilities?.reset_auto === true
                ? liveContextForField(liveStatus, targetDir, "FSR.FGIndex", "change_fg_index")
                : null,
            },
            ...liveFfxFgChoices.map((choice) => ({
              value: choice.data,
              label: choice.label,
              context: choice.context,
            })),
          ],
        } : {}),
        ...(liveFfxUpscalerChoices.length > 0 ? {
          "FSR.UpscalerIndex": [
            {
              value: AUTO,
              label: upscalerRuntimeVersion
                ? `Auto · running FSR ${upscalerRuntimeVersion}`
                : "Auto · runtime unknown",
              context: liveStatus?.capabilities?.reset_auto === true
                ? liveContextForField(liveStatus, targetDir, "FSR.UpscalerIndex", "change_ffx_upscaler")
                : null,
            },
            ...liveFfxUpscalerChoices.map((choice) => ({
              value: choice.data,
              label: choice.label,
              context: choice.context,
            })),
          ],
        } : {}),
      }
    : undefined;
  const runtimeCurrent =
    detail?.install.runtime_current === true && config.runtimeCurrent === true;
  const {
    plan,
    recommendation,
    loading: loadingWiki,
    refreshing: refreshingWiki,
    auto,
    reload: reloadPlan,
  } = useAutoPlan(gamePath, gameName);
  const requiredTargetMismatch = detail && pbzTargetMismatch(detail,
    Boolean(plan?.required_target) || hasPbzIdentity(detail), targetDir ?? detail.target);

  useEffect(() => {
    if (!autoUpgradeCandidate || !targetDir || !liveStatus || upgradeRunning || requiredTargetMismatch || upgradeInFlight.current) return;
    const target = targetDir;
    const requestedKey = selectionKey;
    upgradeInFlight.current = true;
    setUpgradingTarget(target);
    setUpgradeError(null);
    void (async () => {
      try {
        const launch = await currentLaunchOptions(appid);
        if (appid && launch === null) throw new Error("Steam launch options are unavailable. Reopen this page to retry.");
        const result = await serializeTargetWrite(target, () =>
          mounted.current && selectionKeyRef.current === requestedKey
            ? upgradeRuntime(target, gamePath, launch, gameName)
            : Promise.resolve(null),
        );
        if (!result) return;
        if (result.deferred) {
          if (mounted.current) setUpgradeDeferred(true);
          return;
        }
        if (mounted.current) setUpgradeDeferred(false);
        runtimeUpgradeAttempts.current.add(upgradeKey);
        if (!result.ok) throw new Error(result.error ?? "Automatic runtime update failed.");
        if (!mounted.current || selectionKeyRef.current !== requestedKey) return;
        if (result.upgraded) forgetTargetLiveRecord(target);
        invalidateTargetReads(target);
        await Promise.all([load(), config.authoritativeReload(), refreshLive()]);
        void reloadPlan(false);
      } catch (exc) {
        runtimeUpgradeAttempts.current.add(upgradeKey);
        if (mounted.current && selectionKeyRef.current === requestedKey) {
          setUpgradeError({ target, message: String(exc) });
        }
      } finally {
        upgradeInFlight.current = false;
        if (mounted.current) setUpgradingTarget((current) => current === target ? null : current);
      }
    })();
  }, [autoUpgradeCandidate, targetDir, upgradeRunning, requiredTargetMismatch, selectionKey,
    upgradeKey, appid, gamePath, gameName, liveStatusEpoch, load, config.authoritativeReload, refreshLive, reloadPlan]);

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
    if (autoBusy) return;
    setAutoBusy(true);
    try {
      if (enabled) {
        if (!targetDir || !installed) throw new Error("Set up OptiScaler before enabling Automatic.");
        if (!runtimeCurrent) {
          throw new Error("Upgrade runtime in Setup before applying automatic settings.");
        }
        if (detail && pbzTargetMismatch(detail, Boolean(plan?.required_target) || hasPbzIdentity(detail), targetDir)) {
          throw new Error("Choose the main PBZ.exe folder at PBZ/platform/steam in Setup first.");
        }
        await config.flush();
        invalidateTargetReads(targetDir);
        const folder = gamePath.split("/").filter(Boolean).pop() ?? gameName;
        const result = await serializeTargetWrite(targetDir, () =>
          applyAutoSettings(targetDir, gamePath, gameName, [folder]),
        );
        invalidateTargetReads(targetDir);
        if (!result.ok) throw new Error(result.error ?? "Could not apply the wiki settings.");
        await config.authoritativeReload();
        const live = (result as { live?: LiveApplyResult }).live;
        if (liveResultIsComplete(live)) config.clearDirty();
        else config.markDirty();
        await reloadPlan(false);
        toaster.toast({ title: "Automatic settings applied", body: detailName(plan, gameName) });
      } else {
        const result = await setAutoMode(gamePath, false);
        if (!result.ok) throw new Error(result.error ?? "Could not turn Automatic off.");
        await reloadPlan(false);
      }
    } catch (exc) {
      try {
        await config.authoritativeReload();
      } catch {
        // The write error is already reported below; a failed refresh must not hide it.
      }
      await reloadPlan(false);
      toaster.toast({
        title: enabled ? "Could not apply the wiki settings" : "Could not update Automatic",
        body: String(exc),
      });
    } finally {
      setAutoBusy(false);
    }
  };

  const restorePreviousInstall = async () => {
    if (
      !detail?.install.rollback?.available || !detail.install.path ||
      restoreBusy || isRunning
    ) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      await config.flush();
      invalidateTargetReads(detail.install.path);
      const result = await rollbackInstall(detail.install.path, gamePath);
      if (!result.ok) throw new Error(result.error ?? "Could not restore the previous install.");
      forgetTargetLiveRecord(detail.install.path);
      let steamRestored = !appid;
      if (appid) {
        if (typeof result.launch_options !== "string") {
          setRestoreError(
            "Files were restored, but this restore point did not contain Steam launch options. " +
              "The current value was left unchanged; check Steam and restore it manually.",
          );
          setRestoreSteam(null);
        } else {
          const value = result.launch_options;
          steamRestored = setLaunchOptions(Number(appid), value);
          setRestoreSteam(steamRestored ? null : { appid, value });
          if (!steamRestored) {
            setRestoreError("Files were restored, but Steam rejected the launch options. Retry below.");
          }
        }
      }
      await load();
      await config.authoritativeReload();
      await refreshLive();
      await reloadPlan(false);
      if (steamRestored) {
        toaster.toast({ title: "Previous install restored", body: "The saved files and launch options were restored." });
      }
    } catch (exc) {
      toaster.toast({ title: "Restore failed", body: String(exc) });
    } finally {
      setRestoreBusy(false);
    }
  };

  const retryRestoreLaunchOptions = () => {
    const saved = detail?.install.rollback?.metadata?.launch_options;
    const value = restoreSteam?.value ?? (typeof saved === "string" ? saved : null);
    const targetAppid = restoreSteam?.appid ?? appid;
    if (!targetAppid || value === null) return;
    const restored = setLaunchOptions(Number(targetAppid), value);
    if (restored) {
      setRestoreSteam(null);
      setRestoreError(null);
      toaster.toast({ title: "Steam launch options restored", body: value || gameName });
    } else {
      setRestoreError("Steam still rejected the launch options. Retry again or restore them in Steam.");
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
  if (targetDir && upgradingTarget === targetDir && !upgradeDeferred) return <Centered>Updating OptiScaler…</Centered>;
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
  const liveBanner = installed && config.saving ? (
    <div style={{ margin: "0 12px 4px", padding: "5px 9px", borderLeft: "3px solid #1a9fff", background: "rgba(255,255,255,0.04)", borderRadius: "3px", fontSize: "12px", flexShrink: 0 }}>
      Saving settings…
    </div>
  ) : installed && config.live ? (
    <LiveOutcome result={config.live} status={liveStatus} />
  ) : null;

  const restartBanner =
    installed && config.restartRequired ? (
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
          <Focusable style={{ display: "flex" }}>
            <DialogButton
              onClick={() => {
                if (restartGame(runningGame)) {
                  config.clearDirty();
                  toaster.toast({ title: "Restarting", body: detail.name });
                } else {
                  toaster.toast({ title: "Could not restart", body: "Relaunch manually." });
                }
              }}
              onOKActionDescription="Restart this game now"
              style={{
                background: "#e8a33d",
                color: "#241a08",
                fontSize: "11px",
                fontWeight: 600,
                padding: "3px 9px",
                whiteSpace: "nowrap",
              }}
            >
              Restart now
            </DialogButton>
          </Focusable>
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
              refreshing={refreshingWiki}
              auto={auto}
              live={liveStatus}
              running={isThisGameRunning}
              onSetAuto={(enabled) => changeAuto(enabled)}
              autoBusy={autoBusy}
              onManual={() => setSetupView("manual")}
              onLogs={() => setSetupView("logs")}
              onChanged={async () => {
                await load();
                await config.authoritativeReload();
                await refreshLive();
                await reloadPlan(false);
              }}
              onRemoved={() => forgetTargetLiveRecord(detail.install.path, true)}
              onReloadPlan={() => reloadPlan(false)}
              onRestore={restorePreviousInstall}
              restoreBusy={restoreBusy}
              restoreError={restoreError}
              onRetryRestoreLaunchOptions={retryRestoreLaunchOptions}
              onResetConfig={async () => {
                await config.authoritativeReload();
              }}
              onBeforeMutation={beforeConfigMutation}
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
                  running={isThisGameRunning}
                  onBeforeMutation={beforeConfigMutation}
                  onChanged={async () => {
                    await load();
                    await config.authoritativeReload();
                    await refreshLive();
                    await reloadPlan(false);
                  }}
                />
              ) : (
                <MonitorTab
                  key={targetDir ?? detail.target}
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
                  disabled={
                    config.loading || config.saving ||
                    !runtimeCurrent || Boolean(requiredTargetMismatch)
                  }
                  gpu={detail.gpu}
                  live={liveStatus}
                  liveTargetDir={targetDir ?? undefined}
                  liveResult={config.live}
                  onFlush={config.flush}
                  ffx={detail.install.fsr4?.ffx}
                  plan={plan}
                  auto={auto}
                  onAutoChange={(enabled) => void changeAuto(enabled)}
                  autoBusy={autoBusy}
                  fsr4Build={config.fsr4Build}
                  onEnableFsr4={config.enableFsr4}
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
                disabled={config.loading || config.saving ||
                  !runtimeCurrent}
                onChange={applyAdvancedOption}
                onResetSection={resetAdvancedSection}
                runtimeChoices={runtimeChoices}
                runtimeGeneration={liveStatus?.capability_generation}
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

      {requiredTargetMismatch ? (
        <Notice tone="warn" title="Choose the main PBZ.exe folder">
          PBZ requires PBZ/platform/steam. In Setup, remove any installation in another folder before selecting the main executable location.
        </Notice>
      ) : null}
      {liveBanner}
      {restartBanner}

      {installed && detail.install.runtime_current === false ? (
        <div
          style={{
            margin: "0 12px 4px",
            padding: "6px 9px",
            borderLeft: "3px solid #e8a33d",
            background: "rgba(232,163,61,0.12)",
            borderRadius: "3px",
            fontSize: "12px",
            flexShrink: 0,
          }}
        >
          {upgradeError?.target === targetDir ? upgradeError.message :
            detail.install.runtime_upgrade_held
              ? "Previous install restored. Upgrade manually in Setup when ready."
              : autoUpgradeCandidate && (upgradeRunning || upgradeDeferred)
                ? "Waiting for the game to close before checking the runtime update."
                : "This runtime needs review in Manual setup before settings can be edited."}
        </div>
      ) : null}

      {restoreError ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            margin: "0 12px 4px",
            padding: "6px 9px",
            borderLeft: "3px solid #e05c5c",
            background: "rgba(224,92,92,0.12)",
            borderRadius: "3px",
            fontSize: "12px",
            flexShrink: 0,
          }}
        >
          <span style={{ flexGrow: 1 }}>{restoreError}</span>
          {restoreSteam ? (
            <Focusable style={{ display: "flex" }}>
              <DialogButton
                disabled={restoreBusy}
                onClick={retryRestoreLaunchOptions}
                onOKActionDescription="Retry restoring Steam launch options"
              >
                Retry
              </DialogButton>
            </Focusable>
          ) : null}
        </div>
      ) : null}

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
