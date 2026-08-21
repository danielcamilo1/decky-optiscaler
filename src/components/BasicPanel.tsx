import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import { useState } from "react";
import { switchUpscaler } from "../api";
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
  isFfxBackend,
  runningBackend,
  supportsMultiplier,
  usesFfxFrameGen,
  usesFfxUpscaler,
} from "../config/basic";
import { curatedLabel } from "../config/labels";
import { optionById } from "../config/tabs";
import { AUTO, effectiveValue, labelFor } from "../config/values";
import type { Preset } from "../config/basic";
import type {
  AutoPlan,
  ConfigValues,
  FfxUpscalerInfo,
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
 * One of the two FidelityFX version lists to offer, and where it came from.
 *
 * A running game is the authority for both: OptiScaler asks the FidelityFX SDK
 * what it can offer and that answer depends on the game's own runtime, so the
 * shipped INI's documented list is only a stand-in for when nothing is attached
 * to ask. OptiScaler's overlay names each entry "FSR " and the SDK's own
 * version string, and so does this.
 *
 * That stand-in is a snapshot of a *different* build. The reference ini this
 * plugin generates its schema from documents the versions the OptiScaler
 * release it came with provided — for the upscaler, "0 = FSR 4.0.2" — while the
 * library actually shipped here is 4.1.1, which is the version the game reports
 * and the overlay prints. So when the FidelityFX library next to the game can
 * be read, `newest` names entry 0 from the file rather than from the comment,
 * and only the older compatibility providers below it stay as documented.
 */
function ffxVersionOptions(
  reported: string[] | undefined,
  option: OptionMeta | undefined,
  newest?: string | null
) {
  if (reported && reported.length > 0) {
    return {
      fromGame: true,
      options: reported.map((name, index) => ({
        data: String(index),
        label: `FSR ${name}`,
        version: name,
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

/**
 * The FidelityFX library's version as OptiScaler would name it.
 *
 * The file carries four components ("4.1.1.2740"); the SDK reports three, and
 * three is what the overlay shows.
 */
function ffxVersionName(ffx: FfxUpscalerInfo | null | undefined): string | null {
  const parts = (ffx?.version ?? "").split(".").filter(Boolean);
  return parts.length >= 3 ? parts.slice(0, 3).join(".") : null;
}

interface Choice {
  data: string;
  label: string;
  /** The FidelityFX version this entry names, where the entry is one. */
  version?: string;
}

/**
 * A dropdown whose value is worked out from the ini and the running game rather
 * than remembered by the control.
 *
 * Steam's Dropdown shows the option whose `data` equals `selectedOption`. Given
 * a value that is in none of them it has nothing to show and keeps the label it
 * built last, which reads as the control ignoring the choice just made. Neither
 * source is guaranteed to name one of the choices on offer: an ini written from
 * the Advanced page or by a wiki plan can hold an upscaler or an FG pair no
 * preset covers, and the FFX FG list comes from the running game, which can
 * report fewer generators than the index the ini holds. So a value with no
 * option of its own is given one, named after itself — what the file says is
 * then readable here instead of being displayed as something it is not.
 *
 * The `key` is the same problem from the other end. Nothing here can see
 * whether Steam's control picked a new value up, so it is rebuilt whenever what
 * it should be displaying changes; the value is derived state, so there is
 * nothing in the control worth preserving across that.
 *
 * "What it should be displaying" is the label, not the value — and the label
 * can change while the value does not. Both FidelityFX lists start as the
 * shipped INI's snapshot and are replaced the moment the running game reports
 * its own, under an index that does not move: index 0 goes from "FSR 4.0.2",
 * which is what OptiScaler's reference ini documents, to "FSR 4.1.1", which is
 * what the game actually has. Re-keying on the value alone left the first name
 * on screen for ever. It showed up as the full page and the Quick Access panel
 * disagreeing about the same install — the panel mounts its controls only after
 * the config read resolves, by which time the first live poll has landed, so it
 * built the right label first time and the page never did.
 */
function ValueDropdown({
  options,
  selected,
  describe,
  onPick,
  ...rest
}: Readonly<{
  options: Choice[];
  selected: string;
  /** What to call a value the list does not offer. */
  describe: (value: string) => string;
  onPick: (value: string) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  bottomSeparator?: "standard" | "none";
}>) {
  const known = options.some((choice) => choice.data === selected);
  const rgOptions = known ? options : [...options, { data: selected, label: describe(selected) }];
  const shown = `${selected}\u0000${rgOptions.map((choice) => choice.label).join("\u0000")}`;
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
  ffx,
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
  const [ffxUpscalerChanged, setFfxUpscalerChanged] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  /** Explanatory text, dropped in the narrow Quick Access column. */
  const hint = (text: string | undefined) => (compact ? undefined : text);

  const fgOn = frameGenEnabled(values);
  const fgPreset = activeFgPreset(values);
  const upscalerPreset = activeUpscalerPreset(values);
  // What the ini actually holds, for the cases the presets do not cover. Basic
  // mode is a view of a file the Advanced page and the wiki plan also write, so
  // it has to be able to say "this is set to something I have no name for".
  const rawUpscaler = (values.Upscalers?.Dx12Upscaler ?? AUTO).toLowerCase();
  const rawFgInput = (values.FrameGen?.FGInput ?? AUTO).toLowerCase();
  const rawFgOutput = (values.FrameGen?.FGOutput ?? AUTO).toLowerCase();
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
  const ffxChoices = ffxVersionOptions(live?.ffx_fg_versions, ffxOption);
  // A game that reports a generator list has OptiScaler's FidelityFX FG built
  // for it, which is a firmer answer than the ini can give — FGOutput "auto"
  // resolves at runtime and the file cannot say which way it went. Either is
  // reason enough to show the control.
  const ffxUsable = usesFfxFrameGen(values) || ffxChoices.fromGame;
  // Nothing to pick when the runtime offers one generator, but which one the
  // game got is still worth seeing, so the control stays and goes quiet
  // instead of disappearing — it used to vanish on exactly those games.
  const ffxFixed = ffxChoices.options.length < 2;
  const ffxSelected = ffxOption ? effectiveValue(values, ffxOption) : "0";
  // Attached, the user has moved it, and there is no way to act on it: the
  // in-game plugin did not find State's two FG change flags, so this was an ini
  // write only. Only worth saying once it has actually been asked for.
  const ffxNotLive = ffxFgChanged && Boolean(live?.attached) && !live?.can_change_fg;

  // Which version of FSR the FidelityFX backend runs — the overlay's "FFX
  // Upscaler" combo, and the only place the exact version is written down.
  const ffxUpsOption = optionById(FFX_UPSCALER_ID);
  const ffxUpsChoices = ffxVersionOptions(
    live?.ffx_upscaler_versions, ffxUpsOption, ffxVersionName(ffx));
  const ffxUpsSelected = ffxUpsOption ? effectiveValue(values, ffxUpsOption) : "0";
  const ffxUpsFixed = ffxUpsChoices.options.length < 2;

  const liveFg = typeof live?.fg_enabled === "boolean" ? live.fg_enabled : null;
  // The same order the live tiles read it in — a DX11 game reports its backend
  // under dx11 and nowhere else, and leaving that out made the switch compare
  // the pick against nothing at all.
  const liveBackend = runningBackend(live);
  // Only the FidelityFX backend has versions to choose between. The ini answers
  // for a game that is not running; a game that *is* running has already picked
  // one, which settles it for the "auto" the ini can only leave open.
  const ffxUpsUsable = live?.attached ? isFfxBackend(liveBackend) : usesFfxUpscaler(values);
  // Attached, the user has moved it, and there was nothing to act on: no
  // upscaler is registered yet, so this was an ini write only.
  const ffxUpsNotLive =
    ffxUpscalerChanged && Boolean(live?.attached) && !live?.can_change_ffx_upscaler;
  const wanted = backendCode(UPSCALER_PRESETS.find((preset) => preset.id === picked));
  // Nothing to apply once the game is already on it, or if the choice cannot be
  // pushed at all — the plugin has to be attached with an upscaler registered.
  const canSwitchNow =
    Boolean(targetDir) &&
    Boolean(wanted) &&
    wanted !== liveBackend &&
    Boolean(live?.attached) &&
    Boolean(live?.can_switch_upscaler);
  // Attached, a different upscaler picked, and still no switch on offer. The
  // one thing that causes this is a game that has not built an upscaler yet, so
  // say so rather than leaving the button mysteriously absent.
  const switchNotReady =
    Boolean(targetDir) &&
    Boolean(wanted) &&
    wanted !== liveBackend &&
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
        <ValueDropdown
          label="Method"
          description={hint(fgPreset?.description ?? "Choose which frame generator to use.")}
          disabled={disabled || !fgOn}
          bottomSeparator={automatic && plannedFg ? "none" : "standard"}
          options={FG_PRESETS.map((preset) => ({ data: preset.id, label: preset.label }))}
          // A wiki plan writes the pair the entry names, which is a stronger
          // statement than any preset and need not be one of them.
          selected={fgPreset?.id ?? `${rawFgInput} \u2192 ${rawFgOutput}`}
          describe={() =>
            `${curatedLabel("FrameGen.FGInput", rawFgInput) ?? rawFgInput} \u2192 ` +
            `${curatedLabel("FrameGen.FGOutput", rawFgOutput) ?? rawFgOutput}`
          }
          onPick={(id) => {
            const preset = FG_PRESETS.find((p) => p.id === id);
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
        {ffxUsable && ffxChoices.options.length > 0 ? (
          <PanelSectionRow>
            <ValueDropdown
              label="FFX FG version"
              description={hint(
                ffxFixed
                  ? "The only frame generator this game's FidelityFX runtime offers."
                  : ffxChoices.fromGame
                    ? "The frame generators this game's FidelityFX runtime reports."
                    : "Which FidelityFX frame generator the FSR FG output runs."
              )}
              disabled={disabled || !fgOn || ffxFixed}
              bottomSeparator={ffxNotLive ? "none" : "standard"}
              options={ffxChoices.options}
              selected={ffxSelected}
              // The ini can hold an index this game's runtime does not offer —
              // it was set for another game, or by an older release with a
              // different list.
              describe={(index) => `Generator ${index} (not offered here)`}
              onPick={(index) => {
                setFfxFgChanged(true);
                onApply(ffxFgChanges(index));
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
            <ValueDropdown
              label="Frame multiplier"
              description={
                multiplierUsable
                  ? hint("How many frames to present per rendered frame.")
                  : "Only XeSS Frame Generation can do more than 2X."
              }
              disabled={disabled || !fgOn || !multiplierUsable}
              bottomSeparator="standard"
              options={(multiplierOption.options ?? []).map((value) => ({
                data: value,
                label: labelFor(multiplierOption, value),
              }))}
              selected={effectiveValue(values, multiplierOption)}
              describe={(value) => labelFor(multiplierOption, value)}
              onPick={(value) =>
                onApply([
                  { section: MULTIPLIER_SECTION, key: MULTIPLIER_KEY, value },
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
          <ValueDropdown
            label="Override upscaler with"
            description={hint(
              upscalerPreset?.description ?? "Replaces whichever upscaler the game asks for."
            )}
            disabled={disabled}
            bottomSeparator="standard"
            options={upscalerChoices.map((preset) => ({
              data: preset.id,
              label: preset.label,
            }))}
            // The Advanced page can set a backend no preset covers — fsr21, or
            // one of the dx11on12 variants. Showing "Auto" for those said the
            // opposite of what the file holds.
            selected={upscalerPreset?.id ?? rawUpscaler}
            describe={(code) => curatedLabel("Upscalers.Dx12Upscaler", code) ?? code}
            onPick={(id) => {
              const preset = UPSCALER_PRESETS.find((p) => p.id === id);
              if (!preset) return;
              setPicked(preset.id);
              setSwitchError(null);
              onApply(preset.changes);
            }}
          />
        </PanelSectionRow>

        {/* The second half of the same question. "fsr31" is every FSR from
            2.3.4 to 4.1.1 and OptiScaler names it "FSR 3.X/4" for exactly that
            reason; which one it actually runs is this index, which the overlay
            asks for separately under "FFX Settings" as its "FFX Upscaler"
            combo. It sits directly under the backend it qualifies, and only
            when that backend is the FidelityFX one — nothing else reads it. */}
        {ffxUpsUsable && ffxUpsChoices.options.length > 0 ? (
          <PanelSectionRow>
            <ValueDropdown
              label="FSR version"
              description={hint(
                ffxUpsFixed
                  ? "The only FSR version this game's FidelityFX runtime offers."
                  : ffxUpsChoices.fromGame
                    ? "The FSR versions this game's FidelityFX runtime reports."
                    : "Which version of FSR the FidelityFX backend runs."
              )}
              disabled={disabled || ffxUpsFixed}
              bottomSeparator={ffxUpsNotLive ? "none" : "standard"}
              options={ffxUpsChoices.options}
              selected={ffxUpsSelected}
              // The ini can hold an index this game's runtime does not offer —
              // it was set for another game, or written from the list a
              // different FidelityFX build reported.
              describe={(index) => `Version ${index} (not offered here)`}
              onPick={(index) => {
                setFfxUpscalerChanged(true);
                onApply(
                  ffxUpscalerChanges(
                    index,
                    ffxUpsChoices.options.find((choice) => choice.data === index)?.version
                  )
                );
              }}
            />
          </PanelSectionRow>
        ) : null}

        {/* Attached, but nothing to rebuild: the game has not built an upscaler
            yet, so this was recorded and no more. Said plainly rather than left
            to look as though the version changed. */}
        {ffxUpsNotLive ? (
          <PanelSectionRow>
            <Notice tone="info">
              Saved. The game has not started upscaling yet, so the version changes as soon
              as it does.
            </Notice>
          </PanelSectionRow>
        ) : null}

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
