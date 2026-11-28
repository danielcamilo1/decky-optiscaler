# Phantom Blade Zero on Steam Deck: setup and requirements

Current releases bundle the complete official OptiScaler **0.9.5** package (FFX SDK 2.4 and FSR 4.1.2). This guide covers Phantom Blade Zero's game-specific directory, output-scale and wiki rules. For FSR 4 build selection, watermark verification and community-build caveats, see the [FSR 4 guide](steam-deck-fsr4.md). For live control, automatic upgrades and full rollback/Remove recovery, see the [live-control and recovery guide](live-control.md).

## Set up

1. Close the game. Install the Decky zip and open the game's **Setup** page.
2. The real target is the directory containing the main/big `PBZ.exe`: normally `PBZ/platform/steam`. Do not use the usual Unreal `Binaries/Win64` location. The plugin prefers the canonical folder when it exists and there is no saved or existing installation. If an older install is in the wrong folder, use **Remove** there first (for unmanaged external installs, remove those files manually), then select the main executable folder under **Setup → Manual setup**.
3. Review the wiki requirements shown in **Setup**. Recognized managed 0.9.4 or 0.9.5-pre5 installs upgrade automatically when opened with the game closed; fresh or unknown installs use regular **Setup**. Launch options are merged with existing wrappers and arguments; an unreadable launch-options field must be resolved before automatic replacement.
4. Choose your upscaler in **Settings (Basic mode) → Upscaler → Override upscaler with → FSR 3.X/4** (or **FSR 4.1.2 Lite — community** on recognized RDNA2 APUs; see the [FSR 4 guide](steam-deck-fsr4.md) for trade-offs and switching back).
5. In the game, keep **Super Resolution Output Scale = 100%**. Choose the quality preset and frame-generation settings that suit your setup and the game's wiki guidance.

The PBZ setup notes stay visible even without a network connection. This package does not copy NVIDIA DLLs out of the game or edit `Engine.ini`. The bundled OptiScaler 0.9.5 core includes the upstream PBZ extended DLL search and input quirks.

## Game-specific compatibility

PBZ's directory and version requirements apply to its recognized title, folder alias, or explicitly selected PBZ wiki entry. Renamed non-Steam shortcuts can pin the PBZ wiki entry manually, and the canonical directory must still contain `PBZ.exe`. A missing executable or wrong Unreal folder blocks setup and settings changes until corrected; an existing managed wrong-folder install remains removable.

Other games keep their own wiki plans, install targets and configuration. Automatic upgrades run when a managed game page is opened, not across the library during plugin startup.

## Verify in game

Use a recent Proton build with the VKD3D support required by FFX SDK 2.4 / FSR 4.1.2. Record the exact SteamOS, Mesa and Proton versions when reporting results; the plugin does not install or change them. The baseline path here is DX12 through Proton, not the experimental Vulkan-with-DX12 interop mode.

Confirm the active FSR4 model with the in-game watermark as described in the [FSR 4 guide](steam-deck-fsr4.md#official-optiscaler-path). Existing one-device OLED/Proton evidence is from the earlier **0.9.5-pre5** build ([2026-11-14 validation notes](validation/steam-deck-2026-11-14.md)); it does not verify the final 0.9.5 release's active model, image quality, performance or stability.

## Pinned sources

- [PBZ compatibility page](https://github.com/optiscaler/OptiScaler/wiki/Phantom-Blade-Zero): requires 0.9.5+, special folder and 100% output scale; tested on Windows 11 / RX 9070XT.
- [Official OptiScaler 0.9.5 release](https://github.com/optiscaler/OptiScaler/releases/tag/v0.9.5): full archive `Optiscaler_0.9.5-final.20261116.7z`, SHA-256 `77e3ed76bed04e1fb32bacb5a72799ff172f3da22ed5231c0cf3e84fe6761662`, source commit `90d9568d576d93ebb2d6c1c207596d21e9900651`.
- Community FSR 4 archives and hashes: see the [FSR 4 guide](steam-deck-fsr4.md#pinned-community-files).

Hashes and sizes of the official runtime are in `defaults/runtime-manifest.json`; community archive and DLL pins are in `py_modules/optiscaler/constants.py`. Live-bridge binary/source identities are recorded in `defaults/live-profile.json` and `defaults/live-build.json`.
