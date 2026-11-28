import {
  ButtonItem,
  ConfirmModal,
  DropdownItem,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  showModal,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useState } from "react";
import {
  bindLiveChanges,
  hasVerifiedLiveRuntime,
  isConfirmedLiveResult,
  isSameLiveContext,
  liveFfxVersionChoices,
} from "../liveControl";
import {
  FFX_FG_ID,
  FFX_UPSCALER_ID,
  FG_PRESETS,
  MULTIPLIER_KEY,
  MULTIPLIER_SECTION,
  UPSCALER_PRESETS,
  activeFgPreset,
  activeUpscalerPreset,
  disableFrameGenChanges,
  enableFrameGenChanges,
  enableFrameGenWith,
  ffxFgChanges,
  ffxUpscalerChanges,
  frameGenEnabled,
  isCommunityFsr4Build,
  isFfxBackend,
  isPriorCommunityLiteBuild,
  isRdna2Apu,
  needsForcedInt8,
  runningBackend,
  STEAM_DECK_FSR4_BUILD_ID,
  supportsInt8Override,
  supportsMultiplier,
  supportsOfficialInt8,
  usesFfxFrameGen,
  usesFfxUpscaler,
} from "../config/basic";
import type { PersistedKeySnapshot } from "../config/liveRecord";
import { curatedLabel } from "../config/labels";
import { optionById } from "../config/tabs";
import { AUTO, effectiveValue, labelFor } from "../config/values";
import { useLiveBackendSwitch } from "../hooks/useLiveBackendSwitch";
import { useI18n } from "../i18n";
import type {
  AutoPlan,
  ConfigValues,
  FfxUpscalerInfo,
  GpuInfo,
  LiveApplyResult,
  LiveContext,
  LiveStatus,
  OptionChange,
  OptionMeta,
} from "../types";
import { Mono, Notice, Pill } from "./Common";

interface Props {
  values: ConfigValues;
  disabled?: boolean;
  /** Whether the game is currently running or attached via live control. */
  running?: boolean;
  gpu?: GpuInfo | null;
  live?: LiveStatus | null;
  /**
   * The FidelityFX upscaler library sitting next to the game, which is what
   * names the newest FSR version before a running game can be asked.
   */
  ffx?: FfxUpscalerInfo | null;
  /**
   * Where OptiScaler is installed. Supplying it turns on the upscaler switch,
   * which only belongs where the running game is being driven — the Quick
   * Access panel. The full page's Settings tab is for a game that is not
   * running, so it leaves this out and the control never appears there.
   */
  targetDir?: string;
  /** Target used to bind saved values when the direct switch is hidden. */
  liveTargetDir?: string;
  /** Flush the INI queue before an explicit backend switch. */
  onFlush?: () => Promise<void>;
  liveResult?: LiveApplyResult | null;
  /** Reactive persisted/queued key snapshot supplied by useConfig. */
  persistedSnapshot?: PersistedKeySnapshot;
  getPersistedSnapshot?: () => PersistedKeySnapshot;
  onLiveResult?: (
    result: LiveApplyResult,
    context: LiveContext,
    keys: string[],
    expectedValues: Record<string, string>,
    revisions?: Record<string, number>,
  ) => void;
  /** Trims descriptions and explanations for the ~310px Quick Access column. */
  compact?: boolean;
  /**
   * What the wiki says about this game. When there is a plan, the automatic
   * toggle appears; without one there is nothing to be automatic about and the
   * panel is exactly what it has always been.
   */
  plan?: AutoPlan | null;
  /** Whether the wiki is currently driving everything but the three choices. */
  auto?: boolean;
  autoBusy?: boolean;
  onAutoChange?: (enabled: boolean) => void;
  onLiveChanged?: () => void;
  fsr4Build?: string | null;
  onEnableFsr4?: () => Promise<void>;
  onRestoreOfficialFsr4?: () => Promise<void>;
  onApply: (changes: OptionChange[]) => void | Promise<Record<string, number> | null>;
}

const MULTIPLIER_ID = `${MULTIPLIER_SECTION}.${MULTIPLIER_KEY}`;

