# Steam Deck FSR 4.1.2

Use the [PBZ guide](phantom-blade-zero.md) for installation, required game settings, validation and complete restoration.

The complete official OptiScaler 0.9.5 package includes FFX SDK 2.4 and FSR 4.1.2, with official RDNA2 and selected APU support (some APUs are excluded). The core recognizes the Steam Deck APU path; automatic APU model selection defaults to model 3 Lite. File presence and saved settings do not prove which model is active on a Steam Deck; verify the in-game watermark. The package also keeps the separately verified community **4.1.1b INT8 RDNA2 ghosting fix** as an optional, explicitly selected preset.

For the official path, select **FSR 3.X/4** in **Settings → Basic**. It sets `Fsr4ForceEnableInt8=auto` and `Fsr4Update=true`; OptiScaler chooses the supported model, with APU automatic selection defaulting to model 3 Lite. No community INT8 override is needed for the official RDNA2/APU support. The optional community preset uses its own bundled DLL and is selected explicitly.

To use the community path on Steam Deck, select **FSR 4.1.1b — Steam Deck** in **Settings → Basic**. The choice is unchanged from earlier plugin versions and is never forced during an upgrade. To return to the official path, use **Installed Files & FSR 4 → Restore bundled upscaler**, then select **FSR 3.X/4** in Basic. Frame-generation settings remain user-controlled. **Restore previous install** restores the full previous snapshot; **Remove** restores the earliest original game files and recorded launch options.

The [matching live bridge](live-control.md) can apply supported per-frame settings, backends and available FFX-version changes after a confirmed game response. Model/provider selection, INT8 and loader changes still require restarting the game. Check the watermark for `FSR4`, `FSR4-i8`, `FSR4-i8-2` or `FSR4L-i8`; `FSR3` means the game fell back instead of using FSR4. The existing Steam Deck evidence comes from the earlier pre5 build, not this final package.
