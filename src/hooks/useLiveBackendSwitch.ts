import { useCallback, useEffect, useRef, useState } from "react";
import { switchUpscaler } from "../api";
import { UPSCALER_PRESETS } from "../config/basic";
import type { Preset } from "../config/basic";
import {
  EMPTY_PERSISTED_SNAPSHOT,
  getTargetLiveRecord,
  isPersistedKeyCurrent,
  subscribeTargetLiveRecord,
} from "../config/liveRecord";
import type { PersistedKeySnapshot } from "../config/liveRecord";
import { getTargetConfigQueue } from "../config/writeRecord";
import {
  backendOptionId,
  currentLiveContext,
  isConfirmedLiveResult,
  isSameLiveContext,
  receiptAuthorizationChanged,
} from "../liveControl";
import type { LiveApplyResult, LiveContext, LiveStatus, OptionChange } from "../types";

export interface PickedBackendBinding {
  context: LiveContext | null;
  baselineSeq: string | null;
  token: number;
  persistedValues: Record<string, string>;
  persistedRevisions: Record<string, number>;
  saveFailed: boolean;
}

function backendCode(preset: Preset | undefined, api?: LiveStatus["active_api"]): string | null {
  if (api !== "dx11" && api !== "dx12" && api !== "vulkan") return null;
  const key = api === "dx11"
    ? "Dx11Upscaler"
    : api === "vulkan"
      ? "VulkanUpscaler"
      : "Dx12Upscaler";
  const change = preset?.changes.find(
    (item) => item.section === "Upscalers" && item.key === key,
  );
  const value = change?.value?.toLowerCase();
  return value && value !== "auto" ? value : null;
}

function backendKeyForApi(api: LiveStatus["active_api"]): string | null {
  return api === "dx11" ? "Dx11Upscaler"
    : api === "dx12" ? "Dx12Upscaler"
      : api === "vulkan" ? "VulkanUpscaler" : null;
}

function readFallbackSnapshot(dir: string | null | undefined): PersistedKeySnapshot {
  if (!dir) return EMPTY_PERSISTED_SNAPSHOT;
  const record = getTargetLiveRecord(dir);
  const queue = getTargetConfigQueue(dir);
  const queuedRevisions: Record<string, number> = {};
  for (const [id, item] of queue.inFlight) queuedRevisions[id] = item.revision;
  for (const [id, item] of queue.pending) queuedRevisions[id] = item.revision;
  return {
    persistedValues: { ...record.persistedValues },
    persistedRevisions: { ...record.persistedRevisions },
    queuedRevisions,
  };
}

interface Params {
  targetDir?: string;
  bindingTarget: string | null;
  reportedLive: LiveStatus | null | undefined;
  liveBackend: string | null;
  liveResult?: LiveApplyResult | null;
  int8Selected: boolean;
  persistedSnapshot?: PersistedKeySnapshot;
  getPersistedSnapshot?: () => PersistedKeySnapshot;
  onFlush?: () => Promise<void>;
  onLiveResult?: (
    result: LiveApplyResult,
    context: LiveContext,
    keys: string[],
    expectedValues: Record<string, string>,
    revisions?: Record<string, number>,
  ) => void;
  onLiveChanged?: () => void;
}

/**
 * Manages the two-step live upscaler switch flow (save INI first, then
 * explicitly trigger a mid-game backend rebuild when live control is ready).
 */
