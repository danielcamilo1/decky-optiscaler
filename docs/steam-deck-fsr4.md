# FSR 4.1.2 on Steam Deck

Use the [Phantom Blade Zero guide](phantom-blade-zero.md) for installation, game requirements and complete recovery.

The official path, the community Lite build and 4.1.1b use different files or model paths:

| Option | What it uses |
| --- | --- |
| Basic: **FSR 3.X/4** (bundled DLL installed) | Official OptiScaler 0.9.5 / FFX SDK 2.4 library with automatic model selection. On the Deck APU path, Auto selects Lite (model 3). |
| Basic: **FSR 4.1.2 Lite — community** | Experimental, hash-pinned Lite Exact community DLL for recognized Steam Deck and RDNA2 APU devices. |
| Installed Files: **Use legacy 4.1.1b** | Older community INT8 build with the RDNA2 ghosting fix; retained for existing installs and explicit fallback. |

## Official OptiScaler path

The complete official OptiScaler 0.9.5 package includes FFX SDK 2.4 and FSR 4.1.2. Its **Settings → Basic → FSR 3.X/4** option uses the bundled official library with `Fsr4ForceEnableInt8=auto` and `Fsr4Update=true`. OptiScaler chooses the supported model automatically; on its Steam Deck APU path, Auto selects model 3 Lite. File presence and saved settings do not prove which model is active, so check the in-game FSR watermark. `FSR4`, `FSR4-i8`, `FSR4-i8-2` and `FSR4L-i8` indicate FSR4 models; `FSR3` means fallback.

To return to the official DLL after using a community build, first choose **Installed Files & FSR 4 → Restore bundled upscaler**, then choose **FSR 3.X/4** in Basic. This leaves frame-generation settings unchanged.

## Experimental community Lite option

**FSR 4.1.2 Lite — community** is an explicit per-game option for recognized Steam Deck and RDNA2 APU devices. It installs only the `4.1.2l-exact` variant from the pinned archive; the plugin does not install the archive's lossy variants. This is a community-modified DLL, not the official SDK file. Its file-version resource still says `4.1.1.2740`; identify it by the pinned SHA-256 and the OptiScaler overlay version `4.1.2l-exact-igpu-r2-cyboman`.

The Lite model is in the DLL's legacy INT8 provider slot, so this preset explicitly writes `Fsr4ForceEnableInt8=1`, `Fsr4Update=true` and `UpscalerIndex=0`. It does not use the official APU Auto selection (`Fsr4ForceEnableInt8=auto`, model 3). The preset leaves frame-generation settings unchanged. Do not copy the official settings onto the community DLL or infer the active model from its PE version alone.

Existing community **4.1.1b** installs remain recognized as legacy; they are not silently changed to Lite. On supported devices, choose **FSR 4.1.2 Lite — community** in Basic to upgrade explicitly. If you want to revert from Lite to the older community build, choose **Installed Files & FSR 4 → Use legacy 4.1.1b**; this fallback appears only when Lite is installed. To go back to the official library, restore the bundled upscaler first as described above. These file switches preserve frame-generation settings.

The community project's [release notes](https://github.com/zgauthier2000/fsr4-shader-performance-overrides/releases/tag/dll-2026-11-05) report about 10% lower shader timing at 800p and 2% at 1080p on the Steam Deck, from two timing-kit reports against its `dll-2026-11-01` Lite release. These are shader timings, not game FPS, and do not compare this build with 4.1.1b. The project describes `4.1.2l-exact` as matching AMD's FSR 4.1.2 Lite output byte for byte in shader tests; that is not an independent image-quality test by this plugin on a Deck. Lite is a smaller network than full FSR4, and its output can differ from the full model.

Existing one-device OLED/Proton evidence is from the earlier pre5 package. It does not verify the final official library or the community Lite build on a Steam Deck.

There is an [open Steam Deck crash report](https://github.com/zgauthier2000/fsr4-shader-performance-overrides/issues/55) involving both Lite variants with OptiScaler v10.0.0-pre1 and GE-Proton 10-25. The maintainer could not reproduce it on a desktop RX 7800 XT. It does not establish a failure in this plugin's official OptiScaler 0.9.5 path, but it remains an unresolved community-build risk. Do not use modified community DLLs in online games or games with anti-cheat.

## Pinned community file

- Source: [`dll-2026-11-05`](https://github.com/zgauthier2000/fsr4-shader-performance-overrides/releases/tag/dll-2026-11-05), archive `fsr4.1.2-igpu-cyboman-rdna2-2026-11-05.7z`, SHA-256 `da7c7681bffe7ac60a01e859d5b107900d963557793ef67ddcfd03a832e1c03f`.
- Selected entry: `4.1.2l-exact/amd_fidelityfx_upscaler_dx12.dll`, 39,608,832 bytes, SHA-256 `f991d06a8b800ed3e01b95696333c842c3de590aec7d2e6b2340c4e583d84ef4`.
- The archive's root `NOTICE.md` is bundled unchanged. It identifies the DLL as modified community code, notes the removed AMD signature and includes applicable notices and licenses.
