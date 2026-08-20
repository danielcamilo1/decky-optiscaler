/**
 * Basic mode: a handful of controls that each drive several INI keys.
 *
 * OptiScaler's real configuration is split across keys that only make sense
 * together — an upscaler choice is a backend id plus an FSR4 flag, frame
 * generation is an input plus an output. Basic mode presents the combination.
 */

import type { ConfigValues, OptionChange } from "../types";
import { AUTO, isAuto } from "./values";

export interface Preset {
  id: string;
  label: string;
  description?: string;
  /** Written when the preset is chosen. */
  changes: OptionChange[];
  /** Recognises the preset from the current INI values. */
  matches: (values: ConfigValues) => boolean;
}

const get = (values: ConfigValues, section: string, key: string) =>
  (values[section]?.[key] ?? AUTO).toLowerCase();

const change = (section: string, key: string, value: string): OptionChange => ({
  section,
  key,
  value,
});

// -- Upscaler ---------------------------------------------------------------

/** Sets the same backend for every graphics API so the game gets it whichever it uses. */
function upscalerPreset(
  id: string,
  label: string,
  description: string,
  dx12: string,
  dx11: string,
  vulkan: string,
  fsr4Update?: boolean
): Preset {
  const changes = [
    change("Upscalers", "Dx12Upscaler", dx12),
    change("Upscalers", "Dx11Upscaler", dx11),
    change("Upscalers", "VulkanUpscaler", vulkan),
  ];
  if (fsr4Update !== undefined) {
    changes.push(change("FSR", "Fsr4Update", fsr4Update ? "true" : "false"));
    // UpscalerIndex picks which FSR generation the fsr31 backend runs.
    // Its "auto" resolves to FSR3 on anything that is not RDNA4.
    changes.push(change("FSR", "UpscalerIndex", fsr4Update ? "0" : "1"));
  }
  return {
    id,
    label,
    description,
    changes,
    matches: (values) => {
      if (get(values, "Upscalers", "Dx12Upscaler") !== dx12) return false;
      if (fsr4Update === undefined) return true;
      const flag = get(values, "FSR", "Fsr4Update");
      return fsr4Update ? flag === "true" : flag !== "true";
    },
  };
}

export const UPSCALER_PRESETS: Preset[] = [
  {
    id: "auto",
    label: "Auto (leave the game alone)",
    description: "OptiScaler picks its own default for each API.",
    changes: [
      change("Upscalers", "Dx12Upscaler", AUTO),
      change("Upscalers", "Dx11Upscaler", AUTO),
      change("Upscalers", "VulkanUpscaler", AUTO),
      change("FSR", "Fsr4Update", AUTO),
    ],
    matches: (values) => isAuto(get(values, "Upscalers", "Dx12Upscaler")),
  },
  upscalerPreset(
    "fsr4",
    "FSR 3.X/4",
    "OptiScaler's FidelityFX backend with FSR 4 turned on. Needs an RDNA 3 or RDNA 4 GPU.",
    "fsr31", "fsr31_12", "fsr31_12", true
  ),
  upscalerPreset(
    "fsr31",
    "FSR 3.X",
    "The same backend running FSR 3.1. Works on any GPU — the safe choice on a Steam Deck.",
    "fsr31", "fsr31", "fsr31", false
  ),
  upscalerPreset(
    "fsr22",
    "FSR 2.2.1",
    "Older FSR, most compatible.",
    "fsr22", "fsr22", "fsr22"
  ),
  upscalerPreset(
    "xess",
    "XeSS",
    "Intel's upscaler. Often the best image quality on AMD hardware.",
    "xess", "xess_12", "xess"
  ),
  upscalerPreset(
    "dlss",
    "DLSS",
    "Nvidia only — needs a real DLSS-capable GPU.",
    "dlss", "dlss", "dlss"
  ),
];

// -- Frame generation -------------------------------------------------------

function fgPreset(
  id: string,
  label: string,
  description: string,
  input: string,
  output: string
): Preset {
  return {
    id,
    label,
    description,
    changes: [
      change("FrameGen", "FGInput", input),
      change("FrameGen", "FGOutput", output),
    ],
    matches: (values) =>
      get(values, "FrameGen", "FGInput") === input &&
      get(values, "FrameGen", "FGOutput") === output,
  };
}

