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
import {
  applyAutoSettings,
  confirmRollbackLaunchOptions,
  getGame,
  rollbackInstall,
  setAutoMode,
  upgradeRuntime,
} from "../api";
import { forgetTargetLiveRecord } from "../config/liveRecord";
import { invalidateTargetReads, serializeTargetWrite } from "../config/writeRecord";
import { TABS, optionById, optionsInSection } from "../config/tabs";
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
import { useI18n } from "../i18n";
import { currentLaunchOptions } from "../launchOptions";
import {
  normalizeRestoredAppliedLaunch,
  readAppliedLaunchMetadata,
  setAppliedLaunchMetadata,
} from "../prefs";
import type {
  AppliedLaunchMetadata,
  GameDetail as GameDetailData,
  LiveApplyResult,
  LiveContext,
  OptionMeta,
  PayloadStatus,
  RunningGame,
} from "../types";
import { BasicPanel } from "./BasicPanel";
import { Centered, Pill, TONE_BACKGROUNDS, TONE_COLORS } from "./Common";
import type { NoticeTone } from "./Common";
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

function BackRow({
  label,
  onBack,
  position = "top",
}: {
  label: string;
  onBack: () => void;
  position?: "top" | "bottom";
}) {
  const { t } = useI18n();
  const top = position === "top";
  return (
    <Focusable
      style={{ display: "flex", margin: top ? "2px 0 6px" : "10px 0 4px", padding: "0 2px" }}
    >
      <DialogButton
        onClick={onBack}
        onOKActionDescription={t("Back to setup")}
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
            <span style={{ opacity: 0.7 }}>{t("Setup")}</span>
            <span style={{ opacity: 0.4 }}>/</span>
            <span style={{ fontWeight: 600 }}>{label}</span>
          </>
        ) : (
          <span style={{ fontWeight: 600 }}>{t("Back to guided setup")}</span>
        )}
      </DialogButton>
    </Focusable>
  );
}

function TabBody({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ maxHeight: "100%", overflowY: "auto", paddingBottom: "24px" }}>
      {children}
    </div>
  );
}

