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

## Enabling and disabling per game

1. Set up OptiScaler for the game in **Setup** as usual.
2. Make sure the game is **closed**.
3. Open **Setup → Manual setup → Apex Neural Rendering (ANR FG)** and choose **Enable ANR FG (FG-V.B20)**.
4. Launch the game and enable **NVIDIA DLSS Frame Generation** in the game's graphics settings — ANR FG takes its place.
5. To switch back at any time, close the game and choose **Disable ANR FG (restore OptiScaler 0.9.5)**, or use **Remove** to restore all original game files.
