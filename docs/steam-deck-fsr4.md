# Steam Deck FSR 4.1.1b

Close the game, install OptiScaler through the plugin if needed, and select
**FSR 4.1.1b — Steam Deck** under Basic → Override upscaler with. The first use
requires a download (about 3.5 MB); later games reuse the verified cached DLL.
Download or validation failure leaves the previous DLL and settings intact.

This option installs the community `amd_fidelityfx_upscaler_dx12.dll` from
[the3rdparty1917/fsr4xyz 4.1.1b](https://github.com/the3rdparty1917/fsr4xyz/releases/tag/4.1.1b).
The release describes an RDNA2 ghosting fix. Archive and DLL SHA-256 values are
pinned in the plugin. The SDK's version resource still says 4.1.1, so Setup
identifies the build by its bytes instead of relying on that version string.

The plugin still bundles OptiScaler runtime **0.9.4**, including the original
SDK **4.1.1**. OptiScaler Client **1.0.7** is a separate management application;
it is not required or installed by this plugin.

## Settings and verification

The option selects the FidelityFX backend (`fsr31` for DX12), sets
`Fsr4ForceEnableInt8=true`, `UpscalerIndex=0`, and resets `Fsr4Update` and
`Fsr4Preset` to `auto`. DX11/Vulkan select the existing DX12 bridge backend.
INT8 initialization requires a fresh game launch. Per-game compatibility still
applies; the preset cannot add upscaler inputs to an unsupported game.

Launch the game and use its supported upscaler input (for example XeSS in the
Cyberpunk setup tested here). Enable the FSR watermark in OptiScaler to confirm
`FSR4-I8`; plain FSR3 indicates fallback. Setup identifies the installed patch,
while the watermark identifies the model actually running.

This is experimental community support for RDNA2. Evaluate motion/ghosting,
image quality and base frame rate in the same scene before and after enabling.
It does not fix or enable FSR4 frame generation. You may keep FSR3 frame generation
with FSR4 upscaling; test stability separately. Avoid modified DLLs in games whose
anti-cheat forbids them.

## Switching back

Choose FSR 3.X or another upscaler in Basic settings to change the active backend.
The community DLL stays installed for later use. To remove the patch, close the
game and choose **Restore bundled upscaler** in Setup. This keeps settings intact;
INT8 configured by hand or retained after restore is labelled **FSR 4 INT8 (manual)**.

Reinstall preserves a verified community DLL. If that DLL is missing or altered,
reinstall stops with repair instructions instead of silently replacing the patch.
Select the Steam Deck option again to repair it, or restore the bundled DLL.
Uninstall restores the game's original backed-up files, not the OptiScaler SDK.

The source release and pinned hashes should be reviewed before updating to a new
community build. Older 4.0.2 community variants are outside this feature's scope.
