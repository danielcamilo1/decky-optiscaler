# Decky OptiScaler

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for installing, configuring and monitoring OptiScaler per game from Steam Deck Game Mode. It manages per-game files, configuration, launch options and restoration, with setup guidance for Phantom Blade Zero and other games. It is independent of the OptiScaler project.

This package contains:

- The complete official **OptiScaler 0.9.5** release package, including FFX SDK 2.4 and FSR 4.1.2.
- The experimental **FSR 4.1.2 Lite — community** preset for Steam Deck and recognized RDNA2 APUs, with its upstream notice bundled.
- PBZ wiki requirements for the main `PBZ/platform/steam/PBZ.exe`, including 100% output scale.
- A native live-control bridge calibrated to this core and its PDB, retaining all 14 live controls with per-game capabilities and confirmed command results.
- Original-file backups, an immutable upgrade restore point, precise launch-options merging, rollback, and Remove.

## Guides

Each topic has one authoritative guide:

- **[FSR 4.1.2 on Steam Deck](docs/steam-deck-fsr4.md)** — official **Settings (Basic mode) → Upscaler → Override upscaler with → FSR 3.X/4**, experimental **FSR 4.1.2 Lite — community**, legacy **4.1.1b**, watermark verification, and **Setup → Manual setup → Installed Files & FSR 4** restore/fallback paths.
- **[Native live control and recovery](docs/live-control.md)** — adding/upgrading the bridge in **Setup → Manual setup → Live in-game control**, live connection/result semantics, automatic upgrades, **Restore previous install**, and **Remove**.
- **[Phantom Blade Zero setup](docs/phantom-blade-zero.md)** — PBZ executable folder (`PBZ/platform/steam`), 100% output scale, wiki identity rules, and pinned sources.

Global plugin preferences (including automatic Simplified Chinese `zh-CN` / English language detection and manual override) and compatibility-list controls live under the main page's **Plugin Settings** tab (distinct from each game's **Settings** tab).

## Install and recover

Install the generated zip through Decky Developer mode's **Install Plugin from URL**, or unpack its single `Decky OptiScaler/` directory into `~/homebrew/plugins/` and restart Decky Loader. Then open the game's page. Recognized managed 0.9.4 and 0.9.5-pre5 installations update automatically when opened with the game closed; fresh or unknown installations use **Setup**.

Close the game before installation, upgrade, binary changes, rollback or removal. See the [live-control and recovery guide](docs/live-control.md#restore-and-remove) for the full restore-point, rollback-hold, and **Remove** contract.

## Compatibility-list updates

The game compatibility list tries the official GitHub Wiki first. If it fails or returns an invalid list, the plugin automatically tries [github.chenc.dev](https://github.chenc.dev/) and then [xsadwsd.kdns.fr](https://xsadwsd.kdns.fr/), using HTTPS certificate verification and rejecting insecure redirects for these third-party proxies. Each source uses a three-second socket timeout with the existing IPv4 retry. Their availability and freshness depend on the service and your network.

A response must be raw Markdown with a nonempty compatibility table before it replaces the cache. If every source fails, the last cached or bundled list stays available. These mirrors apply only to game-list refreshes; they do not proxy game detail pages or component downloads.

## Build and validate

Requires Node 22, pnpm 10, Python 3.11+ and a BCJ2-capable `7z`, `7zz`, `7za`, `7zr` or `bsdtar` (SteamOS includes supported extractors).

```sh
pnpm install --frozen-lockfile
python3 scripts/generate_schema.py
git diff --exit-code -- src/config/generatedSchema.ts py_modules/optiscaler/schema_generated.py
python3 scripts/generate_asi_layout.py
git diff --exit-code -- asi/generated
python3 scripts/live_metadata.py --check
python3 scripts/verify_runtime_profile.py
pnpm exec tsc --noEmit
pnpm exec tsc -p tsconfig.test.json --noEmit
pnpm build
python3 scripts/test_units.py
python3 scripts/test_fsr4.py
python3 scripts/test_recovery.py
python3 scripts/test_live.py
python3 scripts/test_live_rpc.py
python3 scripts/selftest.py
HARNESS=run.tsx node testharness/build-and-run.mjs
HARNESS=all-options.tsx node testharness/build-and-run.mjs
HARNESS=live-fields.tsx node testharness/build-and-run.mjs
HARNESS=use-config.tsx node testharness/build-and-run.mjs
HARNESS=launch-options.tsx node testharness/build-and-run.mjs
HARNESS=recovery-ui.tsx node testharness/build-and-run.mjs
HARNESS=auto-upgrade.tsx node testharness/build-and-run.mjs
HARNESS=ui-flows.tsx node testharness/build-and-run.mjs
HARNESS=i18n.tsx node testharness/build-and-run.mjs
python3 scripts/package.py
python3 scripts/verify_package.py 'out/Decky OptiScaler.zip'
```

The native bridge uses the final 0.9.5 source references and PDB-backed profile. Rebuilding requires **Zig 0.15.2**: run `bash asi/build.sh` before packaging, then `python3 scripts/live_metadata.py --check`. Windows CI compiles and runs native behavior tests and checks that rebuilding reproduces the shipped binary metadata. Do not copy a bridge from another OptiScaler build into a game.

## Credits

- Decky OptiScaler authors and contributors.
- [OptiScaler](https://github.com/optiscaler/OptiScaler) and its wiki contributors.
- [fsr4-shader-performance-overrides](https://github.com/zgauthier2000/fsr4-shader-performance-overrides) community Lite build.
- [fsr4xyz](https://github.com/the3rdparty1917/fsr4xyz) legacy 4.1.1b RDNA2 build.
- [Decky Framegen](https://github.com/xXJSONDeruloXx/Decky-Framegen) and [Decky LSFG-VK](https://github.com/xXJSONDeruloXx/decky-lsfg-vk) for the upstream deployment/UI references.

These changes were developed with Codex. Automated synthetic validation is reported separately from physical device testing.
