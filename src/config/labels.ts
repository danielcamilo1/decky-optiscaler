/**
 * Human-readable names for INI values.
 *
 * These follow OptiScaler's own overlay word for word, taken from the shipped
 * release's `menu/menu_common.cpp` (`GetBackendName` and the FG Input/Output
 * combos, vendored under `asi/optiscaler_ref/`). Inventing friendlier names
 * here would be actively harmful: the whole point of this plugin is that the
 * user can set something from the Deck UI and then recognise it when they open
 * the in-game overlay.
 */

/** `GetBackendName` in menu_common.cpp. */
export const UPSCALER_LABELS: Record<string, string> = {
  xess: "XeSS",
  fsr21: "FSR 2.1.2",
  fsr22: "FSR 2.2.1",
  // OptiScaler shows "FSR 3.X/4" when the GPU and settings make FSR 4 possible
  // and plain "FSR 3.X" otherwise; it is one backend either way.
  fsr31: "FSR 3.X/4",
  dlss: "DLSS",
  dlssd: "DLSSD",
  // DX11 / Vulkan interop variants
  xess_12: "XeSS w/Dx12",
  fsr21_12: "FSR 2.1.2 w/Dx12",
  fsr22_12: "FSR 2.2.1 w/Dx12",
  fsr31_12: "FSR 3.X/4 w/Dx12",
};

/** The FG Input combo. */
export const FG_INPUT_LABELS: Record<string, string> = {
  nofg: "No Frame Generation",
  nukems: "Nukem's DLSSG",
  fsrfg: "FSR 3.1 FG",
  dlssg: "DLSSG via Streamline",
  xefg: "XeFG",
  upscaler: "OptiFG (Upscaler)",
  fsrfg30: "FSR 3.0 FG",
};

/** The FG Output combo. */
export const FG_OUTPUT_LABELS: Record<string, string> = {
  nofg: "No Frame Generation",
  nukems: "FSR3-FG via Nukem's",
  fsrfg: "FSR FG",
  dlssg: "DLSSG",
  xefg: "XeFG",
};

// OptiScaler builds these at runtime from the FidelityFX SDK it loaded
// ("FSR " + the SDK's own version name), so these are the versions the
// bundled release reports rather than a fixed list.
export const FSR_BACKEND_LABELS: Record<string, string> = {
  "0": "FSR 4.0.2",
  "1": "FSR 3.1.5",
  "2": "FSR 2.3.4",
};

/** Curated labels keyed by "Section.Key". Applied on top of generated ones. */
export const VALUE_LABELS: Record<string, Record<string, string>> = {
  "Upscalers.Dx11Upscaler": UPSCALER_LABELS,
  "Upscalers.Dx12Upscaler": UPSCALER_LABELS,
  "Upscalers.VulkanUpscaler": UPSCALER_LABELS,
  "FrameGen.FGInput": FG_INPUT_LABELS,
  "FrameGen.FGOutput": FG_OUTPUT_LABELS,
  "FSR.UpscalerIndex": FSR_BACKEND_LABELS,
  "FSR.FGIndex": { "0": "FSR 4.0.0", "1": "FSR 3.1.6" },
  "XeFG.InterpolationCount": { "1": "2X", "2": "3X", "3": "4X" },
};

export function curatedLabel(optionId: string, value: string): string | undefined {
  return VALUE_LABELS[optionId]?.[value];
}
