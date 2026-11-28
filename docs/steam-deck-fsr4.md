# FSR 4.1.2 on Steam Deck

This is the authoritative guide for choosing, verifying, and switching FSR 4 upscaler builds in Decky OptiScaler. For live control and rollback/Remove recovery, see the [live-control and recovery guide](live-control.md). For Phantom Blade Zero's executable folder and wiki rules, see the [Phantom Blade Zero guide](phantom-blade-zero.md).

The official path, the community Lite build and legacy `4.1.1b` use different files or model paths:

| Where to pick it | What it uses |
| --- | --- |
| **Settings (Basic mode) → Upscaler → Override upscaler with → FSR 3.X/4** (bundled DLL installed) | Official OptiScaler 0.9.5 / FFX SDK 2.4 library with automatic model selection. On the Deck APU path, Auto selects Lite (model 3). |
| **Settings (Basic mode) → Upscaler → Override upscaler with → FSR 4.1.2 Lite — community** | Experimental, hash-pinned Lite Exact community DLL for recognized Steam Deck and RDNA2 APU devices. |
| **Setup → Manual setup → Installed Files & FSR 4 → Use legacy 4.1.1b** | Older community INT8 build with the RDNA2 ghosting fix; retained for existing installs and explicit fallback. |

> **Navigation note:** Global plugin preferences live under the top-level **Plugin Settings** tab. Per-game upscaler options live inside the game's **Settings** tab (toggle **Basic | Advanced** at the top of the game page).

## Official OptiScaler path

The complete official OptiScaler 0.9.5 package includes FFX SDK 2.4 and FSR 4.1.2, adding official RDNA2 and selected APU support (with exclusions). Choosing **Settings (Basic mode) → Upscaler → Override upscaler with → FSR 3.X/4** uses the bundled official library with `Fsr4ForceEnableInt8=auto` and `Fsr4Update=true`. OptiScaler chooses the supported model automatically; on its Steam Deck APU path, Auto selects model 3 Lite.

Displayed DLL identity and saved settings show **configured**, not **active**. Confirm the active model in game using the OptiScaler overlay's FSR4 watermark (or set `Fsr4EnableWatermark=true`): `FSR4`, `FSR4-i8`, `FSR4-i8-2` and `FSR4L-i8` confirm an FSR4 model; `FSR3` means fallback.

To return to the official DLL after using a community build (with the game closed):

- Select **Settings (Basic mode) → Upscaler → Override upscaler with → FSR 3.X/4** and confirm restoring the bundled official DLL and settings, **or**
- Open **Setup → Manual setup → Installed Files & FSR 4 → Restore bundled upscaler**, then choose **FSR 3.X/4** in **Settings (Basic mode)**.

Both routes preserve your frame-generation settings.

## Experimental community Lite option

**FSR 4.1.2 Lite — community** is an explicit per-game option for recognized Steam Deck and RDNA2 APU devices (selected with the game closed). It installs only the `4.1.2l-exact` variant from the pinned archive; the plugin does not install the archive's lossy variants. This is a community-modified DLL, not the official SDK file. Its file-version resource still says `4.1.1.2740`; identify it by the pinned SHA-256 and the OptiScaler overlay version `4.1.2l-exact-igpu-r2-cyboman`.

The Lite model is in the DLL's legacy INT8 provider slot, so this preset explicitly writes `Fsr4ForceEnableInt8=1`, `Fsr4Update=true` and `UpscalerIndex=0`. It does not use the official APU Auto selection (`Fsr4ForceEnableInt8=auto`, model 3), and it need not show the official SDK Lite watermark. The preset leaves frame-generation settings unchanged. Do not copy the official settings onto the community DLL or infer the active model from its PE version alone.

Existing community **4.1.1b** and prior **dll-2026-11-05** Lite installs remain hash-recognized; they are not silently changed. On supported devices, choose **FSR 4.1.2 Lite — community** in **Settings (Basic mode) → Upscaler → Override upscaler with** to upgrade explicitly to the current pinned Lite build. If you want to revert from Lite to the older community build, open **Setup → Manual setup → Installed Files & FSR 4 → Use legacy 4.1.1b** (this fallback appears only when Lite is installed). These file switches require the game to be closed and preserve frame-generation settings.

The community project's [release notes](https://github.com/zgauthier2000/fsr4-shader-performance-overrides/releases/tag/dll-2026-11-22) report that `4.1.2l-exact` launches Lite's passes as AMD's own Lite DLL does (up to 3% faster than `dll-2026-11-05` in upstream shader timing tests, and matching AMD's Lite output at 800p and 1440p in addition to 1080p and 4K). These are upstream shader timings, not game FPS, and do not compare this build with 4.1.1b. The project describes `4.1.2l-exact` as matching AMD's FSR 4.1.2 Lite output in shader tests; that is not an independent image-quality test by this plugin on a Deck. Lite is a smaller network than full FSR4, and its output can differ from the full model.

Existing one-device OLED/Proton evidence is from the earlier `0.9.5-pre5` package (see [2026-11-14 validation notes](validation/steam-deck-2026-11-14.md)). It does not verify the final official library or the community Lite build on a Steam Deck.

There is an [open Steam Deck crash report](https://github.com/zgauthier2000/fsr4-shader-performance-overrides/issues/55) involving both Lite variants with OptiScaler v10.0.0-pre1 and GE-Proton 10-25. The maintainer could not reproduce it on a desktop RX 7800 XT. It does not establish a failure in this plugin's official OptiScaler 0.9.5 path, but it remains an unresolved community-build risk. Do not use modified community DLLs in online games or games with anti-cheat.

## Pinned community files

- **FSR 4.1.2 Lite (`4.1.2l-exact`)**: [`dll-2026-11-22`](https://github.com/zgauthier2000/fsr4-shader-performance-overrides/releases/tag/dll-2026-11-22), archive `fsr4.1.2-igpu-cyboman-rdna2-2026-11-22.7z`, SHA-256 `8dd65d22b20f968f0d6529716cbcd05b12ca93d8e543f1e878fc5e08bbb1099c`.
  - Selected entry: `4.1.2l-exact/amd_fidelityfx_upscaler_dx12.dll`, 39,603,200 bytes, SHA-256 `b0bcbcac5b81b7b6cf1718f092bda066e00e5a4bba1f260c4c3931efa25a7c07`.
  - The archive's root `NOTICE.md` is bundled unchanged. It identifies the DLL as modified community code, notes the removed AMD signature and includes applicable notices and licenses.
  - Prior pinned `dll-2026-11-05` installs (`4.1.2-lite-exact-20261105`, 39,608,832 bytes, SHA-256 `f991d06a8b800ed3e01b95696333c842c3de590aec7d2e6b2340c4e583d84ef4`) remain hash-recognized so existing games can verify cleanly, upgrade to `dll-2026-11-22`, restore the bundled official DLL, or uninstall without errors.
- **Legacy 4.1.1b**: [`4.1.1b`](https://github.com/the3rdparty1917/fsr4xyz/releases/tag/4.1.1b) — hash-recognized as a legacy fallback; archive and DLL pins live in `py_modules/optiscaler/constants.py`.
