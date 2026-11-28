import { canonicalPbzTarget, hasPbzIdentity, pbzTargetMismatch } from "../gameTarget";
import { ConfirmModal, showModal } from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  autoInstall,
  getMonitor,
  install,
  installReframework,
  refreshWiki,
  removeReframework,
  resetConfig,
  uninstall,
} from "../api";
import { setLaunchOptions } from "../hooks/useRunningGame";
import { useI18n } from "../i18n";
import {
  applyManagedLaunchOptions,
  currentLaunchOptions,
  hasLaunchFlags,
  hasOverride,
  launchChoices,
  launchOptionFor,
  mergeLaunchOptions,
  overrideStem,
  preserveExistingInstall,
  reconcileLaunchOptions,
  recordedValue,
  resolveChoice,
  stripLaunchOptions,
} from "../launchOptions";
import type { LaunchAction, LaunchState } from "../launchOptions";
import {
  PREF_INSTALL_LAUNCH,
  PREF_REMOVE_LAUNCH,
  clearAppliedLaunchMetadata,
  getAppliedLaunchMetadata,
  isRemembering,
  readAppliedLaunchMetadata,
  recall,
  recallLaunchAction,
  remember,
} from "../prefs";
import type { AppliedLaunchMetadata } from "../prefs";
import type {
  AutoPlan,
  GameDetail,
  LiveStatus,
  MonitorReport,
  Recommendation,
} from "../types";
import { Pill } from "./Common";
import { RemovePrompt } from "./RemovePrompt";
import { InstalledChecklist } from "./setup/InstalledChecklist";
import { PreInstallChecklist } from "./setup/PreInstallChecklist";
import { BADGE_COLORS } from "./setup/helpers";

/**
 * Setting a game up, as a checklist rather than a page of panels.
 *
 * Orchestrates checklist state, Steam launch-option reads/merges, install/
 * re-apply/uninstall/reset mutations, and delegates presentation to
 * PreInstallChecklist, InstalledChecklist, and RecoverySection.
 */
interface Props {
  detail: GameDetail;
  appid: string | null;
  plan: AutoPlan | null;
  recommendation: Recommendation | null;
  loadingWiki: boolean;
  /** True while a background wiki refresh could still change the plan below. */
  refreshing?: boolean;
  auto: boolean;
  autoBusy?: boolean;
  live: LiveStatus | null;
  /** Whether this game is the one running right now. */
  running: boolean;
  onSetAuto: (enabled: boolean) => Promise<void> | void;
  onManual: () => void;
  onLogs: () => void;
  onChanged: () => Promise<void> | void;
  onRemoved?: () => void;
  onReloadPlan: () => Promise<void> | void;
  onResetConfig: () => Promise<void> | void;
  onBeforeMutation?: () => Promise<void> | void;
  onRestore?: () => Promise<void> | void;
  restoreBusy?: boolean;
  restoreError?: string | null;
  onRetryRestoreLaunchOptions?: () => void;
}

interface RemoveRetry {
  action: LaunchAction;
  value: string;
  previous: string | null;
}