function ffxVersionOptions(
  reported: string[] | undefined,
  option: OptionMeta | undefined,
  newest?: string | null,
  ids?: string[],
): { fromGame: boolean; options: Choice[] } {
  if (reported && reported.length > 0) {
    return {
      fromGame: true,
      options: reported.map((name, index) => ({
        data: String(index),
        label: `FSR ${name}`,
        version: name,
        id: ids?.[index],
      })),
    };
  }
  return {
    fromGame: false,
    options: (option?.options ?? []).map((value) => {
      const label =
        value === "0" && newest ? `FSR ${newest}` : labelFor(option as OptionMeta, value);
      return { data: value, label, version: label.replace(/^FSR\s+/i, "") };
    }),
  };
}

function ffxVersionName(ffx: FfxUpscalerInfo | null | undefined): string | null {
  const parts = (ffx?.version ?? "").split(".").filter(Boolean);
  return parts.length >= 3 ? parts.slice(0, 3).join(".") : null;
}

interface Choice {
  data: string;
  label: string;
  version?: string;
  id?: string;
  context?: LiveContext | null;
}

function ValueDropdown({
  options,
  selected,
  describe,
  onPick,
  resetKey = 0,
  ...rest
}: Readonly<{
  options: Choice[];
  selected: string;
  describe: (value: string) => string;
  onPick: (value: string) => void;
  resetKey?: number;
  label: string;
  description?: string;
  disabled?: boolean;
  bottomSeparator?: "standard" | "none";
}>) {
  const known = options.some((choice) => choice.data === selected);
  const rgOptions = known ? options : [...options, { data: selected, label: describe(selected) }];
  const shown = `${resetKey}\u0000${selected}\u0000${rgOptions.map((choice) => choice.label).join("\u0000")}`;
  return (
    <DropdownItem
      key={shown}
      {...rest}
      rgOptions={rgOptions}
      selectedOption={selected}
      onChange={(picked) => onPick(String(picked.data))}
    />
  );
}

