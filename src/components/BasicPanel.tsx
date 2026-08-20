import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import { useState } from "react";
import { switchUpscaler } from "../api";
import {
  FFX_FG_ID,
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
  frameGenEnabled,
  supportsMultiplier,
  usesFfxFrameGen,
} from "../config/basic";
import { optionById } from "../config/tabs";
import { effectiveValue, labelFor } from "../config/values";
import type { Preset } from "../config/basic";
import type {
  AutoPlan,
  ConfigValues,
  GpuInfo,
  LiveStatus,
  OptionChange,
  OptionMeta,
} from "../types";
import { Mono, Notice, Pill } from "./Common";

interface Props {
  values: ConfigValues;
  disabled?: boolean;
  gpu?: GpuInfo | null;
  live?: LiveStatus | null;
  /**
   * Where OptiScaler is installed. Supplying it turns on the upscaler switch,
   * which only belongs where the running game is being driven — the Quick
   * Access panel. The full page's Settings tab is for a game that is not
   * running, so it leaves this out and the control never appears there.
   */
  targetDir?: string;
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
  onAutoChange?: (enabled: boolean) => void;
  onLiveChanged?: () => void;
  onApply: (changes: OptionChange[]) => void;
}

const MULTIPLIER_ID = `${MULTIPLIER_SECTION}.${MULTIPLIER_KEY}`;

/**
 * The FFX FG versions to offer, and where the list came from.
 *
 * A running game is the authority: OptiScaler asks the FidelityFX SDK what it
 * can offer and that answer depends on the game's own runtime, so the shipped
 * INI's documented pair is only a stand-in for when nothing is attached to ask.
 */
function ffxFgOptions(live: LiveStatus | null | undefined, option: OptionMeta | undefined) {
  const reported = live?.ffx_fg_versions ?? [];
  if (reported.length > 0) {
    return {
      fromGame: true,
      options: reported.map((name, index) => ({ data: String(index), label: `FSR ${name}` })),
    };
  }
  return {
    fromGame: false,
    options: (option?.options ?? []).map((value) => ({
      data: value,
      label: labelFor(option as OptionMeta, value),
    })),
  };
}

/** The DX12 backend id a preset selects, or null for "leave the game alone". */
function backendCode(preset: Preset | undefined): string | null {
  const change = preset?.changes.find(
    (item) => item.section === "Upscalers" && item.key === "Dx12Upscaler"
  );
  const value = change?.value?.toLowerCase();
  return value && value !== "auto" ? value : null;
}