// Each preset is an FG Input and an FG Output together, and is named after the
// pair the way OptiScaler's own overlay names them, so that what is picked here
// is recognisable in the in-game FG Input / FG Output combos.
export const FG_PRESETS: Preset[] = [
  fgPreset(
    "fsrfg",
    "FSR FG",
    "FG Input “FSR 3.1 FG” into FG Output “FSR FG”. The most broadly compatible pair.",
    "fsrfg", "fsrfg"
  ),
  fgPreset(
    "xefg",
    "XeFG",
    "FG Input “FSR 3.1 FG” into FG Output “XeFG”. Supports 3X and 4X as well as 2X.",
    "fsrfg", "xefg"
  ),
  fgPreset(
    "nukems",
    "FSR3-FG via Nukem's",
    "FG Input “Nukem's DLSSG”. Uses the game's own DLSS-FG path — only for games that have it.",
    "nukems", "nukems"
  ),
  fgPreset(
    "dlssg",
    "DLSSG via Streamline",
    "FG Input “DLSSG via Streamline” into FG Output “FSR FG”. Only for games built on Streamline v2.",
    "dlssg", "fsrfg"
  ),
];

// -- The FFX frame generator ------------------------------------------------

/**
 * Which FidelityFX frame generator the FSR FG output runs.
 *
 * OptiScaler's overlay calls this "FFX FG" and changes it with a button
 * labelled "Change FG": it writes the index into its config and raises two
 * flags that make the FG context rebuild, which is the one part of frame
 * generation that genuinely does change mid-game. The list is not fixed — the
 * FFX SDK reports what it can offer to each game — so a running game is a
 * better source for it than the shipped INI, and `LiveStatus.ffx_fg_versions`
 * is that answer when there is one.
 */
export const FFX_FG_SECTION = "FSR";
export const FFX_FG_KEY = "FGIndex";
export const FFX_FG_ID = `${FFX_FG_SECTION}.${FFX_FG_KEY}`;

/**
 * Whether the FFX generator is the one in use. Nukem's and XeFG are other
 * implementations entirely and take no notice of this index; "auto" is included
 * because OptiScaler resolves it to FSR FG in the common case, and a running
 * game settles the question by reporting a version list or not.
 */
export function usesFfxFrameGen(values: ConfigValues): boolean {
  const output = get(values, "FrameGen", "FGOutput");
  return output === "fsrfg" || isAuto(output);
}

export function ffxFgChanges(index: string): OptionChange[] {
  return [change(FFX_FG_SECTION, FFX_FG_KEY, index)];
}

/** The multiplier control only does anything on the XeSS FG output. */
export const MULTIPLIER_SECTION = "XeFG";
export const MULTIPLIER_KEY = "InterpolationCount";

export function frameGenEnabled(values: ConfigValues): boolean {
  return get(values, "FrameGen", "Enabled") === "true";
}

export function activeFgPreset(values: ConfigValues): Preset | undefined {
  return FG_PRESETS.find((preset) => preset.matches(values));
}

export function activeUpscalerPreset(values: ConfigValues): Preset | undefined {
  return UPSCALER_PRESETS.find((preset) => preset.matches(values));
}

export function supportsMultiplier(values: ConfigValues): boolean {
  return get(values, "FrameGen", "FGOutput") === "xefg";
}

/**
 * Turning frame generation on has to pick an input and an output too, or
 * OptiScaler comes up with FG "enabled" but doing nothing.
 */
export function enableFrameGenChanges(values: ConfigValues): OptionChange[] {
  const changes = [change("FrameGen", "Enabled", "true")];
  if (!activeFgPreset(values)) {
    changes.push(...FG_PRESETS[0].changes);
  }
  return changes;
}

export function disableFrameGenChanges(): OptionChange[] {
  return [change("FrameGen", "Enabled", "false")];
}

/**
 * Turn frame generation on with a named input and output pair.
 *
 * Automatic mode uses this instead of the preset list: the wiki names the pair
 * the game can actually feed, which is a stronger statement than any default
 * this plugin could pick, and it can be a combination no preset covers.
 */
export function enableFrameGenWith(input: string, output: string): OptionChange[] {
  return [
    change("FrameGen", "Enabled", "true"),
    change("FrameGen", "FGInput", input),
    change("FrameGen", "FGOutput", output),
  ];
}