export function useLiveBackendSwitch({
  targetDir,
  bindingTarget,
  reportedLive,
  liveBackend,
  liveResult,
  int8Selected,
  persistedSnapshot,
  getPersistedSnapshot,
  onFlush,
  onLiveResult,
  onLiveChanged,
}: Params) {
  const liveRef = useRef(reportedLive);
  liveRef.current = reportedLive;

  // Standalone callers (e.g. unit harnesses without useConfig) omit persistedSnapshot.
  // Subscribe to target live record changes only in that fallback path.
  const [fallbackSnapshot, setFallbackSnapshot] = useState<PersistedKeySnapshot>(() =>
    persistedSnapshot ? EMPTY_PERSISTED_SNAPSHOT : readFallbackSnapshot(targetDir),
  );
  useEffect(() => {
    if (persistedSnapshot || !targetDir) return;
    const sync = () => setFallbackSnapshot(readFallbackSnapshot(targetDir));
    sync();
    return subscribeTargetLiveRecord(targetDir, sync);
  }, [persistedSnapshot, targetDir]);

  const activeSnapshot = persistedSnapshot ?? fallbackSnapshot;
  const latestSnapshot = useCallback(
    () => (getPersistedSnapshot ? getPersistedSnapshot() : readFallbackSnapshot(targetDir)),
    [getPersistedSnapshot, targetDir],
  );

  const [switching, setSwitching] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedBinding, setPickedBinding] = useState<PickedBackendBinding | null>(null);
  const pickedBindingRef = useRef<PickedBackendBinding | null>(null);
  const selectionToken = useRef(0);
  const [switchResult, setSwitchResult] = useState<LiveApplyResult | null>(null);
  const [switchResultBinding, setSwitchResultBinding] = useState<LiveContext | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const clearSelection = useCallback(() => {
    pickedBindingRef.current = null;
    setPickedBinding(null);
    setPicked(null);
    setSwitchResult(null);
    setSwitchResultBinding(null);
    setSwitchError(null);
  }, []);

  const rememberPickedBackend = useCallback(
    (
      presetId: string,
      context: LiveContext | null,
      backendChanges: OptionChange[],
    ): PickedBackendBinding => {
      const binding: PickedBackendBinding = {
        context,
        baselineSeq: liveResult?.seq ?? reportedLive?.seq ?? null,
        token: ++selectionToken.current,
        persistedValues: Object.fromEntries(
          backendChanges.map((change) => [`${change.section}.${change.key}`, change.value]),
        ),
        persistedRevisions: {},
        saveFailed: false,
      };
      pickedBindingRef.current = binding;
      setPickedBinding(binding);
      setPicked(presetId);
      setSwitchResult(null);
      setSwitchResultBinding(null);
      return binding;
    },
    [liveResult?.seq, reportedLive?.seq],
  );

  const wanted = backendCode(
    UPSCALER_PRESETS.find((preset) => preset.id === picked),
    reportedLive?.active_api,
  );
  const int8RestartOnly = int8Selected || picked === "fsr4-int8";
  const pickedContext = pickedBinding?.context ?? null;
  const selectedBackendKey = pickedContext && pickedContext.active_api !== "unknown"
    ? backendOptionId(pickedContext.active_api)
    : null;
  const selectedBackendCapability = Boolean(
    selectedBackendKey &&
      reportedLive?.live_keys?.includes(selectedBackendKey) &&
      reportedLive.capabilities?.[selectedBackendKey] === true &&
      reportedLive.capabilities?.switch_upscaler === true,
  );
  const currentSelectionContext = currentLiveContext(reportedLive, bindingTarget);
  const pickedContextCurrent = Boolean(
    pickedContext &&
      currentSelectionContext &&
      isSameLiveContext(pickedContext, reportedLive, bindingTarget),
  );
  const pickedBackendKey = backendKeyForApi(
    pickedBinding?.context?.active_api ?? reportedLive?.active_api,
  );
  const pickedBackendId = pickedBackendKey ? `Upscalers.${pickedBackendKey}` : null;
  const pickedBackendValue = pickedBackendId
    ? pickedBinding?.persistedValues[pickedBackendId] ?? null
    : null;
  const pickedBackendRevision = pickedBackendId
    ? pickedBinding?.persistedRevisions[pickedBackendId] ?? null
    : null;
  const pickedConfigPersisted = Boolean(
    pickedBackendId &&
      isPersistedKeyCurrent(activeSnapshot, pickedBackendId, pickedBackendValue, pickedBackendRevision),
  );
  const switchSelectionStale = Boolean(
    pickedContext && !isSameLiveContext(pickedContext, reportedLive, bindingTarget),
  );
  const switchSelectionNeedsRefresh = Boolean(picked && pickedContext && switchSelectionStale);
  const switchResultKey = switchResultBinding && switchResultBinding.active_api !== "unknown"
    ? backendOptionId(switchResultBinding.active_api)
    : null;
  const switchOutcome = switchResult &&
    liveResult?.session === switchResult.session &&
    liveResult?.seq === switchResult.seq
    ? liveResult
    : switchResult;
  const switchAuthorizationLost = Boolean(
    switchOutcome?.sent &&
      reportedLive &&
      (receiptAuthorizationChanged(switchOutcome, reportedLive) ||
        reportedLive.dir_verified !== true ||
        reportedLive.dir_matches !== true),
  );
  const switchAccepted = Boolean(
    switchResultBinding &&
      switchResultKey &&
      !switchAuthorizationLost &&
      (!reportedLive?.session || reportedLive.session === switchResultBinding.session) &&
      isConfirmedLiveResult(switchOutcome, switchResultBinding, [switchResultKey]),
  );
  const switchInFlight = Boolean(
    switchOutcome?.sent &&
      (switchOutcome.ack === "pending" || switchOutcome.ack === "timeout"),
  );

  const canSwitchNow =
    Boolean(targetDir) &&
    Boolean(wanted) &&
    wanted !== liveBackend &&
    Boolean(wanted && reportedLive?.switchable_backends?.includes(wanted)) &&
    pickedContextCurrent &&
    selectedBackendCapability &&
    pickedConfigPersisted &&
    !switchInFlight &&
    !switchAccepted &&
    !int8RestartOnly;

  const switchNotReady =
    Boolean(targetDir) &&
    Boolean(picked) &&
    Boolean(wanted) &&
    wanted !== liveBackend &&
    !int8RestartOnly &&
    !switchSelectionStale &&
    !switching &&
    !switchInFlight &&
    !canSwitchNow;

  useEffect(() => {
    if (!switchAccepted) return;
    pickedBindingRef.current = null;
    setPickedBinding(null);
    setPicked(null);
  }, [switchAccepted]);

  const applyUpscalerNow = async () => {
    const selection = pickedBindingRef.current;
    const selectedApiKey = selection?.context
      ? backendKeyForApi(selection.context.active_api)
      : null;
    const selectedId = selectedApiKey ? `Upscalers.${selectedApiKey}` : null;
    const expectedValue = selectedId ? selection?.persistedValues[selectedId] : null;
    const selectedRevision = selectedId ? selection?.persistedRevisions[selectedId] : null;
    if (
      !targetDir || !wanted || !selection?.context || selection.context.active_api === "unknown" ||
      !selectedId || expectedValue === null || expectedValue === undefined || selectedRevision == null
    ) {
      setSwitchError("This choice is saved, but live control was not ready when you chose it. Choose it again once live control is ready.");
      return;
    }
    const persisted = () =>
      isPersistedKeyCurrent(latestSnapshot(), selectedId, expectedValue, selectedRevision);
    if (!persisted()) {
      setSwitchError("This upscaler choice is still saving or was replaced by a newer choice. Choose it again before switching.");
      return;
    }
    if (!isSameLiveContext(selection.context, liveRef.current, bindingTarget) || !currentLiveContext(liveRef.current, bindingTarget)) {
      setSwitchError("The game's graphics state changed after selection. Refresh and choose again.");
      return;
    }
    const key = backendOptionId(selection.context.active_api);
    setSwitching(true);
    setSwitchError(null);
    setSwitchResult(null);
    try {
      await onFlush?.();
      if (!isSameLiveContext(selection.context, liveRef.current, bindingTarget) || !currentLiveContext(liveRef.current, bindingTarget)) {
        setSwitchError("The game's graphics state changed while saving. Refresh and choose again.");
        return;
      }
      if (!persisted()) {
        setSwitchError("Your upscaler choice changed while saving. Choose it again before switching.");
        return;
      }
      const result = await switchUpscaler(targetDir, wanted, selection.context);
      const nextLive = result.live ?? null;
      const stillSelected = pickedBindingRef.current?.token === selection.token;
      if (nextLive) {
        if (stillSelected) {
          setSwitchResult(nextLive);
          setSwitchResultBinding(selection.context);
        }
        if (nextLive.sent === true && targetDir) {
          onLiveResult?.(
            nextLive,
            selection.context,
            [selectedId],
            { [selectedId]: expectedValue },
            { [selectedId]: selectedRevision },
          );
        }
      }
      const confirmed = Boolean(
        nextLive?.seq && nextLive.seq !== selection.baselineSeq &&
          isConfirmedLiveResult(nextLive, selection.context, [key]),
      );
      if (confirmed && stillSelected) {
        pickedBindingRef.current = null;
        setPickedBinding(null);
        setPicked(null);
      } else if (stillSelected && (!nextLive?.sent || nextLive.ack === "rejected")) {
        setSwitchError(
          result.error ?? nextLive?.error ?? nextLive?.reason ??
            "The live switch was not confirmed. Try again or restart the game.",
        );
      }
      onLiveChanged?.();
    } catch (error_) {
      setSwitchError(String(error_));
    } finally {
      setSwitching(false);
    }
  };

  const selectBackendPreset = (
    preset: Preset,
    bindChanges: (changes: OptionChange[], omitBackend?: boolean) => OptionChange[],
    applyChanges: (
      changes: OptionChange[],
      omitBackend?: boolean,
    ) => void | Promise<Record<string, number> | null>,
  ) => {
    const selectedApi = reportedLive?.active_api;
    const activeKey = backendKeyForApi(selectedApi);
    const backendChanges = preset.changes.filter(
      (change) => change.section === "Upscalers",
    );
    const selectedChange = activeKey
      ? preset.changes.find(
          (change) => change.section === "Upscalers" && change.key === activeKey,
        )
      : undefined;
    const selectionContext = selectedChange
      ? bindChanges([selectedChange])[0]?.live_context ?? null
      : null;
    const binding = rememberPickedBackend(
      preset.id,
      selectionContext,
      backendChanges,
    );
    setSwitchError(null);
    void Promise.resolve()
      .then(() => {
        const result = applyChanges(preset.changes, true);
        return result ?? null;
      })
      .then(async (revisions) => {
        if (!targetDir) return;
        if (!revisions) {
          if (pickedBindingRef.current?.token === binding.token) {
            const failedBinding = { ...binding, saveFailed: true };
            pickedBindingRef.current = failedBinding;
            setPickedBinding(failedBinding);
            setSwitchError("Settings did not finish saving. Live switching is unavailable until this choice is saved.");
          }
          return;
        }
        await onFlush?.();
        const snapshot = latestSnapshot();
        const persistedValues: Record<string, string> = {};
        const persistedRevisions: Record<string, number> = {};
        for (const change of backendChanges) {
          const id = `${change.section}.${change.key}`;
          const revision = revisions[id];
          if (isPersistedKeyCurrent(snapshot, id, change.value, revision)) {
            persistedValues[id] = change.value;
            persistedRevisions[id] = revision;
          }
        }
        const selectedId = activeKey ? `Upscalers.${activeKey}` : null;
        const selectedRevision = selectedId ? persistedRevisions[selectedId] : null;
        const stillPersisted = selectedId
          ? selectedRevision !== undefined
          : Object.keys(persistedRevisions).length > 0;
        if (pickedBindingRef.current?.token !== binding.token) return;
        if (!stillPersisted) {
          const failedBinding = { ...binding, saveFailed: true };
          pickedBindingRef.current = failedBinding;
          setPickedBinding(failedBinding);
          setSwitchError("A newer upscaler choice replaced this one before it saved. Choose it again before switching.");
          return;
        }
        const persistedBinding: PickedBackendBinding = {
          ...binding,
          persistedValues,
          persistedRevisions,
        };
        pickedBindingRef.current = persistedBinding;
        setPickedBinding(persistedBinding);
      })
      .catch((error) => {
        if (pickedBindingRef.current?.token === binding.token) {
          const failedBinding = { ...binding, saveFailed: true };
          pickedBindingRef.current = failedBinding;
          setPickedBinding(failedBinding);
          setSwitchError(String(error));
        }
      });
  };

  return {
    switching,
    picked,
    setPicked,
    pickedBinding,
    pickedBackendRevision,
    pickedConfigPersisted,
    int8RestartOnly,
    switchSelectionStale,
    switchSelectionNeedsRefresh,
    canSwitchNow,
    switchNotReady,
    switchError,
    clearSelection,
    applyUpscalerNow,
    selectBackendPreset,
  };
}
