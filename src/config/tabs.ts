import { GENERATED_OPTIONS } from "./generatedSchema";
import { t } from "../i18n";
import type { OptionMeta } from "../types";

export interface TabDefinition {
  id: string;
  title: string;
  /** INI sections shown on this tab, in display order. */
  sections: string[];
  blurb?: string;
}

/** Friendlier headings than the raw INI section names. */
export const SECTION_TITLES: Record<string, string> = {
  Upscalers: "Upscaler Selection",
  FrameGen: "Frame Generation",
  FSRFG: "FSR Frame Generation",
  XeFG: "XeSS Frame Generation",
  OptiFG: "OptiFG & HUD Fix",
  Nukems: "Nukem's dlssg-to-fsr3",
  FSRFGInputs: "FSR FG Inputs",
  Inputs: "Upscaler Inputs",
  Framerate: "Framerate Limit",
  XeSS: "XeSS",
  FSR: "FSR / FidelityFX",
  DLSS: "DLSS",
  DLSSD: "DLSS Ray Reconstruction",
  Libraries: "Library Paths",
  Menu: "In-Game Overlay",
  Spoofing: "GPU Spoofing",
  Plugins: "ASI Plugins",
  NvApi: "NvAPI",
  Dx11withDx12: "DX11 on DX12",
  Hooks: "Hooking",
  Sharpness: "Sharpness",
  OutputScaling: "Output Scaling",
  CAS: "Contrast Adaptive Sharpening",
  Log: "Logging",
  InitFlags: "Init Flags",
  UpscaleRatio: "Upscale Ratio Override",
  QualityOverrides: "Quality Ratio Overrides",
  DRS: "Dynamic Resolution",
  HDR: "HDR",
  "V-Sync": "V-Sync",
  Anisotropy: "Anisotropic Filtering",
  Mipmap: "Mipmap Bias",
  ProcessFilter: "Process Filter",
  Hotfix: "Hotfixes & Workarounds",
};

export const TABS: TabDefinition[] = [
  {
    id: "framegen",
    title: "Frame Gen",
    sections: ["FrameGen", "FSRFG", "XeFG", "Nukems", "FSRFGInputs"],
    blurb: "FG input (frame source) and FG output (frame generator).",
  },
  {
    id: "upscaling",
    title: "Upscaling",
    sections: [
      "Upscalers",
      "Inputs",
      "FSR",
      "XeSS",
      "DLSS",
      "DLSSD",
      "OutputScaling",
      "UpscaleRatio",
      "QualityOverrides",
      "DRS",
    ],
    blurb: "Upscaler backend that replaces the game's built-in upscaler.",
  },
  {
    id: "hudfix",
    title: "HUD Fix",
    sections: ["OptiFG"],
    blurb: "Reduces UI ghosting and flicker during frame generation.",
  },
  {
    id: "image",
    title: "Image",
    sections: ["Sharpness", "CAS", "HDR", "InitFlags", "Anisotropy", "Mipmap", "V-Sync", "Framerate"],
  },
  {
    id: "compat",
    title: "Compatibility",
    sections: [
      "Spoofing",
      "Hotfix",
      "Hooks",
      "NvApi",
      "Dx11withDx12",
      "Plugins",
      "ProcessFilter",
      "Libraries",
    ],
    blurb: "Per-game workarounds — change only if the wiki recommends it.",
  },
  { id: "overlay", title: "Overlay", sections: ["Menu", "Log"] },
];

/** Options surfaced at the top of a tab and in the quick panel. */
export const FEATURED: Record<string, string[]> = {
  framegen: ["FrameGen.Enabled", "FrameGen.FGInput", "FrameGen.FGOutput", "FrameGen.FTInput"],
  upscaling: ["Upscalers.Dx12Upscaler", "Upscalers.Dx11Upscaler", "Upscalers.VulkanUpscaler"],
  hudfix: ["OptiFG.HUDFix", "OptiFG.HUDFixExtended", "OptiFG.HUDLimit"],
  image: ["Sharpness.OverrideSharpness", "Sharpness.Sharpness", "Framerate.FramerateLimit"],
  compat: ["Spoofing.Dxgi", "Spoofing.StreamlineSpoofing"],
  overlay: ["Menu.OverlayMenu", "Menu.ShowFps", "Log.LogToFile"],
};

const BY_ID = new Map<string, OptionMeta>();
const BY_SECTION = new Map<string, OptionMeta[]>();

for (const option of GENERATED_OPTIONS) {
  BY_ID.set(`${option.section}.${option.key}`, option);
  const list = BY_SECTION.get(option.section) ?? [];
  list.push(option);
  BY_SECTION.set(option.section, list);
}

export const optionById = (id: string): OptionMeta | undefined => BY_ID.get(id);
export const optionsInSection = (section: string): OptionMeta[] => BY_SECTION.get(section) ?? [];
export const sectionTitle = (section: string): string => t(SECTION_TITLES[section] ?? section);

/** Sections that exist in the INI but are not on any tab. */
export const UNGROUPED_SECTIONS = Array.from(BY_SECTION.keys()).filter(
  (section) => !TABS.some((tab) => tab.sections.includes(section))
);