export function BasicPanel({
  values,
  disabled,
  gpu,
  live,
  targetDir,
  compact,
  plan,
  auto,
  onAutoChange,
  onLiveChanged,
  onApply,
}: Readonly<Props>) {
  // Which upscaler the user just picked, if it is not the one the game is
  // running. Cleared once the game has taken it, so the switch is offered only
  // when there is something to switch to.
  const [picked, setPicked] = useState<string | null>(null);
  const [methodChanged, setMethodChanged] = useState(false);
  const [ffxFgChanged, setFfxFgChanged] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  /** Explanatory text, dropped in the narrow Quick Access column. */
  const hint = (text: string | undefined) => (compact ? undefined : text);

  const fgOn = frameGenEnabled(values);
  const fgPreset = activeFgPreset(values);
  const upscalerPreset = activeUpscalerPreset(values);
  const multiplierOption = optionById(MULTIPLIER_ID);
  const multiplierUsable = supportsMultiplier(values);

  // Automatic mode is only on offer when the wiki actually matched this game.
  const planned = plan?.available ? plan : null;
  const automatic = Boolean(planned) && Boolean(auto);
  const plannedFg = planned?.framegen ?? null;
  // A wiki entry that reports no working frame-generation input is a statement
  // worth honouring: the toggle is left visible so the reason can be read, but
  // turning it on would only produce FG that never engages.
  const fgUnavailable = automatic && plannedFg?.input === "nofg";

  // DLSS needs a real Nvidia GPU; offering it on a Deck is offering a setting
  // that can only fail. Kept visible when the ini already selects it, so the
  // dropdown can still show what is configured, and when the GPU is unknown.
  const upscalerChoices = UPSCALER_PRESETS.filter(
    (preset) =>
      preset.id !== "dlss" ||
      upscalerPreset?.id === "dlss" ||
      !gpu?.vendor ||
      gpu.vendor === "nvidia"
  );

  const fsr4Selected = upscalerPreset?.id === "fsr4";
  const gpuBlocked = fsr4Selected && gpu?.fsr4 === "unsupported";

  // The FFX frame generator, which only the FSR FG output runs. When the game
  // is attached its own reported list wins; otherwise the shipped INI's.
  const ffxOption = optionById(FFX_FG_ID);
  const ffxUsable = usesFfxFrameGen(values);
  const ffxChoices = ffxFgOptions(live, ffxOption);
  const ffxSelected = ffxOption ? effectiveValue(values, ffxOption) : "0";
  // Attached, the user has moved it, and there is no way to act on it: the
  // in-game plugin did not find State's two FG change flags, so this was an ini
  // write only. Only worth saying once it has actually been asked for.
  const ffxNotLive = ffxFgChanged && Boolean(live?.attached) && !live?.can_change_fg;

  const liveFg = typeof live?.fg_enabled === "boolean" ? live.fg_enabled : null;
  const runningBackend = live?.upscaler?.dx12 ?? live?.upscaler?.vulkan ?? null;
  const wanted = backendCode(UPSCALER_PRESETS.find((preset) => preset.id === picked));
  // Nothing to apply once the game is already on it, or if the choice cannot be
  // pushed at all — the plugin has to be attached with an upscaler registered.
  const canSwitchNow =
    Boolean(targetDir) &&
    Boolean(wanted) &&
    wanted !== runningBackend &&
    Boolean(live?.attached) &&
    Boolean(live?.can_switch_upscaler);
  // Attached, a different upscaler picked, and still no switch on offer. The
  // one thing that causes this is a game that has not built an upscaler yet, so
  // say so rather than leaving the button mysteriously absent.
  const switchNotReady =
    Boolean(targetDir) &&
    Boolean(wanted) &&
    wanted !== runningBackend &&
    Boolean(live?.attached) &&
    !live?.can_switch_upscaler;

  const applyUpscalerNow = async () => {
    if (!targetDir || !wanted) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      const result = await switchUpscaler(targetDir, wanted);
      if (result.ok) setPicked(null);
      else setSwitchError(result.error ?? "Could not switch the upscaler");
      onLiveChanged?.();
    } catch (error_) {
      setSwitchError(String(error_));
    } finally {
      setSwitching(false);
    }
  };

  const turnFrameGenOn = () =>
    onApply(
      automatic && plannedFg && plannedFg.input !== "nofg"
        ? enableFrameGenWith(plannedFg.input, plannedFg.output)
        : enableFrameGenChanges(values)
    );

  /**
   * The one control here the running game cannot take.
   *
   * FG Input and FG Output are read when the swapchain is built, so this is a
   * restart either way — which is why in the Quick Access panel it is moved out
   * of the frame-generation section and put last, behind everything that does
   * apply now. Over a running game the controls that change what is on screen
   * are the ones worth reaching first, and a control that cannot act yet is not
   * one of them.
   */
  const methodControls = (
    <>
      {/* The method is offered in automatic mode too. The wiki's pair is the
          better *starting* answer — it is what the game can actually feed —
          but which generator to run is as much the user's call as the
          upscaler is, so it is a recommendation printed under the control
          rather than the control's replacement. */}
      <PanelSectionRow>
        <DropdownItem
          label="Method"
          description={hint(fgPreset?.description ?? "Choose which frame generator to use.")}
          disabled={disabled || !fgOn}
          bottomSeparator={automatic && plannedFg ? "none" : "standard"}
          rgOptions={FG_PRESETS.map((preset) => ({ data: preset.id, label: preset.label }))}
          selectedOption={fgPreset?.id ?? FG_PRESETS[0].id}
          onChange={(selected) => {
            const preset = FG_PRESETS.find((p) => p.id === selected.data);
            if (!preset) return;
            setMethodChanged(true);
            onApply(preset.changes);
          }}
        />
      </PanelSectionRow>

      {automatic && plannedFg ? (
        <PanelSectionRow>
          <div style={{ padding: "0 0 8px", fontSize: "12px", opacity: 0.85 }}>
            The wiki recommends{" "}
            <strong>
              {plannedFg.input === "nofg"
                ? "no frame generation"
                : `${plannedFg.input_label} → ${plannedFg.output_label}`}
            </strong>
            <div style={{ opacity: 0.65, fontSize: "11px" }}>{plannedFg.source}</div>
          </div>
        </PanelSectionRow>
      ) : null}
      {/* The FG input and output are read when the swapchain is created, so
          unlike the frame-generation toggle this one genuinely cannot apply
          now — OptiScaler's own overlay says the same when they change. */}
      {methodChanged ? (
        <PanelSectionRow>
          <Notice tone="warn" title="Restart the game to apply">
            The frame generation method is chosen when the game starts.
          </Notice>
        </PanelSectionRow>
      ) : null}
    </>
  );

  return (
    <>
      {planned ? (
        <PanelSection title="Settings mode">
          <PanelSectionRow>
            <ToggleField
              label="Automatic"
              description={hint(
                automatic
                  ? `Set from “${planned.game}” on the OptiScaler wiki. You choose frame ` +
                    "generation and how it runs, the multiplier and the upscaler; " +
                    "everything else follows the entry."
                  : "Let this game's wiki entry set everything except frame generation " +
                    "and how it runs, the multiplier and the upscaler."
              )}
              checked={automatic}
              disabled={disabled || !onAutoChange}
              bottomSeparator={automatic ? "none" : "standard"}
              onChange={(checked) => onAutoChange?.(checked)}
            />
          </PanelSectionRow>
          {automatic && !compact ? (
            <PanelSectionRow>
              <div style={{ padding: "0 0 8px", fontSize: "12px", opacity: 0.8 }}>
                {planned.settings.length > 0 ? (
                  <>
                    The wiki sets{" "}
                    {planned.settings.map((item, index) => (
                      <span key={`${item.section}.${item.key}`}>
                        {index > 0 ? ", " : ""}
                        <Mono>
                          {item.key}={item.value}
                        </Mono>
                      </span>
                    ))}
                    {plannedFg && plannedFg.input !== "nofg" ? (
                      <>
                        , and frame generation through {plannedFg.input_label} →{" "}
                        {plannedFg.output_label}
                      </>
                    ) : null}
                    . Turn this off to get every option back.
                  </>
                ) : (
                  <>
                    This entry needs no special OptiScaler settings
                    {plannedFg && plannedFg.input !== "nofg"
                      ? ` beyond frame generation through ${plannedFg.input_label} → ${plannedFg.output_label}`
                      : ""}
                    . Turn this off to get every option back.
                  </>
                )}
              </div>
            </PanelSectionRow>
          ) : null}
        </PanelSection>
      ) : null}

      <PanelSection title="Frame Generation">
        <PanelSectionRow>
          <ToggleField
            label="Frame generation"
            description={hint(
              fgUnavailable
                ? "The wiki reports no working frame-generation input for this game."
                : "Inserts generated frames between rendered ones."
            )}
            checked={fgOn}
            disabled={disabled || fgUnavailable}
            bottomSeparator={liveFg === null ? "standard" : "none"}
            onChange={(checked) =>
              checked ? turnFrameGenOn() : onApply(disableFrameGenChanges())
            }
          />
        </PanelSectionRow>

        {/* Directly under the toggle, so flipping it and seeing the game agree
            is one glance rather than a scroll. */}
        {liveFg !== null ? (
          <PanelSectionRow>
            <div style={{ padding: "0 0 6px", fontSize: "12px", opacity: 0.85 }}>
              In game:{" "}
              {liveFg ? <Pill color="#2f6b3f">ON</Pill> : <Pill color="#6b2f2f">OFF</Pill>}
              {typeof live?.fps === "number" && live.fps > 0 ? (
                <span style={{ opacity: 0.75 }}>{live.fps.toFixed(0)} fps</span>
              ) : null}
            </div>
          </PanelSectionRow>
        ) : null}

        {compact ? null : methodControls}

        {/* Which FidelityFX frame generator the FSR FG output runs — the
            overlay's "FFX FG" combo and its "Change FG" button. Unlike the
            method above it this one really does change mid-game: OptiScaler
            rebuilds the FG context when both of its change flags are raised,
            which is what the in-game plugin does alongside the write. */}
        {ffxUsable && ffxChoices.options.length > 1 ? (
          <PanelSectionRow>
            <DropdownItem
              label="FFX FG version"
              description={hint(
                ffxChoices.fromGame
                  ? "The frame generators this game's FidelityFX runtime reports."
                  : "Which FidelityFX frame generator the FSR FG output runs."
              )}
              disabled={disabled || !fgOn}
              bottomSeparator={ffxNotLive ? "none" : "standard"}
              rgOptions={ffxChoices.options}
              selectedOption={ffxSelected}
              onChange={(selected) => {
                setFfxFgChanged(true);
                onApply(ffxFgChanges(String(selected.data)));
              }}
            />
          </PanelSectionRow>
        ) : null}

        {/* Attached, but the in-game plugin could not find the two flags that
            make OptiScaler rebuild — so this one is recorded and nothing more.
            Said plainly rather than left to look like it worked. */}
        {ffxNotLive ? (
          <PanelSectionRow>
            <Notice tone="info">
              Saved. This game's frame generator cannot be rebuilt from here, so it changes
              when the game restarts.
            </Notice>
          </PanelSectionRow>
        ) : null}

        {multiplierOption ? (
          <PanelSectionRow>
            <DropdownItem
              label="Frame multiplier"
              description={
                multiplierUsable
                  ? hint("How many frames to present per rendered frame.")
                  : "Only XeSS Frame Generation can do more than 2X."
              }
              disabled={disabled || !fgOn || !multiplierUsable}
              bottomSeparator="standard"
              rgOptions={(multiplierOption.options ?? []).map((value) => ({
                data: value,
                label: labelFor(multiplierOption, value),
              }))}
              selectedOption={effectiveValue(values, multiplierOption)}
              onChange={(selected) =>
                onApply([
                  {
                    section: MULTIPLIER_SECTION,
                    key: MULTIPLIER_KEY,
                    value: String(selected.data),
                  },
                ])
              }
            />
          </PanelSectionRow>
        ) : null}

        {/* Only when there is something to say. The panel used to explain the
            restart path and OptiScaler's own hotkey here whether or not either
            was relevant, which is noise on a page for a game that is not even
            running. */}
        {!compact && live?.attached ? (
          <PanelSectionRow>
            <Notice tone="success" title="Live control is connected">
              Frame generation changes as soon as you set it here — no restart, no overlay.
            </Notice>
          </PanelSectionRow>
        ) : null}
      </PanelSection>

      <PanelSection title="Upscaler">
        <PanelSectionRow>
          <DropdownItem
            label="Override upscaler with"
            description={hint(
              upscalerPreset?.description ?? "Replaces whichever upscaler the game asks for."
            )}
            disabled={disabled}
            bottomSeparator="standard"
            rgOptions={upscalerChoices.map((preset) => ({
              data: preset.id,
              label: preset.label,
            }))}
            selectedOption={upscalerPreset?.id ?? "auto"}
            onChange={(selected) => {
              const preset = UPSCALER_PRESETS.find((p) => p.id === selected.data);
              if (!preset) return;
              setPicked(preset.id);
              setSwitchError(null);
              onApply(preset.changes);
            }}
          />
        </PanelSectionRow>

        {/* Immediately below the dropdown it belongs to, and only once a
            different upscaler has been picked: OptiScaler rebuilds the feature
            when this runs, which costs a frame, so it is not something to offer
            for its own sake. */}
        {canSwitchNow ? (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={switching}
              onClick={() => void applyUpscalerNow()}
            >
              {switching ? "Switching…" : "Switch now, without restarting"}
            </ButtonItem>
          </PanelSectionRow>
        ) : null}

        {switchNotReady ? (
          <PanelSectionRow>
            <Notice tone="info">
              {live?.backend_entries === 0
                ? "Saved. The game has not started upscaling yet, so there is nothing to switch — it takes effect as soon as it does."
                : "Saved. It applies when the game restarts."}
            </Notice>
          </PanelSectionRow>
        ) : null}

        {switchError ? (
          <PanelSectionRow>
            <Notice tone="error">{switchError}</Notice>
          </PanelSectionRow>
        ) : null}

        {gpuBlocked ? (
          <PanelSectionRow>
            <Notice tone="error" title="This GPU cannot run FSR 4">
              {gpu?.name ?? "This GPU"} is {gpu?.generation}. AMD supports FSR 4 on RDNA 3 and
              RDNA 4 only. Use FSR 3.1 or XeSS instead.
            </Notice>
          </PanelSectionRow>
        ) : fsr4Selected && !compact ? (
          <PanelSectionRow>
            <Notice tone="info" title="FSR 4 selected">
              Uses the FidelityFX 4.1 library bundled with OptiScaler. OptiScaler only picks
              FSR 4 by itself on RDNA 4, which is why choosing it here also sets the FSR
              backend explicitly.
            </Notice>
          </PanelSectionRow>
        ) : null}
      </PanelSection>

      {/* Last, and only in the Quick Access panel: everything above it takes
          effect in the running game, and this does not. */}
      {compact ? (
        <PanelSection title="Needs a restart">{methodControls}</PanelSection>
      ) : null}
    </>
  );
}
