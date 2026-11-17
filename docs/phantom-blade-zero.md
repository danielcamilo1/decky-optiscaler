# Phantom Blade Zero on Steam Deck: FSR 4.1.2

The 0.0.8 plugin release bundles the complete official OptiScaler **0.9.5** package, including FFX SDK 2.4 and FSR 4.1.2. The release adds official RDNA2 and selected APU support, with exclusions. OptiScaler recognizes the Steam Deck APU path; automatic APU model selection defaults to model 3 Lite. Verify the active model on Deck with the in-game watermark. Existing one-device OLED/Proton evidence is from the earlier **0.9.5-pre5** package; it does not verify the final package's active model, image quality, performance or stability.

## Set up

1. Close the game. Install this Decky zip and open the game's **Setup** page.
2. The real target is the directory containing the main/big `PBZ.exe`: normally `PBZ/platform/steam`. Do not use the usual Unreal `Binaries/Win64` location. The plugin prefers the canonical folder when it exists and there is no saved or existing installation. If an older install is in the wrong folder, use **Remove** there first, then select the main executable folder in Manual setup.
3. Review the wiki requirements shown in Setup. Opening a recognized managed 0.9.4 or 0.9.5-pre5 game page automatically upgrades the runtime with the game closed, preserving the INI, installed components and launch options, and taking an immutable restore point first. Fresh or unknown installs use regular Setup. Launch options are merged with existing wrappers and arguments; an unreadable launch-options field must be resolved before automatic replacement.
4. The official route is **Settings → Basic → FSR 3.X/4**. To try the experimental **FSR 4.1.2 Lite — community** option, select it explicitly; it appears only for recognized Steam Deck / RDNA2 APU hardware. Existing 4.1.1b installs stay identified as legacy until you choose the new option. To return to the official DLL after either community build, use **Installed Files & FSR 4 → Restore bundled upscaler**, then select **FSR 3.X/4** in Basic. **Use legacy 4.1.1b** in Installed Files is a fallback after the new community build is installed. These switches leave frame-generation settings unchanged.
5. In the game, keep **Super Resolution Output Scale = 100%**. Choose the quality preset and frame-generation settings that suit your setup and the game's wiki guidance.

The setup notes stay visible even without a network connection. This package does not copy NVIDIA DLLs out of the game or edit Engine.ini. The core contains the upstream PBZ extended DLL search and input quirks.

## Game-specific compatibility

PBZ's directory/version requirements apply to its recognized title, folder alias, or explicitly selected PBZ wiki entry. Renamed non-Steam shortcuts can select that entry manually, but the canonical directory must still contain `PBZ.exe`. A missing executable or wrong Unreal folder blocks setup until corrected; an existing wrong-folder install remains removable.

Other games keep their own wiki plans, install targets and configuration. The experimental community Lite preset is a per-game choice shown only for recognized RDNA2 APUs, independently of the wiki plan. Frame-generation settings remain user-controlled. The shared core upgrade and matching live bridge apply generally. Automatic upgrades run when a managed game page is opened, not across the library during plugin startup.

## Verify in game

Use a recent Proton build with the VKD3D support required by FFX SDK 2.4 / FSR 4.1.2. Record the exact SteamOS, Mesa and Proton versions when reporting results; the plugin does not install or change them. The baseline path here is DX12 through Proton, not the experimental Vulkan-with-DX12 interop mode.

The displayed DLL identity and saved settings show **configured**, not **active**. Check the OptiScaler overlay's FSR4 watermark (or set `Fsr4EnableWatermark=true`) for the active model: `FSR4`, `FSR4-i8`, `FSR4-i8-2` or `FSR4L-i8` confirm an FSR4 path; `FSR3` indicates fallback. For the community Lite build, also confirm the custom overlay version `4.1.2l-exact-igpu-r2-cyboman`; its Lite network occupies the generic INT8 slot, so it need not show the official SDK Lite watermark. File identity alone does not prove that the Deck is using the expected GPU path. There is no promised FPS improvement.

The [native live bridge](live-control.md) is calibrated to the final 0.9.5 core and PDB. The automatic runtime upgrade also installs the matching bridge. Unknown runtimes need review in Setup, with the game closed. Live controls become available only after a matching game session reaches a supported frame callback. Startup settings require a game restart. Unknown same-name ASIs or unresolved custom plugin paths block an upgrade rather than being silently deleted.

## Restore everything

Close the game before either operation:

- **Restore previous install** restores the first immutable snapshot (an existing snapshot is reused, so it may predate the immediately previous upgrade): the previous core, INI bytes/comments, selected community DLL, owned components, original backup inventory, related per-game settings, and the launch options captured at that point. It removes new owned files absent from that snapshot. The restore point remains until Remove, so a failed Steam setter can be retried. After an explicit rollback, automatic upgrading is paused for that bundled core and the new schema remains read-only until you manually upgrade. A later bundle with a different core can upgrade again.
- **Remove** completely removes the managed installation and newly introduced snapshot files, then restores the earliest original game files and the recorded original launch options through the existing removal prompt. Keeping the plugin's launch options is still an explicit choice; select the restore option when you want complete restoration. New setup actions never replace the oldest original backups.

A failed file/configuration commit must leave the pre-operation files and manifest intact; failed operations are not presented as complete. An original INI already lost by an older plugin cannot be reconstructed: the upgrade snapshot protects the INI that actually exists now, and this distinction must not be confused with recovering a file lost before this build was installed. Unrelated game/user files are not part of the restore inventory.

## Pinned sources

- [PBZ compatibility page](https://github.com/optiscaler/OptiScaler/wiki/Phantom-Blade-Zero): requires 0.9.5+, special folder and 100% output scale; tested on Windows 11 / RX 9070XT.
- [Official OptiScaler 0.9.5 release](https://github.com/optiscaler/OptiScaler/releases/tag/v0.9.5): full archive `Optiscaler_0.9.5-final.20261116.7z`, SHA-256 `77e3ed76bed04e1fb32bacb5a72799ff172f3da22ed5231c0cf3e84fe6761662`, source commit `90d9568d576d93ebb2d6c1c207596d21e9900651`. It includes FFX SDK 2.4 / FSR 4.1.2; RDNA2 and some APUs are supported, with exclusions.
- [Community Lite release](https://github.com/zgauthier2000/fsr4-shader-performance-overrides/releases/tag/dll-2026-11-05): selected `4.1.2l-exact` archive path and hashes, trade-offs and issue notes are in the [FSR 4 guide](steam-deck-fsr4.md). The bundled archive includes its upstream `NOTICE.md`.
- [Community 4.1.1b](https://github.com/the3rdparty1917/fsr4xyz/releases/tag/4.1.1b): remains hash-recognized as a legacy fallback; it is not the current Basic preset.

Hashes and sizes of the official runtime are in `defaults/runtime-manifest.json`; community archive and DLL pins are in `py_modules/optiscaler/constants.py` and the FSR guide. The live bridge's ABI, source and PDB-backed profile are calibrated to the final release; binary/source identities are recorded in `defaults/live-profile.json` and `defaults/live-build.json`. Existing OLED/Proton and Gaming Mode/recovery checks are from the earlier pre5 build; they do not validate final-release FSR4 selection or runtime behavior on a Steam Deck.