export function BasicPanel({
  values,
  disabled,
  running,
  gpu,
  live: reportedLive,
  ffx,
  targetDir,
  liveTargetDir,
  onFlush,
  liveResult,
  persistedSnapshot,
  getPersistedSnapshot,
  onLiveResult,
  compact,
  plan,
  auto,
  autoBusy,
  onAutoChange,
  onLiveChanged,
  onApply,
  fsr4Build,
  onEnableFsr4,
  onRestoreOfficialFsr4,
}: Readonly<Props>) {
  const { t } = useI18n();
  const live = reportedLive?.supported === true ? reportedLive : null;
  const bindingTarget = liveTargetDir ?? targetDir ?? null;
  const gameRunning = Boolean(
    running || reportedLive?.attached || reportedLive?.legacy_running,
  );

  const [fsr4BusyLabel, setFsr4BusyLabel] = useState<string | null>(null);
  const [fsr4Error, setFsr4Error] = useState<string | null>(null);
  const [upscalerResetKey, setUpscalerResetKey] = useState(0);
  const [ffxFgSelection, setFfxFgSelection] = useState<{
    value: string;
    label: string;
    context: LiveContext | null;
    baselineSeq: string | null;
    baselineResult: LiveApplyResult | null;
  } | null>(null);
  const [ffxUpscalerSelection, setFfxUpscalerSelection] = useState<{
    value: string;
    label: string;
    context: LiveContext | null;
    baselineSeq: string | null;
    baselineResult: LiveApplyResult | null;
  } | null>(null);

  /** Explanatory text, dropped in the narrow Quick Access column. */
  const hint = (text: string | undefined) => (compact ? undefined : text);
  const bindChanges = (changes: OptionChange[], omitBackend = false) =>
    bindLiveChanges(changes, live, bindingTarget, { omitBackend });
  const applyChanges = (changes: OptionChange[], omitBackend = false) =>
    onApply(bindChanges(changes, omitBackend));

  useEffect(() => {
    if (
      ffxFgSelection &&
      values.FSR?.FGIndex === ffxFgSelection.value &&
      liveResult !== ffxFgSelection.baselineResult &&
      liveResult?.seq && liveResult.seq !== ffxFgSelection.baselineSeq &&
      isConfirmedLiveResult(liveResult, ffxFgSelection.context, [FFX_FG_ID])
    ) {
      setFfxFgSelection(null);
    }
    if (
      ffxUpscalerSelection &&
      values.FSR?.UpscalerIndex === ffxUpscalerSelection.value &&
      liveResult !== ffxUpscalerSelection.baselineResult &&
      liveResult?.seq && liveResult.seq !== ffxUpscalerSelection.baselineSeq &&
      isConfirmedLiveResult(liveResult, ffxUpscalerSelection.context, [FFX_UPSCALER_ID])
    ) {
      setFfxUpscalerSelection(null);
    }
  }, [ffxFgSelection, ffxUpscalerSelection, liveResult, values.FSR?.FGIndex, values.FSR?.UpscalerIndex]);

  const fgOn = frameGenEnabled(values);
  const fgPreset = activeFgPreset(values);
  const upscalerPreset = activeUpscalerPreset(values);
  const rawUpscaler = (values.Upscalers?.Dx12Upscaler ?? AUTO).toLowerCase();
  const rawFgInput = (values.FrameGen?.FGInput ?? AUTO).toLowerCase();
  const rawFgOutput = (values.FrameGen?.FGOutput ?? AUTO).toLowerCase();
  const multiplierOption = optionById(MULTIPLIER_ID);
  const multiplierUsable = supportsMultiplier(values);

  const planned = plan?.available ? plan : null;
  const automatic = Boolean(planned) && Boolean(auto);
  const plannedFg = planned?.framegen ?? null;
  const fgUnavailable = automatic && plannedFg?.input === "nofg";

  const fsr4Selected = upscalerPreset?.id === "fsr4";
  const int8Selected =
    values.Upscalers?.Dx12Upscaler?.toLowerCase() === "fsr31" &&
    values.FSR?.Fsr4ForceEnableInt8 === "1" &&
    values.FSR?.UpscalerIndex === "0";
  const int8PresetMatches =
    upscalerPreset?.id === "fsr4-int8" && fsr4Build === STEAM_DECK_FSR4_BUILD_ID;
  const isCustomOrLegacyFsr4Build = isCommunityFsr4Build(fsr4Build);
  const int8Route =
    needsForcedInt8(gpu) &&
    !supportsOfficialInt8(ffx) &&
    (fsr4Build === "4.1.1b" || supportsInt8Override(ffx));
  const liveRuntimeVerified = hasVerifiedLiveRuntime(reportedLive);
  const liveBackend = runningBackend(live);

  const backendSwitch = useLiveBackendSwitch({
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
  });

  const busy = disabled || Boolean(fsr4BusyLabel) || autoBusy || backendSwitch.switching;

  const upscalerChoices = UPSCALER_PRESETS.filter(
    (preset) =>
      (preset.id !== "dlss" ||
        upscalerPreset?.id === "dlss" ||
        !gpu?.vendor ||
        gpu.vendor === "nvidia") &&
      (preset.id !== "fsr4-int8" ||
        isRdna2Apu(gpu) ||
        fsr4Build === STEAM_DECK_FSR4_BUILD_ID ||
        isPriorCommunityLiteBuild(fsr4Build) ||
        upscalerPreset?.id === "fsr4-int8"),
  );

  const needsInt8 = fsr4Selected && int8Route;
  const ffxUpsNeedsInt8 = Boolean(ffxUpscalerSelection) && int8Route && !int8Selected;

  const ffxOption = optionById(FFX_FG_ID);
  const runtimeFgChoices = liveFfxVersionChoices(reportedLive, bindingTarget, "fg");
  const ffxChoices =
    runtimeFgChoices.length > 0
      ? {
          fromGame: true,
          options: runtimeFgChoices.map((choice) => ({
            data: choice.data,
            label: choice.label,
            version: choice.version,
            id: choice.id,
            context: choice.context,
          })),
        }
      : ffxVersionOptions(undefined, ffxOption);
  const ffxUsable = usesFfxFrameGen(values) || ffxChoices.fromGame;
  const ffxFixed = ffxChoices.options.length < 2;
  const ffxSelected = ffxOption ? effectiveValue(values, ffxOption) : "0";
  const fgSelectionIsStale = Boolean(
    ffxFgSelection?.context &&
      !isSameLiveContext(ffxFgSelection.context, reportedLive, bindingTarget),
  );
  const ffxFgResultRejected = Boolean(
    ffxFgSelection?.context &&
      liveResult &&
      liveResult !== ffxFgSelection.baselineResult &&
      ((liveResult.deferred ?? []).includes(FFX_FG_ID) ||
        !liveResult.sent ||
        liveResult.ack === "rejected" ||
        liveResult.ack === "timeout" ||
        (liveResult.confirmed === true &&
          !isConfirmedLiveResult(liveResult, ffxFgSelection.context, [FFX_FG_ID]))),
  );
  const ffxNotLive = Boolean(
    ffxFgSelection && (!ffxFgSelection.context || fgSelectionIsStale || ffxFgResultRejected),
  );

  const ffxUpsOption = optionById(FFX_UPSCALER_ID);
  const runtimeUpscalerChoices = liveFfxVersionChoices(reportedLive, bindingTarget, "upscaler");
  const ffxUpsChoices =
    runtimeUpscalerChoices.length > 0
      ? {
          fromGame: true,
          options: runtimeUpscalerChoices.map((choice) => ({
            data: choice.data,
            label: choice.label,
            version: choice.version,
            id: choice.id,
            context: choice.context,
          })),
        }
      : ffxVersionOptions(
          undefined,
          ffxUpsOption,
          fsr4Build === STEAM_DECK_FSR4_BUILD_ID || isPriorCommunityLiteBuild(fsr4Build)
            ? "4.1.2 Lite Exact (community)"
            : ffxVersionName(ffx),
        );
  const ffxUpsSelected = ffxUpsOption ? effectiveValue(values, ffxUpsOption) : "0";
  const ffxUpsFixed = ffxUpsChoices.options.length < 2;

  const liveFg =
    liveRuntimeVerified && typeof live?.fg_enabled === "boolean" ? live.fg_enabled : null;
  const ffxUpsUsable = liveRuntimeVerified ? isFfxBackend(liveBackend) : usesFfxUpscaler(values);
  const ffxUpsSelectionIsStale = Boolean(
    ffxUpscalerSelection?.context &&
      !isSameLiveContext(ffxUpscalerSelection.context, reportedLive, bindingTarget),
  );
  const ffxUpsResultRejected = Boolean(
    ffxUpscalerSelection?.context &&
      liveResult &&
      liveResult !== ffxUpscalerSelection.baselineResult &&
      ((liveResult.deferred ?? []).includes(FFX_UPSCALER_ID) ||
        !liveResult.sent ||
        liveResult.ack === "rejected" ||
        liveResult.ack === "timeout" ||
        (liveResult.confirmed === true &&
          !isConfirmedLiveResult(liveResult, ffxUpscalerSelection.context, [FFX_UPSCALER_ID]))),
  );
  const ffxUpsNotLive = Boolean(
    ffxUpscalerSelection &&
      (!ffxUpscalerSelection.context || ffxUpsSelectionIsStale || ffxUpsResultRejected),
  );

  const turnFrameGenOn = () =>
    applyChanges(
      automatic && plannedFg && plannedFg.input !== "nofg"
        ? enableFrameGenWith(plannedFg.input, plannedFg.output)
        : enableFrameGenChanges(values),
    );

  const methodControls = (
    <>
      <PanelSectionRow>
        <ValueDropdown
          label={t("Method")}
          description={hint(
            t("{desc} Takes effect on next launch.", {
              desc: fgPreset?.description ? t(fgPreset.description) : t("Choose frame generator."),
            }),
          )}
          disabled={busy || !fgOn}
          bottomSeparator={automatic && fgOn && plannedFg ? "none" : "standard"}
          options={FG_PRESETS.map((preset) => ({ data: preset.id, label: t(preset.label) }))}
          selected={fgPreset?.id ?? `${rawFgInput} \u2192 ${rawFgOutput}`}
          describe={() =>
            `${curatedLabel("FrameGen.FGInput", rawFgInput) ?? rawFgInput} \u2192 ` +
            `${curatedLabel("FrameGen.FGOutput", rawFgOutput) ?? rawFgOutput}`
          }
          onPick={(id) => {
            const preset = FG_PRESETS.find((p) => p.id === id);
            if (!preset) return;
            applyChanges(preset.changes);
          }}
        />
      </PanelSectionRow>

      {automatic && fgOn && plannedFg ? (
        <PanelSectionRow>
          <div style={{ padding: "0 0 8px", fontSize: "12px", opacity: 0.85 }}>
            {t("Wiki FG path:")}{" "}
            <strong>
              {plannedFg.input === "nofg"
                ? t("no frame generation")
                : `${plannedFg.input_label} → ${plannedFg.output_label}`}
            </strong>
            <div style={{ opacity: 0.65, fontSize: "11px" }}>{plannedFg.source}</div>
          </div>
        </PanelSectionRow>
      ) : null}
    </>
  );

  const handleRestoreOfficialFsr4 = () => {
    if (!onRestoreOfficialFsr4) return;
    const currentBuildLabel =
      fsr4Build === "4.1.1b" ? t("legacy FSR 4.1.1b") : t("community FSR 4.1.2 Lite");
    showModal(
      <ConfirmModal
        strTitle={t("Switch back to official FSR 3.X/4?")}
        strOKButtonText={t("Restore official FSR 4")}
        strCancelButtonText={t("Cancel")}
        onCancel={() => setUpscalerResetKey((n) => n + 1)}
        onOK={() => {
          backendSwitch.clearSelection();
          setFsr4Error(null);
          setFsr4BusyLabel(t("Restoring official FSR 3.X/4…"));
          void onRestoreOfficialFsr4()
            .then(() => {
              toaster.toast({
                title: t("Official FSR 3.X/4 restored"),
                body: t("Restored the bundled official DLL and applied official FSR 4 settings."),
              });
            })
            .catch((error) => {
              setFsr4Error(String(error));
              setUpscalerResetKey((n) => n + 1);
            })
            .finally(() => setFsr4BusyLabel(null));
        }}
      >
        <div style={{ fontSize: "14px", lineHeight: 1.5 }}>
          {t(
            "Currently using {build}. Restores the bundled official FidelityFX DLL and FSR 4 settings without changing frame generation.",
            { build: currentBuildLabel },
          )}
        </div>
      </ConfirmModal>,
    );
  };

  return (
    <>
      {planned ? (
        <PanelSection title={t("Settings mode")}>
          <PanelSectionRow>
            <ToggleField
              label={t("Automatic")}
              description={hint(
                automatic
                  ? t(
                      "Applied from “{game}” on setup, enable, or re-apply. Frame gen, multiplier, and upscaler stay yours.",
                      { game: planned.game ?? "" },
                    )
                  : t(
                      "Apply this game's wiki settings on setup, enable, or re-apply; frame gen, multiplier, and upscaler stay yours.",
                    ),
              )}
              checked={automatic}
              disabled={busy || !onAutoChange}
              bottomSeparator={automatic ? "none" : "standard"}
              onChange={(checked) => onAutoChange?.(checked)}
            />
          </PanelSectionRow>
          {automatic && !compact ? (
            <PanelSectionRow>
              <div style={{ padding: "0 0 8px", fontSize: "12px", opacity: 0.8 }}>
                {planned.settings.length > 0 ? (
                  <>
                    {t("Wiki sets ")}
                    {planned.settings.map((item, index) => (
                      <span key={`${item.section}.${item.key}`}>
                        {index > 0 ? ", " : ""}
                        <Mono>
                          {item.key}={item.value}
                        </Mono>
                      </span>
                    ))}
                    {t(". Turn off to customize all options.")}
                  </>
                ) : (
                  <>{t("No special wiki settings needed. Turn off to customize all options.")}</>
                )}
              </div>
            </PanelSectionRow>
          ) : null}
        </PanelSection>
      ) : null}

      {reportedLive?.supported === false ? (
        <PanelSection>
          <PanelSectionRow>
            {reportedLive.can_install === true && reportedLive.asi_current === false ? (
              <Notice tone="warn" title={t("Live control update available")}>
                {t(
                  "Live control module is outdated. Close the game and reinstall it under Setup → Manual setup.",
                )}
              </Notice>
            ) : (
              <Notice tone="info" title={t("Live control is unavailable")}>
                {t("Not supported for this runtime — changes apply on next launch.")}
              </Notice>
            )}
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      <PanelSection title={t("Frame Generation")}>
        <PanelSectionRow>
          <ToggleField
            label={t("Frame generation")}
            description={hint(
              fgUnavailable
                ? t("Wiki reports no working FG input for this game.")
                : t("Insert generated frames between rendered ones."),
            )}
            checked={fgOn}
            disabled={busy || fgUnavailable}
            bottomSeparator={liveFg === null ? "standard" : "none"}
            onChange={(checked) =>
              checked ? turnFrameGenOn() : applyChanges(disableFrameGenChanges())
            }
          />
        </PanelSectionRow>

        {liveFg !== null ? (
          <PanelSectionRow>
            <div style={{ padding: "0 0 6px", fontSize: "12px", opacity: 0.85 }}>
              {t("In game:")}{" "}
              {liveFg ? <Pill tone="success">{t("ON")}</Pill> : <Pill tone="error">{t("OFF")}</Pill>}
              {typeof live?.fps === "number" && live.fps > 0 ? (
                <span style={{ opacity: 0.75 }}>{live.fps.toFixed(0)} fps</span>
              ) : null}
            </div>
          </PanelSectionRow>
        ) : null}

        {compact ? null : methodControls}

        {ffxUsable && ffxChoices.options.length > 0 ? (
          <PanelSectionRow>
            <ValueDropdown
              label={t("FFX FG version")}
              description={hint(
                ffxFixed
                  ? t("Only FFX generator offered by this game.")
                  : ffxChoices.fromGame
                    ? t("FFX generators reported by this game.")
                    : t("FidelityFX generator used by FSR FG."),
              )}
              disabled={busy || ffxFixed}
              bottomSeparator={ffxNotLive ? "none" : "standard"}
              options={ffxChoices.options}
              selected={
                fgSelectionIsStale && ffxFgSelection
                  ? `stale:${ffxFgSelection.value}`
                  : ffxSelected
              }
              describe={(index) =>
                index.startsWith("stale:") && ffxFgSelection
                  ? t("Previous choice: {label} (refresh and choose again)", {
                      label: ffxFgSelection.label,
                    })
                  : t("Generator {index} (not offered here)", { index })
              }
              onPick={(index) => {
                const choice = ffxChoices.options.find((item) => item.data === index);
                const pendingChanges = ffxFgChanges(index);
                const changes = choice?.context
                  ? pendingChanges.map((change) => ({
                      ...change,
                      live_context: choice.context as LiveContext,
                    }))
                  : bindChanges(pendingChanges);
                const selected = changes.find(
                  (change) => change.section === "FSR" && change.key === "FGIndex",
                );
                setFfxFgSelection({
                  value: index,
                  label: choice?.label ?? `Generator ${index}`,
                  context: selected?.live_context ?? null,
                  baselineSeq: liveResult?.seq ?? reportedLive?.seq ?? null,
                  baselineResult: liveResult ?? null,
                });
                onApply(changes);
              }}
            />
          </PanelSectionRow>
        ) : null}

        {ffxNotLive ? (
          <PanelSectionRow>
            <Notice tone="info">
              {fgSelectionIsStale || ffxFgResultRejected
                ? t("Graphics state changed or rejected this choice. Pick again when live control is ready.")
                : t("Saved for next launch — could not switch FFX FG live.")}
            </Notice>
          </PanelSectionRow>
        ) : null}

        {multiplierOption ? (
          <PanelSectionRow>
            <ValueDropdown
              label={t("Frame multiplier")}
              description={
                multiplierUsable
                  ? hint(t("Generated frames per rendered frame."))
                  : t("Requires XeSS Frame Generation for >2X.")
              }
              disabled={busy || !multiplierUsable}
              bottomSeparator="standard"
              options={(multiplierOption.options ?? []).map((value) => ({
                data: value,
                label: labelFor(multiplierOption, value),
              }))}
              selected={effectiveValue(values, multiplierOption)}
              describe={(value) => labelFor(multiplierOption, value)}
              onPick={(value) =>
                applyChanges([{ section: MULTIPLIER_SECTION, key: MULTIPLIER_KEY, value }])
              }
            />
          </PanelSectionRow>
        ) : null}
      </PanelSection>

      <PanelSection title={t("Upscaler")}>
        <PanelSectionRow>
          <ValueDropdown
            label={t("Override upscaler with")}
            resetKey={upscalerResetKey}
            description={hint(
              int8Selected && !int8PresetMatches
                ? t("Custom INT8 setup. Review or restore DLL in Setup → Manual setup.")
                : upscalerPreset?.description
                  ? t(upscalerPreset.description)
                  : t("Replaces the game's upscaler."),
            )}
            disabled={busy}
            bottomSeparator="standard"
            options={upscalerChoices.map((preset) => ({
              data: preset.id,
              label: t(preset.label),
            }))}
            selected={
              backendSwitch.switchSelectionNeedsRefresh &&
              backendSwitch.picked &&
              !backendSwitch.int8RestartOnly
                ? `stale:${backendSwitch.picked}`
                : int8Selected && !int8PresetMatches
                  ? "manual-int8"
                  : upscalerPreset?.id ?? rawUpscaler
            }
            describe={(code) =>
              code.startsWith("stale:")
                ? t("Previous choice: {label} (refresh and choose again)", {
                    label: t(
                      UPSCALER_PRESETS.find((preset) => preset.id === code.slice(6))?.label ??
                        code.slice(6),
                    ),
                  })
                : code === "manual-int8"
                  ? fsr4Build === "4.1.1b"
                    ? t("FSR 4.1.1b (legacy)")
                    : isPriorCommunityLiteBuild(fsr4Build)
                      ? t("FSR 4.1.2 Lite (older)")
                      : t("FSR 4 INT8 (manual)")
                  : curatedLabel("Upscalers.Dx12Upscaler", code) ?? code
            }
            onPick={(id) => {
              const preset = UPSCALER_PRESETS.find((p) => p.id === id);
              if (!preset) return;
              setFsr4Error(null);
              if (preset.id === "fsr4-int8") {
                if (gameRunning) {
                  const message = t(
                    "Close the game first before switching to community FSR 4.1.2 Lite.",
                  );
                  setFsr4Error(message);
                  setUpscalerResetKey((n) => n + 1);
                  toaster.toast({ title: t("Close the game first"), body: message });
                  return;
                }
                if (!onEnableFsr4) {
                  setUpscalerResetKey((n) => n + 1);
                  return;
                }
                backendSwitch.clearSelection();
                setFsr4BusyLabel(t("Setting up community FSR 4.1.2 Lite…"));
                void onEnableFsr4()
                  .then(() => backendSwitch.setPicked(preset.id))
                  .catch((error) => {
                    setFsr4Error(String(error));
                    setUpscalerResetKey((n) => n + 1);
                  })
                  .finally(() => setFsr4BusyLabel(null));
                return;
              }
              if (preset.id === "fsr4" && isCustomOrLegacyFsr4Build) {
                if (gameRunning) {
                  const message = t(
                    "Close the game first before switching back to official FSR 3.X/4.",
                  );
                  setFsr4Error(message);
                  setUpscalerResetKey((n) => n + 1);
                  toaster.toast({ title: t("Close the game first"), body: message });
                  return;
                }
                if (onRestoreOfficialFsr4) {
                  handleRestoreOfficialFsr4();
                  return;
                }
              }
              backendSwitch.selectBackendPreset(preset, bindChanges, applyChanges);
            }}
          />
        </PanelSectionRow>

        {upscalerChoices.some((preset) => preset.id === "fsr4-int8") ? (
          <PanelSectionRow>
            <div style={{ fontSize: "12px", color: "#b8bcbf", padding: "4px 0" }}>
              {t("Community Lite preset downloads a modified DLL — avoid in anti-cheat games.")}
            </div>
          </PanelSectionRow>
        ) : null}

        {ffxUpsUsable && ffxUpsChoices.options.length > 0 ? (
          <PanelSectionRow>
            <ValueDropdown
              label={t("FSR version")}
              description={hint(
                ffxUpsFixed
                  ? t("Only FSR version offered by this game.")
                  : ffxUpsChoices.fromGame
                    ? t("FSR versions reported by this game.")
                    : t("FSR version for the FidelityFX backend."),
              )}
              disabled={busy || ffxUpsFixed}
              bottomSeparator={ffxUpsNotLive ? "none" : "standard"}
              options={ffxUpsChoices.options}
              selected={
                ffxUpsSelectionIsStale && ffxUpscalerSelection
                  ? `stale:${ffxUpscalerSelection.value}`
                  : ffxUpsSelected
              }
              describe={(index) =>
                index.startsWith("stale:") && ffxUpscalerSelection
                  ? t("Previous choice: {label} (refresh and choose again)", {
                      label: ffxUpscalerSelection.label,
                    })
                  : t("Version {index} (not offered here)", { index })
              }
              onPick={(index) => {
                const choice = ffxUpsChoices.options.find((item) => item.data === index);
                const pendingChanges = ffxUpscalerChanges(index, choice?.version, int8Route);
                const changes = choice?.context
                  ? pendingChanges.map((change) => ({
                      ...change,
                      live_context: choice.context as LiveContext,
                    }))
                  : bindChanges(pendingChanges);
                const selected = changes.find(
                  (change) => change.section === "FSR" && change.key === "UpscalerIndex",
                );
                setFfxUpscalerSelection({
                  value: index,
                  label: choice?.label ?? `Version ${index}`,
                  context: selected?.live_context ?? null,
                  baselineSeq: liveResult?.seq ?? reportedLive?.seq ?? null,
                  baselineResult: liveResult ?? null,
                });
                onApply(changes);
              }}
            />
          </PanelSectionRow>
        ) : null}

        {ffxUpsNotLive ? (
          <PanelSectionRow>
            <Notice tone="info">
              {ffxUpsSelectionIsStale || ffxUpsResultRejected
                ? t("Graphics state changed or rejected this choice. Pick again when live control is ready.")
                : t("Saved for next launch — could not switch FSR version live.")}
            </Notice>
          </PanelSectionRow>
        ) : null}

        {backendSwitch.canSwitchNow ? (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={backendSwitch.switching}
              onClick={() => void backendSwitch.applyUpscalerNow()}
            >
              {backendSwitch.switching ? t("Switching…") : t("Switch now, without restarting")}
            </ButtonItem>
          </PanelSectionRow>
        ) : null}

        {targetDir &&
        backendSwitch.picked &&
        backendSwitch.switchSelectionStale &&
        !backendSwitch.int8RestartOnly ? (
          <PanelSectionRow>
            <Notice tone="warn">
              {t("Graphics state changed — pick this upscaler again to switch live.")}
            </Notice>
          </PanelSectionRow>
        ) : null}

        {backendSwitch.switchNotReady ? (
          <PanelSectionRow>
            <Notice tone="info">
              {backendSwitch.pickedBinding?.saveFailed
                ? t("Save failed; fix the error and choose again.")
                : !backendSwitch.pickedConfigPersisted
                  ? backendSwitch.pickedBackendRevision !== null &&
                    backendSwitch.pickedBackendRevision !== undefined
                    ? t("Choice changed — pick again before switching.")
                    : t("Saving choice before offering live switch…")
                  : !backendSwitch.pickedBinding?.context
                    ? t("Saved for next launch — pick again when live control is ready, or restart.")
                    : t("Saved for next launch — cannot switch live right now.")}
            </Notice>
          </PanelSectionRow>
        ) : null}

        {backendSwitch.switchError ? (
          <PanelSectionRow>
            <Notice tone="error">{backendSwitch.switchError}</Notice>
          </PanelSectionRow>
        ) : null}

        {fsr4BusyLabel || fsr4Error ? (
          <PanelSectionRow>
            <Notice
              tone={fsr4Error ? "error" : "info"}
              title={fsr4Error ? t("FSR 4 change failed") : fsr4BusyLabel ?? undefined}
            >
              {fsr4Error ?? t("Updating FidelityFX DLL and settings…")}
            </Notice>
          </PanelSectionRow>
        ) : null}

        {int8Selected && !int8PresetMatches ? (
          <PanelSectionRow>
            <Notice tone="info" title={t("Manual INT8 settings")}>
              {t(
                "Files or settings differ from the community Lite preset. Close the game and select FSR 3.X/4 or restore the bundled DLL in Setup.",
              )}
            </Notice>
          </PanelSectionRow>
        ) : needsInt8 || ffxUpsNeedsInt8 ? (
          <PanelSectionRow>
            <Notice tone="info" title={t("FSR 4 on Steam Deck")}>
              {t(
                "Official 4.1.2 is bundled (restore DLL and pick FSR 3.X/4), or try the experimental community Lite preset on RDNA2 APUs.",
              )}
            </Notice>
          </PanelSectionRow>
        ) : fsr4Selected && !compact ? (
          <PanelSectionRow>
            <Notice tone="info" title={t("FSR 4 selected")}>
              {t(
                "Uses installed FSR 4 library (official 4.1.2 includes RDNA2/APU INT8). Verify the active model with the in-game watermark.",
              )}
            </Notice>
          </PanelSectionRow>
        ) : null}
      </PanelSection>

      {compact ? (
        <PanelSection title={t("Startup settings")}>{methodControls}</PanelSection>
      ) : null}
    </>
  );
}
