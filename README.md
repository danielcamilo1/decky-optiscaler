# Decky OptiScaler — Phantom Blade Zero

A fork of [Decky OptiScaler](https://github.com/danielcamilo1/decky-optiscaler) for **Phantom Blade Zero + FSR 4 on Steam Deck**. It manages per-game files, configuration, launch options and restoration from Decky Loader. It is independent of the OptiScaler project.

This package contains:

- The complete official **OptiScaler 0.9.5** release package, including FFX SDK 2.4 and FSR 4.1.2.
- A verified community **FSR 4.1.1b INT8 RDNA2** archive as an explicit optional preset in Basic settings.
- PBZ wiki requirements for the main `PBZ/platform/steam/PBZ.exe`, including 100% output scale.
- A native live-control bridge calibrated to this core and its PDB, retaining all 14 live controls with per-game capabilities and confirmed command results.
- Original-file backups, an immutable upgrade restore point, precise launch-options merging, rollback, and Remove.

Live control requires the matching core and bridge installed into each game. Saving an INI is separate from submitting a live configuration request; actual runtime state is reported separately, and model/provider and other startup settings still require a restart. Opening a recognized managed 0.9.4 or 0.9.5-pre5 game automatically upgrades it when the game is closed, preserving the INI, components and launch options with a restore snapshot. An existing community preset stays selected until the user changes it. Unknown or explicitly restored runtimes remain read-only until reviewed in Setup. See the [live-control guide](docs/live-control.md) for connection and recovery states. Confirm the active FSR4 model in game using the watermark.

See [PBZ setup, verification and complete recovery](docs/phantom-blade-zero.md). The official upscaler is available from **Settings → Basic → FSR 3.X/4**. To use the bundled community RDNA2 preset, select **FSR 4.1.1b — Steam Deck**; an upgrade does not force this preset or switch an existing community selection. Frame generation remains user-controlled. The [FSR 4 guide](docs/steam-deck-fsr4.md) explains the official/community choices.

## Install and recover

Install the generated zip through Decky Developer mode's **Install Plugin from URL**, or unpack its single `Decky OptiScaler/` directory into `~/homebrew/plugins/` and restart Decky Loader. Then open the game's page. Recognized managed 0.9.4 and 0.9.5-pre5 installations update automatically; fresh or unknown installations use Setup.

Close the game before installation, upgrade, binary changes, rollback or removal. Existing managed installs receive an immutable restore point before an upgrade. If a restore point already exists, it is reused: rollback returns to its recorded version and configuration, which can predate the immediately previous upgrade. A running game is deferred until it closes. **Restore previous install** restores that state, including the captured launch options and related per-game preferences; automatic upgrading stays paused for that restored install until the bundled core changes or you upgrade manually. **Remove** restores the earliest original game files and offers the original launch options. Use the restore choice for full removal. Failed Steam writes remain visible and retryable. Originals lost before this build cannot be recreated.

## Build and validate

Requires Node 22, pnpm 10, Python 3.11+ and a BCJ2-capable `7z`, `7zz`, `7za`, `7zr` or `bsdtar` (SteamOS includes supported extractors).

```sh
pnpm install --frozen-lockfile
python3 scripts/generate_schema.py
pnpm exec tsc --noEmit
pnpm build
python3 scripts/selftest.py
python3 scripts/test_fsr4.py
python3 scripts/test_recovery.py
python3 scripts/test_live.py
python3 scripts/test_live_rpc.py
python3 scripts/live_metadata.py --check
python3 scripts/verify_runtime_profile.py
HARNESS=run.tsx node testharness/build-and-run.mjs
HARNESS=all-options.tsx node testharness/build-and-run.mjs
HARNESS=live-fields.tsx node testharness/build-and-run.mjs
HARNESS=use-config.tsx node testharness/build-and-run.mjs
HARNESS=launch-options.tsx node testharness/build-and-run.mjs
HARNESS=recovery-ui.tsx node testharness/build-and-run.mjs
HARNESS=auto-upgrade.tsx node testharness/build-and-run.mjs
python3 scripts/package.py
python3 scripts/verify_package.py 'out/Decky OptiScaler.zip'
```

The native bridge uses the final 0.9.5 source references and PDB-backed profile. Rebuilding requires **Zig 0.15.2**: run `bash asi/build.sh` before packaging, then `python3 scripts/live_metadata.py --check`. Windows CI compiles and runs native behavior tests and checks that rebuilding reproduces the shipped binary metadata. Do not copy a bridge from another OptiScaler build into a game.

## Credits

- [Original Decky plugin](https://github.com/danielcamilo1/decky-optiscaler) by its original authors.
- [OptiScaler](https://github.com/optiscaler/OptiScaler) and its wiki contributors.
- [fsr4xyz](https://github.com/the3rdparty1917/fsr4xyz) community RDNA2 fix.
- [Decky Framegen](https://github.com/xXJSONDeruloXx/Decky-Framegen) and [Decky LSFG-VK](https://github.com/xXJSONDeruloXx/decky-lsfg-vk) for the upstream deployment/UI references.

This fork's changes were developed with Codex. Automated synthetic validation is reported separately from physical device testing.