function TopBar({
  tone,
  children,
  action,
}: {
  tone: NoticeTone;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        margin: "0 12px 4px",
        padding: "5px 9px",
        borderLeft: `3px solid ${TONE_COLORS[tone]}`,
        background: TONE_BACKGROUNDS[tone],
        borderRadius: "3px",
        fontSize: "12px",
        flexShrink: 0,
      }}
    >
      <span style={{ flexGrow: 1, minWidth: 0 }}>{children}</span>
      {action}
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
  const { t } = useI18n();
  const [detail, setDetail] = useState<GameDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("install");
  const [advanced, setAdvanced] = useState(loadAdvanced);
  const [setupView, setSetupView] = useState<"checklist" | "manual" | "logs">("checklist");
  const [autoBusy, setAutoBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreSteam, setRestoreSteam] = useState<{
    appid: string;
    value: string;
    appliedLaunch: AppliedLaunchMetadata | null;
  } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [upgradingTarget, setUpgradingTarget] = useState<string | null>(null);
  const [upgradeDeferred, setUpgradeDeferred] = useState(false);
  const [upgradeError, setUpgradeError] = useState<{ target: string; message: string } | null>(null);
  const upgradeInFlight = useRef(false);
  const runtimeUpgradeAttempts = useRef(new Set<string>());
  const landedGameRef = useRef<string | null>(null);
  const loadedSelectionKeyRef = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
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
      loadedSelectionKeyRef.current = requestedKey;
      setDetail(result);
      return result;
    } catch (exc) {
      if (selectionKeyRef.current === requestedKey && loadSequence.current === sequence) {
        toaster.toast({ title: t("Could not read game"), body: String(exc) });
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
    detail?.install.managed &&
      detail.install.runtime_current === false &&
      (detail.install.runtime_recovery_needed || !detail.install.runtime_upgrade_held) &&
      !runtimeUpgradeAttempts.current.has(upgradeKey) &&
      !pbzTargetMismatch(detail, hasPbzIdentity(detail), targetDir ?? detail.target),
  );
  const { status: liveStatus, statusEpoch: liveStatusEpoch, refresh: refreshLive } = useLiveStatus(
    targetDir,
    isRunning || autoUpgradeCandidate,
  );
  const upgradeRunning = isRunning || Boolean(liveStatus?.attached || liveStatus?.legacy_running);
  const isLiveSession = isRunning || Boolean(liveStatus?.attached);
  useEffect(
    () => config.reconcileLiveStatus(liveStatus, liveStatusEpoch),
    [config.reconcileLiveStatus, liveStatus, liveStatusEpoch, config.livePending],
  );

  const applyAdvancedOption = (
    option: OptionMeta,
    value: string,
    selectedContext?: LiveContext | null,
  ) => {
    const selected =
      selectedContext === undefined
        ? bindLiveChanges(
            [{ section: option.section, key: option.key, value }],
            liveStatus,
            targetDir,
          )[0]?.live_context
        : selectedContext;
    config.setOption(option, value, selected ?? undefined);
  };

  const resetAdvancedOptions = (ids: string[]) => {
    const changes = ids
      .map((id) => optionById(id))
      .filter((option): option is OptionMeta => Boolean(option))
      .map((option) => ({ section: option.section, key: option.key, value: AUTO }));
    const bindings: Record<string, LiveContext> = {};
    for (const change of bindLiveChanges(changes, liveStatus, targetDir)) {
      if (change.live_context) bindings[`${change.section}.${change.key}`] = change.live_context;
    }
    config.resetOptions(ids, bindings);
  };

  const resetAdvancedSection = (section: string) => {
    resetAdvancedOptions(optionsInSection(section).map((option) => `${option.section}.${option.key}`));
  };

  const liveFfxFgChoices = liveFfxVersionChoices(liveStatus, targetDir, "fg");
  const liveFfxUpscalerChoices = liveFfxVersionChoices(liveStatus, targetDir, "upscaler");
  const fgRuntimeIndex = liveStatus?.fg_index;
  const fgRuntimeVersion =
    typeof fgRuntimeIndex === "number" ? liveStatus?.ffx_fg_versions?.[fgRuntimeIndex] : null;
  const upscalerRuntimeIndex = liveStatus?.ffx_upscaler_index;
  const upscalerRuntimeVersion =
    typeof upscalerRuntimeIndex === "number"
      ? liveStatus?.ffx_upscaler_versions?.[upscalerRuntimeIndex]
      : null;
  const runtimeChoices =
    liveFfxFgChoices.length || liveFfxUpscalerChoices.length
      ? {
          ...(liveFfxFgChoices.length > 0
            ? {
                "FSR.FGIndex": [
                  {
                    value: AUTO,
                    label: fgRuntimeVersion
                      ? t("Auto · running FSR {version}", { version: fgRuntimeVersion })
                      : t("Auto · runtime unknown"),
                    context:
                      liveStatus?.capabilities?.reset_auto === true
                        ? liveContextForField(liveStatus, targetDir, "FSR.FGIndex", "change_fg_index")
                        : null,
                  },
                  ...liveFfxFgChoices.map((choice) => ({
                    value: choice.data,
                    label: choice.label,
                    context: choice.context,
                  })),
                ],
              }
            : {}),
          ...(liveFfxUpscalerChoices.length > 0
            ? {
                "FSR.UpscalerIndex": [
                  {
                    value: AUTO,
                    label: upscalerRuntimeVersion
                      ? t("Auto · running FSR {version}", { version: upscalerRuntimeVersion })
                      : t("Auto · runtime unknown"),
                    context:
                      liveStatus?.capabilities?.reset_auto === true
                        ? liveContextForField(
                            liveStatus,
                            targetDir,
                            "FSR.UpscalerIndex",
                            "change_ffx_upscaler",
                          )
                        : null,
                  },
                  ...liveFfxUpscalerChoices.map((choice) => ({
                    value: choice.data,
                    label: choice.label,
                    context: choice.context,
                  })),
                ],
              }
            : {}),
        }
      : undefined;

  const runtimeCurrent =
    detail?.install.runtime_current === true && config.runtimeCurrent === true;
  const autoPlan = useAutoPlan(gamePath, gameName);
  const {
    plan,
    recommendation,
    loading: loadingWiki,
    refreshing: refreshingWiki,
    auto,
    reload: reloadPlan,
  } = autoPlan;
  const requiredTargetMismatch = Boolean(
    detail &&
      pbzTargetMismatch(
        detail,
        Boolean(plan?.required_target) || hasPbzIdentity(detail),
        targetDir ?? detail.target,
      ),
  );

  useEffect(() => {
    if (
      !autoUpgradeCandidate ||
      !targetDir ||
      !liveStatus ||
      upgradeRunning ||
      requiredTargetMismatch ||
      upgradeInFlight.current
    )
      return;
    const target = targetDir;
    const requestedKey = selectionKey;
    upgradeInFlight.current = true;
    setUpgradingTarget(target);
    setUpgradeError(null);
    void (async () => {
      try {
        const launch = await currentLaunchOptions(appid);
        if (appid && launch === null)
          throw new Error(t("Steam launch options are unavailable. Reopen this page to retry."));
        let appliedLaunch: AppliedLaunchMetadata | null = null;
        if (appid) {
          const persisted = await readAppliedLaunchMetadata(appid);
          if (!persisted.ok) {
            throw new Error(
              t("Saved launch option records are unavailable. Reopen this page to retry."),
            );
          }
          appliedLaunch = persisted.metadata;
        }
        const result = await serializeTargetWrite(target, () =>
          mounted.current && selectionKeyRef.current === requestedKey
            ? upgradeRuntime(target, gamePath, launch, gameName, appliedLaunch)
            : Promise.resolve(null),
        );
        if (!result) return;
        if (result.deferred) {
          if (mounted.current) setUpgradeDeferred(true);
          return;
        }
        if (mounted.current) setUpgradeDeferred(false);
        runtimeUpgradeAttempts.current.add(upgradeKey);
        if (!result.ok) throw new Error(result.error ?? t("Automatic runtime update failed."));
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
        if (mounted.current) setUpgradingTarget((current) => (current === target ? null : current));
      }
    })();
  }, [
    autoUpgradeCandidate,
    targetDir,
    upgradeRunning,
    requiredTargetMismatch,
    selectionKey,
    upgradeKey,
    appid,
    gamePath,
    gameName,
    liveStatusEpoch,
    load,
    config.authoritativeReload,
    refreshLive,
    reloadPlan,
  ]);

  const changeAuto = async (enabled: boolean) => {
    if (autoBusy) return;
    setAutoBusy(true);
    try {
      if (enabled) {
        if (!targetDir || !installed)
          throw new Error(t("Set up OptiScaler before enabling Automatic."));
        if (!runtimeCurrent) {
          throw new Error(t("Upgrade runtime in Setup before applying automatic settings."));
        }
        if (
          detail &&
          pbzTargetMismatch(
            detail,
            Boolean(plan?.required_target) || hasPbzIdentity(detail),
            targetDir,
          )
        ) {
          throw new Error(t("Choose the main PBZ.exe folder at PBZ/platform/steam in Setup first."));
        }
        await config.flush();
        invalidateTargetReads(targetDir);
        const folder = gamePath.split("/").filter(Boolean).pop() ?? gameName;
        const result = await serializeTargetWrite(targetDir, () =>
          applyAutoSettings(targetDir, gamePath, gameName, [folder]),
        );
        invalidateTargetReads(targetDir);
        if (!result.ok) throw new Error(result.error ?? t("Could not apply the wiki settings."));
        await config.authoritativeReload();
        const live = (result as { live?: LiveApplyResult }).live;
        if (liveResultIsComplete(live)) config.clearDirty();
        else config.markDirty();
        await reloadPlan(false);
        toaster.toast({ title: t("Automatic settings applied"), body: detailName(plan, gameName) });
      } else {
        const result = await setAutoMode(gamePath, false);
        if (!result.ok) throw new Error(result.error ?? t("Could not turn Automatic off."));
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
        title: enabled ? t("Could not apply the wiki settings") : t("Could not update Automatic"),
        body: String(exc),
      });
    } finally {
      setAutoBusy(false);
    }
  };

  const restorePreviousInstall = async () => {
    if (
      !detail?.install.rollback?.available ||
      !detail.install.path ||
      restoreBusy ||
      isRunning
    )
      return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      await config.flush();
      invalidateTargetReads(detail.install.path);
      const result = await rollbackInstall(detail.install.path, gamePath);
      if (!result.ok) throw new Error(result.error ?? t("Could not restore the previous install."));
      forgetTargetLiveRecord(detail.install.path);
      const restoredAppliedLaunch = normalizeRestoredAppliedLaunch(result.applied_launch);
      let steamRestored = !appid;
      if (appid) {
        if (typeof result.launch_options !== "string") {
          setRestoreError(
            t(
              "Files were restored, but this restore point did not contain Steam launch options. The current value was left unchanged; check Steam and restore it manually.",
            ),
          );
          setRestoreSteam(null);
        } else {
          const value = result.launch_options;
          steamRestored = setLaunchOptions(Number(appid), value);
          setRestoreSteam(
            steamRestored ? null : { appid, value, appliedLaunch: restoredAppliedLaunch },
          );
          if (steamRestored) {
            if (restoredAppliedLaunch !== null) {
              await setAppliedLaunchMetadata(
                appid,
                restoredAppliedLaunch.flags,
                restoredAppliedLaunch.extraOverrides,
              );
            }
            try {
              await confirmRollbackLaunchOptions(gamePath);
            } catch {
              /* launch options were already written to Steam */
            }
          } else {
            setRestoreError(
              t("Files were restored, but Steam rejected the launch options. Retry below."),
            );
          }
        }
      }
      await load();
      await config.authoritativeReload();
      await refreshLive();
      await reloadPlan(false);
      if (steamRestored) {
        toaster.toast({
          title: t("Previous install restored"),
          body: t("The saved files and launch options were restored."),
        });
      }
    } catch (exc) {
      toaster.toast({ title: t("Restore failed"), body: String(exc) });
    } finally {
      setRestoreBusy(false);
    }
  };

  const retryRestoreLaunchOptions = async () => {
    const saved = detail?.install.rollback?.metadata?.launch_options;
    const value = restoreSteam?.value ?? (typeof saved === "string" ? saved : null);
    const targetAppid = restoreSteam?.appid ?? appid;
    if (!targetAppid || value === null) return;
    const restoredAppliedLaunch =
      restoreSteam?.appliedLaunch ??
      normalizeRestoredAppliedLaunch(detail?.install.rollback?.metadata?.applied_launch);
    const restored = setLaunchOptions(Number(targetAppid), value);
    if (restored) {
      if (restoredAppliedLaunch !== null) {
        await setAppliedLaunchMetadata(
          targetAppid,
          restoredAppliedLaunch.flags,
          restoredAppliedLaunch.extraOverrides,
        );
      }
      setRestoreSteam(null);
      setRestoreError(null);
      try {
        await confirmRollbackLaunchOptions(gamePath);
      } catch {
        /* best-effort clear of persisted retry marker */
      }
      await load();
      toaster.toast({ title: t("Steam launch options restored"), body: value || gameName });
    } else {
      setRestoreError(
        t("Steam still rejected the launch options. Retry again or restore them in Steam."),
      );
    }
  };

  const handleEnableFsr4 = async () => {
    await config.enableFsr4();
    await load();
  };

  const handleRestoreOfficialFsr4 = async () => {
    await config.restoreOfficialFsr4();
    await load();
  };

  // Land on the default tab ONLY on initial load for this game using synchronous
  // detail metadata (never async useConfig.runtimeCurrent), so mid-setup actions
  // never yank the user away. If uninstalled later, always fall back to Setup.
  useEffect(() => {
    if (!detail || loadedSelectionKeyRef.current !== selectionKey) return;
    if (landedGameRef.current !== selectionKey) {
      landedGameRef.current = selectionKey;
      const canOpenSettings =
        detail.install.installed &&
        detail.install.runtime_current === true &&
        !pbzTargetMismatch(
          detail,
          Boolean(plan?.required_target) || hasPbzIdentity(detail),
          detail.install.path ?? detail.target,
        );
      setActiveTab(canOpenSettings ? (advanced ? TABS[0].id : "basic") : "install");
      return;
    }
    if (!installed && activeTab !== "install") {
      setActiveTab("install");
    }
  }, [detail, selectionKey, installed, advanced, activeTab, plan?.required_target]);

  /** Basic and advanced are the same switch, reached from two places. */
  const showAdvanced = (value: boolean) => {
    setAdvanced(value);
    saveAdvanced(value);
    setActiveTab(value ? TABS[0].id : "basic");
  };

  const isThisGameRunning = isRunning;

  if (loading && !detail) return <Centered>{t("Reading game folder…")}</Centered>;
  if (targetDir && upgradingTarget === targetDir && !upgradeDeferred)
    return <Centered>{t("Updating OptiScaler…")}</Centered>;
  if (!detail) {
    return (
      <Centered>
        <div>{t("Could not read that game folder.")}</div>
        <ButtonItem layout="below" onClick={onBack}>
          {t("Back")}
        </ButtonItem>
      </Centered>
    );
  }

  // Layer 1: Single highest-priority blocking/error bar.
  const metadataError =
    detail.install.manifest_error ?? detail.install.launch_record_error ?? null;
  const blockingBar = restoreError ? (
    <TopBar
      tone="error"
      action={
        restoreSteam ? (
          <Focusable style={{ display: "flex" }}>
            <DialogButton
              disabled={restoreBusy}
              onClick={() => void retryRestoreLaunchOptions()}
              onOKActionDescription={t("Retry restoring Steam launch options")}
              style={{ fontSize: "11px", padding: "3px 9px", whiteSpace: "nowrap" }}
            >
              {t("Retry")}
            </DialogButton>
          </Focusable>
        ) : null
      }
    >
      {restoreError}
    </TopBar>
  ) : config.error && installed ? (
    <TopBar
      tone="error"
      action={
        config.errorKind === "read" ? (
          <Focusable style={{ display: "flex" }}>
            <DialogButton
              disabled={config.loading}
              onClick={() => void config.reload()}
              onOKActionDescription={t("Reload OptiScaler settings")}
              style={{ fontSize: "11px", padding: "3px 9px", whiteSpace: "nowrap" }}
            >
              {t("Reload")}
            </DialogButton>
          </Focusable>
        ) : null
      }
    >
      <strong>
        {config.errorKind === "read" ? t("Could not load settings") : t("Could not save settings")}
      </strong>
      {" — "}
      {config.error}
    </TopBar>
  ) : requiredTargetMismatch ? (
    <TopBar tone="warn">
      <strong>{t("Choose the main PBZ.exe folder")}</strong> —{" "}
      {t("PBZ requires PBZ/platform/steam. Remove any install in another folder in Setup first.")}
    </TopBar>
  ) : installed && detail.install.runtime_current === false ? (
    <TopBar tone="warn">
      {upgradeError?.target === targetDir
        ? upgradeError.message
        : detail.install.runtime_upgrade_held
          ? t("Previous install restored. Upgrade manually in Setup when ready.")
          : autoUpgradeCandidate && (upgradeRunning || upgradeDeferred)
            ? t("Waiting for the game to close before checking the runtime update.")
            : t("This runtime needs review in Manual setup before settings can be edited.")}
    </TopBar>
  ) : metadataError ? (
    <TopBar tone="warn">{metadataError}</TopBar>
  ) : null;

  // Layer 2: Single-line save / live / restart status bar.
  const restartAction =
    isThisGameRunning && runningGame && config.restartRequired ? (
      <Focusable style={{ display: "flex" }}>
        <DialogButton
          onClick={() => {
            if (restartGame(runningGame)) {
              config.clearDirty();
              toaster.toast({ title: t("Restarting"), body: detail.name });
            } else {
              toaster.toast({ title: t("Could not restart"), body: t("Relaunch manually.") });
            }
          }}
          onOKActionDescription={t("Restart this game now")}
          style={{
            background: TONE_COLORS.warn,
            color: "#241a08",
            fontSize: "11px",
            fontWeight: 600,
            padding: "3px 9px",
            whiteSpace: "nowrap",
          }}
        >
          {t("Restart now")}
        </DialogButton>
      </Focusable>
    ) : null;

  const statusBar = !installed ? null : config.saving ? (
    <LiveOutcome result={config.live} status={liveStatus} saving inline />
  ) : isLiveSession ? (
    config.live ? (
      <LiveOutcome result={config.live} status={liveStatus} inline action={restartAction} />
    ) : config.restartRequired ? (
      <TopBar tone="warn" action={restartAction}>
        {t("Saved. Restart the game to apply.")}
      </TopBar>
    ) : null
  ) : config.dirty || config.live ? (
    <TopBar tone="info">{t("Saved for next launch.")}</TopBar>
  ) : null;

  const tabs = [
    {
      id: "install",
      title: t("Setup"),
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
              onRetryRestoreLaunchOptions={() => void retryRestoreLaunchOptions()}
              onResetConfig={async () => {
                await config.authoritativeReload();
              }}
              onBeforeMutation={beforeConfigMutation}
            />
          ) : (
            <>
              <BackRow
                label={setupView === "manual" ? t("Manual setup") : t("Logs")}
                onBack={() => setSetupView("checklist")}
              />
              {setupView === "manual" ? (
                <InstallPanel
                  detail={detail}
                  status={status}
                  appid={appid}
                  live={liveStatus}
                  running={isThisGameRunning}
                  autoPlan={autoPlan}
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
                  readOnly={!runtimeCurrent}
                  onBeforeMutation={beforeConfigMutation}
                  onNeedsRestart={async () => {
                    await config.authoritativeReload();
                    if (isLiveSession) config.markDirty();
                  }}
                />
              )}
              <BackRow
                label={setupView === "manual" ? t("Manual setup") : t("Logs")}
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
            title: t("Settings"),
            content: (
              <TabBody>
                <LiveStats live={liveStatus} />
                <BasicPanel
                  values={config.values}
                  disabled={
                    config.loading ||
                    config.saving ||
                    !runtimeCurrent ||
                    requiredTargetMismatch
                  }
                  running={isLiveSession}
                  gpu={detail.gpu}
                  live={liveStatus}
                  liveTargetDir={targetDir ?? undefined}
                  liveResult={config.live}
                  persistedSnapshot={config.persistedSnapshot}
                  getPersistedSnapshot={config.getPersistedSnapshot}
                  onFlush={config.flush}
                  ffx={detail.install.fsr4?.ffx}
                  plan={plan}
                  auto={auto}
                  onAutoChange={(enabled) => void changeAuto(enabled)}
                  autoBusy={autoBusy}
                  fsr4Build={config.fsr4Build}
                  onEnableFsr4={handleEnableFsr4}
                  onRestoreOfficialFsr4={handleRestoreOfficialFsr4}
                  onApply={config.setOptions}
                />
                <PanelSection>
                  <PanelSectionRow>
                    <Field
                      label={t("Every OptiScaler option")}
                      description={t("Frame Gen, Upscaling, HUD Fix, Image, Compatibility, Overlay.")}
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
          title: t(tab.title),
          content: (
            <TabBody>
              <ConfigTab
                tabId={tab.id}
                sections={tab.sections}
                blurb={tab.blurb}
                values={config.values}
                disabled={
                  config.loading ||
                  config.saving ||
                  !runtimeCurrent ||
                  requiredTargetMismatch
                }
                onChange={applyAdvancedOption}
                onResetOptions={resetAdvancedOptions}
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
              <Pill tone="success">{detail.install.filename}</Pill>
            ) : (
              <Pill>{t("not set up")}</Pill>
            )}
            {detail.install.fsr4?.ffx?.version ? (
              <Pill>FFX {detail.install.fsr4.ffx.version}</Pill>
            ) : null}
            {isThisGameRunning ? <Pill tone="info">{t("running")}</Pill> : null}
          </>
        }
        action={installed ? <ModeSwitch advanced={advanced} onChange={showAdvanced} /> : null}
      />

      {blockingBar}
      {statusBar}

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
