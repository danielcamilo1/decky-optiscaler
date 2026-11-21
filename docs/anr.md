# Apex Neural Rendering (ANR FG)

[Apex Neural Rendering (ANR)](https://github.com/apex-compute/ANR) provides neural frame generation (**ANR FG**, beta) as an alternative to FSR Frame Generation and NVIDIA DLSS Frame Generation on Steam Deck and desktop GPUs.

## How Decky OptiScaler integrates ANR FG

- **On-demand verified download:** ANR FG's beta binaries are proprietary and are not bundled inside the Decky OptiScaler zip. When you enable ANR FG for a game, Decky OptiScaler downloads the pinned release (`FG-V.B20`, `anr-fg-V.B20-full.zip`, ~11.7 MB) into `~/homebrew/data/Decky OptiScaler/anr/`, verifies the archive SHA-256 and the extracted DLL SHA-256 checksums, and reuses that local cache for any other games.
- **OptiScaler runtime swap:** ANR FG uses OptiScaler's `FGNvngxReplacement` custom-provider hook, which is not yet present in OptiScaler 0.9.5. Enabling ANR FG swaps the game's installed OptiScaler proxy DLL to the pinned Apex OptiScaler build (upstream commit `d6b02459`), copies the verified provider files into `OptiScaler/custom/Apex Neural Rendering FG/`, and sets:
  ```ini
  [FrameGen]
  Enabled=auto
  FGInput=nvngxfg
  FGOutput=auto
  FGNvngxReplacement=Apex Neural Rendering FG
  DisableHudless=false
  ```
- **Live-control safety:** Because `decky_optiscaler_live.asi` is calibrated specifically to OptiScaler 0.9.5, enabling ANR FG removes the 0.9.5 live-control ASI so it is never loaded into the `d6b02459` runtime. Disabling ANR FG restores bundled OptiScaler 0.9.5, restores your prior `[FrameGen]` settings, and reinstalls the live-control ASI if it was active beforehand.

## Switching to and from ANR FG

No manual setup is needed — switch to ANR FG directly from the normal Frame Generation controls:

1. Set up OptiScaler for the game in **Setup** as usual and make sure the game is **closed**.
2. Open **Settings → Frame Generation**, turn **Frame generation** on, and choose **ANR FG (Apex Neural Rendering)** in the **Method** dropdown.
   - Decky OptiScaler downloads and verifies the pinned `FG-V.B20` package once (cached for other games), swaps the game's proxy DLL to Apex's OptiScaler build, pauses 0.9.5 live control, and writes the required `[FrameGen]` settings.
3. Launch the game and enable **NVIDIA DLSS Frame Generation** in the game's graphics settings — ANR FG takes its place.
4. To switch back at any time, close the game and choose any other **Method** (`FSR FG`, `XeFG`, `FSR3-FG via Nukem's`, or `DLSSG via Streamline`) — Decky OptiScaler automatically restores bundled OptiScaler 0.9.5 and live control. Status and manual recovery controls also remain available under **Setup → Manual setup → Apex Neural Rendering (ANR FG)**.

> **Note on upscaling (ANR SR):** Apex Compute has not released **ANR SR** (super resolution / upscaling) or **ANR RR** (ray reconstruction) yet — upstream currently lists both as "Beta soon". Once ANR SR ships, it can be integrated alongside the existing upscaler presets.