export function SetupChecklist({
  detail,
  appid,
  plan,
  recommendation,
  loadingWiki,
  refreshing,
  auto,
  live,
  running,
  onSetAuto,
  onManual,
  onLogs,
  onChanged,
  onRemoved,
  onReloadPlan,
  onResetConfig,
  onBeforeMutation,
  autoBusy = false,
  onRestore,
  restoreBusy = false,
  restoreError,
  onRetryRestoreLaunchOptions,
}: Readonly<Props>) {
  const { t } = useI18n();
  const installed = Boolean(detail.install.installed);
  const planned = plan?.available ? plan : null;
  const filename = detail.install.filename ?? planned?.filename ?? "dxgi.dll";
  const ref = planned?.reframework ?? null;
  const launchFlags = planned?.launch_flags ?? [];
  const extraOverrides = ref?.override ? [ref.override] : [];
  // An .asi build has no proxy DLL override of its own, but a plan can still
  // require REFramework's override or game launch flags.
  const needsProxyOverride = !filename.toLowerCase().endsWith(".asi");
  const needsOverride = needsProxyOverride || Boolean(ref?.override) || launchFlags.length > 0;
  const launchWanted = planned?.launch_options ?? launchOptionFor(filename);

  const [withLaunch, setWithLaunch] = useState(true);
  const [withSettings, setWithSettings] = useState(true);
  const [busy, setBusy] = useState(false);
  const [removeRetry, setRemoveRetry] = useState<RemoveRetry | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  /** Steam's current launch options, or null when the client will not say. */
  const [launchNow, setLaunchNow] = useState<string | null>(null);
  const [launchReadable, setLaunchReadable] = useState(false);
  const [launchLoaded, setLaunchLoaded] = useState(false);
  const [persistedLaunch, setPersistedLaunch] = useState<AppliedLaunchMetadata>({
    flags: [],
    extraOverrides: [],
  });
  const [report, setReport] = useState<MonitorReport | null>(null);
  const launchRequest = useRef(0);
  const activeAppid = useRef(appid);
  activeAppid.current = appid;
  const withLaunchTouched = useRef(false);

  // Respect the remembered launch-options preference ("never" turns the toggle off).
  useEffect(() => {
    let cancelled = false;
    void recall(PREF_INSTALL_LAUNCH).then((pref) => {
      if (!cancelled && !withLaunchTouched.current) {
        setWithLaunch(pref !== "never");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshLaunch = useCallback(async () => {
    const request = ++launchRequest.current;
    if (!appid) {
      setLaunchNow(null);
      setLaunchReadable(false);
      setLaunchLoaded(true);
      setPersistedLaunch({ flags: [], extraOverrides: [] });
      return;
    }
    setLaunchLoaded(false);
    try {
      const [value, persisted] = await Promise.all([
        currentLaunchOptions(appid),
        getAppliedLaunchMetadata(appid),
      ]);
      if (activeAppid.current !== appid || launchRequest.current !== request) return;
      setLaunchNow(value);
      setLaunchReadable(value !== null);
      setLaunchLoaded(true);
      setPersistedLaunch(persisted);
    } catch {
      if (activeAppid.current === appid && launchRequest.current === request) {
        setLaunchNow(null);
        setLaunchReadable(false);
        setLaunchLoaded(true);
        setPersistedLaunch({ flags: [], extraOverrides: [] });
      }
    }
  }, [appid]);

  useEffect(() => {
    void refreshLaunch();
  }, [refreshLaunch]);

  useEffect(() => {
    if (!installed) {
      setReport(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const nextReport = await getMonitor(detail.install.path);
        if (!cancelled) setReport(nextReport);
      } catch {
        /* the log is optional; the row falls back to what it knows */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [installed, detail.install.path]);

  const mergedLaunchOptions =
    launchNow === null
      ? null
      : reconcileLaunchOptions({
          current: launchNow,
          oldFilename: detail.install.filename ?? filename,
          nextFilename: filename,
          nextFlags: launchFlags,
          nextExtraOverrides: extraOverrides,
          persisted: persistedLaunch,
          recordedOriginal: recordedValue(detail.install.launch_record),
          applyNext: true,
        }).value;
  const launchManualMergeRequired = launchNow !== null && mergedLaunchOptions === null;
  const launchCommand = mergedLaunchOptions ?? launchWanted;

  const runtimeBlocked = Boolean(
    plan && (plan.runtime_supported === false || plan.blocked_reason),
  );
  // A missing or unknown runtime identity is read-only too. The backend only
  // enables schema-specific writes after matching the installed proxy hash.
  const runtimeCurrent = detail.install.managed && detail.install.runtime_current === true;
  const isPbzGame = detail.is_pbz ?? hasPbzIdentity(detail);
  const requiredTarget = planned?.required_target ?? (isPbzGame ? "PBZ/platform/steam" : null);
  const expectedPbzTarget = canonicalPbzTarget(detail);
  const actualTarget = detail.install.installed ? detail.install.path : detail.target;
  const requiredTargetMismatch = pbzTargetMismatch(detail, Boolean(requiredTarget), actualTarget);
  const refPresent =
    detail.reframework?.installed ?? detail.install.reframework?.installed ?? false;
  const pluginPresent = detail.reframework?.plugin_installed ?? false;

  const overrideSet =
    launchNow !== null &&
    (!needsProxyOverride || hasOverride(launchNow, filename)) &&
    (!ref?.override || hasOverride(launchNow, ref.override)) &&
    (launchFlags.length === 0 || hasLaunchFlags(launchNow, launchFlags));

  const settling = Boolean(recommendation?.detail_pending) && Boolean(refreshing);

  const beforeManagedMutation = async () => {
    await onBeforeMutation?.();
    if (!installed) return;
    const preserved = await preserveExistingInstall(detail.install.path, detail.path, appid);
    if (!preserved.ok) {
      throw new Error(preserved.error ?? "Could not preserve the current install.");
    }
  };

  const applyLaunchOptions = async (
    enabled: boolean,
    override?: {
      filename: string;
      launchFlags: string[];
      extraOverrides: string[];
      launchWanted: string;
      targetDir?: string;
      allowUnmanaged?: boolean;
      skipRecord?: boolean;
      recordedOriginal?: string | null;
    },
  ): Promise<boolean> => {
    if (!appid) return false;
    if (installed && !detail.install.managed && !override?.allowUnmanaged) return false;
    const activeFilename = override?.filename ?? filename;
    const activeFlags = override?.launchFlags ?? launchFlags;
    const activeExtra = override?.extraOverrides ?? extraOverrides;
    const activeWanted = override?.launchWanted ?? launchWanted;
    const recordTarget =
      installed || override?.targetDir ? (override?.targetDir ?? detail.install.path) : null;
    const effectiveRecordedOriginal =
      override?.recordedOriginal !== undefined
        ? override.recordedOriginal
        : recordedValue(detail.install.launch_record);

    const applied = await applyManagedLaunchOptions({
      appid,
      oldFilename: activeFilename,
      nextFilename: activeFilename,
      nextFlags: activeFlags,
      nextExtraOverrides: activeExtra,
      recordedOriginal: effectiveRecordedOriginal,
      recordTarget,
      skipRecord: override?.skipRecord,
      applyNext: enabled,
    });

    if (applied.ok) {
      // A launch-options read can still be in flight from before this write.
      // Do not let its older disk snapshot replace the value Steam just took.
      launchRequest.current += 1;
      setLaunchNow(applied.value);
      setLaunchReadable(true);
      setLaunchLoaded(true);
      setPersistedLaunch(applied.nextOwned);
      toaster.toast({
        title: enabled ? t("Launch options updated") : t("OptiScaler launch options removed"),
        body: applied.value || detail.name,
      });
      return true;
    }

    if (applied.reason === "unreadable") {
      toaster.toast({
        title: t("Could not read Steam launch options"),
        body: t("The current value is unknown, so it was left unchanged."),
      });
    } else if (applied.reason === "metadata_unreadable") {
      toaster.toast({
        title: t("Could not read saved launch option records"),
        body: t("Steam was left unchanged so previous flags are not lost. Try again."),
      });
    } else if (applied.reason === "preserve_failed") {
      toaster.toast({
        title: t("Could not preserve launch options"),
        body: t("Steam was not changed."),
      });
    } else if (applied.reason === "manual_merge") {
      toaster.toast({
        title: t("Merge launch options manually"),
        body: enabled
          ? t(
              "Steam was left unchanged because its shell syntax cannot be merged safely. Required override: {opt}",
              { opt: activeWanted },
            )
          : t(
              "Steam was left unchanged because its shell syntax cannot be cleaned up safely. Remove the previous OptiScaler override/flags manually in Steam.",
            ),
      });
    } else {
      toaster.toast({
        title: t("Could not reach Steam"),
        body: t("Set the launch options manually."),
      });
    }
    return false;
  };

  /** Step 1, plus whichever of steps 2 and 3 are switched on. */
  const run = async () => {
    if (!planned || runtimeBlocked || running) return;
    if (requiredTargetMismatch) {
      toaster.toast({
        title: t("Choose the required game folder first"),
        body: t("PBZ needs the folder at {target}.", {
          target: requiredTarget ?? "PBZ/platform/steam",
        }),
      });
      return;
    }
    setBusy(true);
    try {
      await beforeManagedMutation();
      const launchAtInstall = appid ? await currentLaunchOptions(appid) : null;
      if (withLaunch && appid && needsOverride && launchAtInstall === null) {
        throw new Error(
          "Steam did not report the current launch options. Read them before setup so existing settings are preserved.",
        );
      }
      if (
        withLaunch &&
        appid &&
        needsOverride &&
        launchAtInstall !== null &&
        mergeLaunchOptions(launchAtInstall, filename, launchFlags, extraOverrides) === null
      ) {
        throw new Error(
          `Steam uses shell syntax that cannot be merged safely. Set the launch options manually, or uncheck that step. Required override: ${launchWanted}`,
        );
      }
      if (appid && launchAtInstall !== null) {
        setLaunchNow(launchAtInstall);
        setLaunchReadable(true);
      }
      const folder = detail.path.split("/").filter(Boolean).pop() ?? detail.name;
      let appliedPlan: AutoPlan = planned;
      if (withSettings) {
        const result = await autoInstall(
          detail.target,
          detail.path,
          detail.name,
          [folder],
          launchAtInstall,
        );
        if (!result.ok) {
          throw new Error(String(result.error ?? "Automatic setup failed."));
        }
        if (result.plan) appliedPlan = result.plan;
      } else {
        const result = await install(
          detail.target,
          planned.filename,
          true,
          planned.optipatcher,
          detail.path,
          launchAtInstall,
          false,
        );
        if (!result.ok) {
          throw new Error(String(result.error ?? "Install failed."));
        }
        if (ref?.automatic) {
          const added = await installReframework(detail.target, detail.path, detail.name, [folder]);
          if (!added.ok) {
            throw new Error(
              `OptiScaler was installed, but REFramework was not: ${String(added.error ?? "install failed")}`,
            );
          }
        }
      }
      const nextFilename = appliedPlan.filename ?? planned.filename;
      const nextFlags = appliedPlan.launch_flags ?? [];
      const nextExtra = appliedPlan.reframework?.override ? [appliedPlan.reframework.override] : [];
      const nextNeedsOverride =
        !nextFilename.toLowerCase().endsWith(".asi") ||
        nextExtra.length > 0 ||
        nextFlags.length > 0;
      const nextWanted = appliedPlan.launch_options ?? launchOptionFor(nextFilename);
      if (withLaunch && appid && nextNeedsOverride) {
        const launchApplied = await applyLaunchOptions(true, {
          filename: nextFilename,
          launchFlags: nextFlags,
          extraOverrides: nextExtra,
          launchWanted: nextWanted,
          targetDir: detail.target,
          allowUnmanaged: true,
          skipRecord: true,
          recordedOriginal: recordedValue(detail.install.launch_record) ?? launchAtInstall,
        });
        if (!launchApplied) {
          await onChanged();
          await refreshLaunch();
          return;
        }
      }
      toaster.toast({
        title: t("{name} is set up", { name: detail.name }),
        body: t("Installed as {filename}.", { filename: nextFilename }),
      });
      await onChanged();
    } catch (exc) {
      toaster.toast({ title: t("Setup failed"), body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  const addReframework = async () => {
    if (running) return;
    setBusy(true);
    try {
      await beforeManagedMutation();
      const folder = detail.path.split("/").filter(Boolean).pop() ?? detail.name;
      const result = await installReframework(detail.target, detail.path, detail.name, [folder]);
      if (result.ok) {
        toaster.toast({ title: t("REFramework installed"), body: detail.name });
        await onChanged();
      } else {
        toaster.toast({ title: t("Could not install REFramework"), body: String(result.error) });
      }
    } catch (exc) {
      toaster.toast({ title: t("Could not install REFramework"), body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  const dropReframework = async () => {
    if (running || detail.install.reframework?.managed === false) return;
    setBusy(true);
    try {
      await beforeManagedMutation();
      const result = await removeReframework(detail.install.path);
      if (result.ok) {
        toaster.toast({
          title: t("REFramework removed"),
          body: t("OptiScaler is still installed. Launch the game to see which one it was."),
        });
        await onChanged();
      } else {
        toaster.toast({ title: t("Could not remove REFramework"), body: String(result.error) });
      }
    } catch (exc) {
      toaster.toast({ title: t("Could not remove REFramework"), body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  /** Download the list again and rebuild this game's plan from it. */
  const retryWiki = async () => {
    setBusy(true);
    try {
      const result = await refreshWiki();
      await onReloadPlan();
      const failed =
        Boolean(result.meta?.error) || (result as { ok?: boolean }).ok === false;
      toaster.toast({
        title: failed
          ? t("Could not refresh compatibility list")
          : result.count > 0
            ? t("Compatibility list downloaded")
            : t("Still could not download it"),
        body: failed
          ? `${String(result.meta?.error ?? t("The wiki could not be reached."))}${
              result.count > 0 ? ` (${t("{count} entries.", { count: result.count })})` : ""
            }`
          : result.count > 0
            ? t("{count} entries.", { count: result.count })
            : t("The wiki returned no entries."),
      });
    } catch (exc) {
      toaster.toast({ title: t("Still could not download it"), body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  const reapply = async () => {
    if (!planned || running) return;
    if (requiredTargetMismatch) {
      toaster.toast({
        title: "Choose the required game folder first",
        body: `PBZ needs the folder at ${requiredTarget ?? "PBZ/platform/steam"}.`,
      });
      return;
    }
    setBusy(true);
    try {
      if (runtimeBlocked) {
        throw new Error(plan?.blocked_reason ?? "This runtime cannot apply the wiki plan.");
      }
      const oldFilename = detail.install.filename ?? filename;
      const recordedOriginal = recordedValue(detail.install.launch_record);
      const persistedBeforeResult = await readAppliedLaunchMetadata(appid);
      if (appid && !persistedBeforeResult.ok) {
        throw new Error(
          t("Could not read saved launch option records, so the install was left unchanged."),
        );
      }
      const persistedLaunchBefore = persistedBeforeResult.ok
        ? persistedBeforeResult.metadata
        : { flags: [], extraOverrides: [] };
      await beforeManagedMutation();
      const launchAtInstall = appid ? await currentLaunchOptions(appid) : null;
      const folder = detail.path.split("/").filter(Boolean).pop() ?? detail.name;
      const result = await autoInstall(
        detail.target,
        detail.path,
        detail.name,
        [folder],
        launchAtInstall,
      );
      if (!result.ok) {
        toaster.toast({ title: "Could not re-apply", body: String(result.error) });
        return;
      }

      const nextPlan = result.plan ?? planned;
      const nextFilename = nextPlan?.filename ?? oldFilename;
      const nextLaunchFlags = (nextPlan?.launch_flags ?? [])
        .map((flag) => flag.trim())
        .filter(Boolean);
      const nextExtraOverrides = nextPlan?.reframework?.override?.trim()
        ? [nextPlan.reframework.override.trim()]
        : [];
      const nextNeedsProxy = !nextFilename.toLowerCase().endsWith(".asi");
      const nextNeedsLaunch =
        nextNeedsProxy || nextExtraOverrides.length > 0 || nextLaunchFlags.length > 0;
      const nextLaunchWanted = nextPlan?.launch_options ?? launchOptionFor(nextFilename);
      const filenameChanged = oldFilename.toLowerCase() !== nextFilename.toLowerCase();

      const nextFlagSet = new Set(nextNeedsLaunch ? nextLaunchFlags : []);
      const hasRemovedFlags = persistedLaunchBefore.flags.some((flag) => !nextFlagSet.has(flag));
      const nextOverrideStems = new Set([
        ...(nextNeedsProxy ? [overrideStem(nextFilename).toLowerCase()] : []),
        ...(nextNeedsLaunch
          ? nextExtraOverrides.map((item) => overrideStem(item).toLowerCase())
          : []),
      ]);
      const hasRemovedExtraOverrides = persistedLaunchBefore.extraOverrides.some(
        (item) => !nextOverrideStems.has(overrideStem(item).toLowerCase()),
      );

      let launchWarning: { title: string; body: string } | null = null;
      const shouldReconcileLaunch =
        nextNeedsLaunch || filenameChanged || hasRemovedFlags || hasRemovedExtraOverrides;
      if (appid && shouldReconcileLaunch) {
        const launchPref = await recall(PREF_INSTALL_LAUNCH);
        if (launchPref !== "never") {
          const applied = await applyManagedLaunchOptions({
            appid,
            oldFilename,
            nextFilename,
            nextFlags: nextLaunchFlags,
            nextExtraOverrides,
            recordedOriginal,
            recordTarget: detail.install.path,
            applyNext: nextNeedsLaunch,
            skipIfUnchanged: true,
          });
          if (applied.ok) {
            if (applied.changed) {
              launchRequest.current += 1;
              setLaunchNow(applied.value);
              setLaunchReadable(true);
              setLaunchLoaded(true);
            }
            setPersistedLaunch(applied.nextOwned);
          } else if (applied.reason === "unreadable") {
            launchWarning = {
              title: "Set up again — update launch options manually",
              body: `Steam launch options could not be read. Check Steam and make sure ${nextLaunchWanted} is set.`,
            };
          } else if (applied.reason === "metadata_unreadable") {
            launchWarning = {
              title: t("Set up again — could not read launch option records"),
              body: t(
                "Saved launch-option tracking could not be read, so Steam was left unchanged. Retry or check Steam for: {opt}",
                { opt: nextLaunchWanted },
              ),
            };
          } else if (applied.reason === "preserve_failed") {
            launchWarning = {
              title: "Set up again — update launch options manually",
              body: `Could not preserve the original launch options, so Steam was not changed. Required override: ${nextLaunchWanted}`,
            };
          } else if (applied.reason === "manual_merge") {
            launchWarning = {
              title: "Set up again — merge launch options manually",
              body: nextNeedsLaunch
                ? `Steam uses shell syntax that cannot be merged safely. Required override: ${nextLaunchWanted}`
                : t(
                    "Steam was left unchanged because its shell syntax cannot be cleaned up safely. Remove the previous OptiScaler override/flags manually in Steam.",
                  ),
            };
          } else {
            launchWarning = {
              title: "Set up again — Steam rejected launch options",
              body: `Update Steam launch options manually to: ${applied.value ?? nextLaunchWanted}`,
            };
          }
        }
      }

      if (launchWarning) {
        toaster.toast(launchWarning);
      } else {
        toaster.toast({
          title: "Set up again from the wiki",
          body: nextPlan?.game ?? detail.name,
        });
      }
      await onChanged();
      await onReloadPlan();
    } catch (exc) {
      toaster.toast({ title: "Could not re-apply", body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  const launchState: LaunchState = {
    current: launchNow,
    recorded: recordedValue(detail.install.launch_record),
    filename: detail.install.filename ?? filename,
  };

  const doUninstall = async (
    action: LaunchAction,
    rememberIt: boolean,
    retry: RemoveRetry | null = null,
  ) => {
    if (!detail.install.managed || running) return;
    setBusy(true);
    let previousValue: string | null = null;
    let desiredValue: string | null = null;
    let steamChanged = false;
    let filesRemoved = false;
    try {
      await onBeforeMutation?.();
      const current = appid ? await currentLaunchOptions(appid) : null;
      const chosen = retry
        ? retry.action === "clear" && launchState.recorded !== "" && current !== null
          ? {
              action: "clear" as const,
              value: hasOverride(current, launchState.filename)
                ? stripLaunchOptions(current, launchState.filename, [], [], launchState.recorded)
                : current,
            }
          : { action: retry.action, value: retry.value }
        : appid
          ? launchChoices({ ...launchState, current }).find((choice) => choice.action === action)
          : undefined;
      if (appid && !chosen) {
        throw new Error(
          "Steam launch options changed. Open Remove again and choose from the current value.",
        );
      }
      const desired = chosen?.value ?? null;
      const previous = current;
      desiredValue = desired;
      previousValue = previous;
      if (appid && desired !== null) {
        if (current === null) {
          const pending = { action, value: desired, previous: null };
          setRemoveRetry(pending);
          setRemoveError(
            "Steam's current value is unknown, so files were kept in place. Read it again, then retry removal.",
          );
          toaster.toast({
            title: "OptiScaler was not removed",
            body: "Steam's current launch options could not be read.",
          });
          return;
        }
        if (current !== desired && !setLaunchOptions(Number(appid), desired)) {
          const pending = { action, value: desired, previous: current };
          setRemoveRetry(pending);
          setRemoveError(
            "Steam rejected the launch-options change. OptiScaler is still installed and its original launch record is intact.",
          );
          toaster.toast({
            title: "OptiScaler was not removed",
            body: "Steam rejected the launch-options change. Retry from Setup.",
          });
          return;
        }
        if (current !== desired) {
          steamChanged = true;
          launchRequest.current += 1;
          setLaunchNow(desired);
          setLaunchReadable(true);
        }
      }

      const result = await uninstall(detail.install.path, true);
      if (!result.ok) {
        let rollbackFailed = false;
        if (appid && desired !== null && previous !== null && desired !== previous) {
          rollbackFailed = !setLaunchOptions(Number(appid), previous);
          if (!rollbackFailed) {
            launchRequest.current += 1;
            setLaunchNow(previous);
            setLaunchReadable(true);
          }
        } else if (appid && desired !== null && previous === null) {
          rollbackFailed = true;
        }
        if (rollbackFailed && desired !== null) {
          const pending = { action, value: desired, previous };
          setRemoveRetry(pending);
          setRemoveError(
            "File removal failed and Steam could not be restored to its previous value. Retry removal below; the saved launch record remains available.",
          );
        } else {
          setRemoveRetry(null);
          setRemoveError(null);
        }
        toaster.toast({
          title: "Uninstall failed",
          body: rollbackFailed
            ? `${String(result.error)} Steam could not be put back; retry removal in Setup.`
            : `${String(result.error)} Steam was restored, and OptiScaler remains installed.`,
        });
        return;
      }

      filesRemoved = true;
      await clearAppliedLaunchMetadata(appid);
      setPersistedLaunch({ flags: [], extraOverrides: [] });
      onRemoved?.();
      if (rememberIt) await remember(PREF_REMOVE_LAUNCH, action);
      setRemoveRetry(null);
      setRemoveError(null);
      toaster.toast({ title: t("OptiScaler removed"), body: detail.name });
      if (appid && desired !== null) {
        toaster.toast({
          title: desired === "" ? t("Launch options cleared") : t("Launch options restored"),
          body: desired || detail.name,
        });
      }
      await onChanged();
    } catch (exc) {
      if (!filesRemoved && steamChanged && appid && desiredValue !== null) {
        const rollbackFailed =
          previousValue === null || !setLaunchOptions(Number(appid), previousValue);
        if (rollbackFailed) {
          setRemoveRetry({ action, value: desiredValue, previous: previousValue });
          setRemoveError(
            "Removal failed and Steam could not be restored to its previous value. Retry removal below; the saved launch record remains available.",
          );
        } else {
          launchRequest.current += 1;
          setLaunchNow(previousValue);
          setLaunchReadable(true);
        }
      }
      toaster.toast({
        title: filesRemoved ? t("OptiScaler removed; refresh failed") : t("Uninstall failed"),
        body: String(exc),
      });
    } finally {
      setBusy(false);
    }
  };

  const retryUninstall = () => {
    if (removeRetry) void doUninstall(removeRetry.action, false, removeRetry);
  };

  const confirmUninstall = async () => {
    if (!detail.install.managed || running) return;
    const [rememberedAction, canRemember] = await Promise.all([
      recallLaunchAction(PREF_REMOVE_LAUNCH),
      isRemembering(),
    ]);
    const current = appid ? await currentLaunchOptions(appid) : null;
    if (appid) {
      setLaunchNow(current);
      setLaunchReadable(current !== null);
      setLaunchLoaded(true);
    }
    const freshLaunchState = { ...launchState, current };
    const choices = appid ? launchChoices(freshLaunchState) : [];
    const applicable =
      resolveChoice(choices, rememberedAction)?.action === rememberedAction
        ? rememberedAction
        : null;
    showModal(
      <RemovePrompt
        gameName={detail.name}
        filename={detail.install.filename}
        backedUp={detail.install.backed_up.length}
        launch={appid ? freshLaunchState : null}
        remembered={applicable}
        canRemember={canRemember}
        onConfirm={(action, rememberIt) => void doUninstall(action, rememberIt)}
      />,
    );
  };

  const doReset = async () => {
    if (!runtimeCurrent) {
      toaster.toast({
        title: t("Settings are read-only"),
        body: t("Upgrade the runtime in Setup first."),
      });
      return;
    }
    setBusy(true);
    try {
      await onBeforeMutation?.();
      const result = await resetConfig(detail.install.path);
      if (result.ok) {
        await onResetConfig();
        toaster.toast({ title: t("Config reset"), body: t("Stock OptiScaler.ini restored.") });
      } else {
        toaster.toast({ title: t("Reset failed"), body: String(result.error) });
      }
    } catch (exc) {
      toaster.toast({ title: t("Reset failed"), body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  const confirmReset = () => {
    if (!runtimeCurrent) {
      toaster.toast({
        title: t("Settings are read-only"),
        body: t("Upgrade the runtime in Setup first."),
      });
      return;
    }
    showModal(
      <ConfirmModal
        strTitle={t("Reset OptiScaler settings?")}
        strOKButtonText={t("Reset settings")}
        strCancelButtonText={t("Cancel")}
        onOK={() => void doReset()}
      >
        <div style={{ fontSize: "14px", lineHeight: 1.5 }}>
          {t(
            "This overwrites {name}'s OptiScaler.ini with the stock defaults. Any custom upscaler, frame generation, or advanced settings will be cleared.",
            { name: detail.name },
          )}
        </div>
      </ConfirmModal>,
    );
  };

  // -- what the log row has to say -----------------------------------------
  const problems = report?.problems?.length ?? 0;
  const logSummary = !report?.log_present
    ? t("No log yet. Turn logging on here and launch the game once.")
    : problems > 0
      ? t(
          problems === 1
            ? "{count} warning or error in the log."
            : "{count} warnings or errors in the log.",
          { count: problems },
        )
      : t("Nothing wrong in the log.");
  const logPill = !report?.log_present ? (
    <Pill>{t("no log yet")}</Pill>
  ) : problems > 0 ? (
    <Pill color={BADGE_COLORS.warn}>{problems}</Pill>
  ) : (
    <Pill color={BADGE_COLORS.success}>{t("no problems")}</Pill>
  );

  if (!installed) {
    return (
      <PreInstallChecklist
        detail={detail}
        appid={appid}
        plan={plan}
        planned={planned}
        recommendation={recommendation}
        loadingWiki={loadingWiki}
        settling={settling}
        busy={busy}
        running={running}
        runtimeBlocked={runtimeBlocked}
        requiredTarget={requiredTarget}
        expectedPbzTarget={expectedPbzTarget}
        requiredTargetMismatch={requiredTargetMismatch}
        needsOverride={needsOverride}
        launchWanted={launchWanted}
        launchCommand={launchCommand}
        launchManualMergeRequired={launchManualMergeRequired}
        launchReadable={launchReadable}
        launchLoaded={launchLoaded}
        withLaunch={withLaunch}
        withSettings={withSettings}
        refWanted={ref}
        refPresent={refPresent}
        pluginPresent={pluginPresent}
        logSummary={logSummary}
        logPill={logPill}
        onChangeWithLaunch={(checked) => {
          withLaunchTouched.current = true;
          setWithLaunch(checked);
        }}
        onChangeWithSettings={setWithSettings}
        onRun={() => void run()}
        onRetryWiki={() => void retryWiki()}
        onRefreshLaunch={() => void refreshLaunch()}
        onManual={onManual}
        onLogs={onLogs}
      />
    );
  }

  return (
    <InstalledChecklist
      detail={detail}
      appid={appid}
      planned={planned}
      recommendation={recommendation}
      loadingWiki={loadingWiki}
      auto={auto}
      autoBusy={autoBusy}
      live={live}
      busy={busy}
      running={running}
      runtimeBlocked={runtimeBlocked}
      runtimeCurrent={runtimeCurrent}
      requiredTarget={requiredTarget}
      expectedPbzTarget={expectedPbzTarget}
      requiredTargetMismatch={requiredTargetMismatch}
      needsOverride={needsOverride}
      overrideSet={overrideSet}
      launchNow={launchNow}
      launchWanted={launchWanted}
      launchCommand={launchCommand}
      launchManualMergeRequired={launchManualMergeRequired}
      launchReadable={launchReadable}
      launchLoaded={launchLoaded}
      refWanted={ref}
      refPresent={refPresent}
      pluginPresent={pluginPresent}
      logSummary={logSummary}
      logPill={logPill}
      removeError={removeError}
      hasRemoveRetry={Boolean(removeRetry)}
      restoreBusy={restoreBusy}
      restoreError={restoreError}
      onSetAuto={onSetAuto}
      onApplyLaunchOptions={(checked) => void applyLaunchOptions(checked)}
      onRefreshLaunch={() => void refreshLaunch()}
      onAddReframework={() => void addReframework()}
      onDropReframework={() => void dropReframework()}
      onRetryWiki={() => void retryWiki()}
      onReapply={() => void reapply()}
      onConfirmReset={confirmReset}
      onConfirmUninstall={() => void confirmUninstall()}
      onRetryUninstall={retryUninstall}
      onRestore={onRestore}
      onRetryRestoreLaunchOptions={onRetryRestoreLaunchOptions}
      onManual={onManual}
      onLogs={onLogs}
    />
  );
}
