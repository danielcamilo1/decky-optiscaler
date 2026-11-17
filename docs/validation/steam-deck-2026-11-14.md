# PBZ Steam Deck validation — 2026-11-14

Package `0.0.8-pbz.2` uses the pinned OptiScaler `0.9.5-pre5` core and community FSR `4.1.1b`, INT8 model `1`, with OptiScaler FG disabled. This is one-device validation, without a measured image-quality, FPS-improvement or long-session stability claim.

## Environment and deployment

Steam Deck OLED 1 TB, SteamOS 3.9.5, Decky Loader 3.3.1, Proton Experimental and Mesa 26.1.2. These were inspected, not upgraded. The same named plugin was replaced through Decky's normal install API; LSFG-VK and other plugins were preserved. Other games' installed files were not upgraded during that gameplay/recovery run.

The game target is the main `PBZ.exe` directory at `PBZ/platform/steam`. The original plugin/settings, current Steam launch value, relevant game configuration and original game-file hashes are backed up privately. The plugin does not edit external game graphics settings or save progress.

## Automated checks

- The final native Windows executable ran under the device's Proton: **313 passed, 0 failed**. It exercises ABI reads/writes, all 14 live fields, menu side effects, capability/identity changes, mailbox timeout, FG active/paused observations and a hard-linked status temporary file.
- Python protocol and actual Decky RPC tests exercise matching receipt identity and exact accepted keys, interrupted saves, directory authorization and no-overwrite behavior.
- The isolated Linux backend suite covers recovery, FSR lifecycle and backend selftests. Corrected test fixtures and final changes receive focused reruns rather than repeating unaffected tests.
- All six React harnesses, TypeScript and Rollup pass. Generated schema/layout, native source/binary identity, payload hashes and final-ZIP offline install/experiment/reapply/stock restore/rollback/Remove are checked.

Synthetic tests are separate from actual game observations. They do not prove GPU effect for every option or hardware/API combination.

## Follow-up: automatic runtime upgrades

Package `0.0.8-pbz.3` removes the dedicated experiment UI and adds runtime upgrades when an old managed game page is opened. Recognized 0.9.4 proxy hashes are upgraded through the existing transaction, with an immutable restore point first. INI comments and values, the proxy filename, optional components, per-game preferences and launch options are preserved. Legacy boolean INT8 values migrate to the current model number.

Regression checks cover legacy manifests, conflicting game/snapshot identities, interrupted binary upgrades, a game starting during preflight, explicit rollback holds, Remove, cross-thread INI saves, and explicit nofg choices without a private experiment preference. A dedicated seventh UI harness covers post-upgrade editing, running/deferred states, held versions, retry on reopening, and leaving the page during a Steam launch-options read.

After the device reconnected, `pbz.3` was installed through Decky's normal same-name replacement, with one plugin instance. Opening an existing managed 0.9.4 game page automatically upgraded its verified core to pre5, created the restore point, and immediately unlocked settings. Steam launch options were unchanged; the only INI value change was the expected INT8 `true` → `1` migration.

The real **Restore previous install** UI restored all **48 snapshot records**, including content, modes and absence, and the captured launch options. Reopening the game page retained 0.9.4 and showed the explicit rollback hold. The test hold was then cleared through the plugin preference API, and reopening restored the upgraded installation without replacing the snapshot. The final game configuration and preferences were preserved, except for the intended INT8 migration. Other managed game files matched their recorded hashes and modes; PBZ retained its FSR 4.1.1b INT8/nofg configuration. Actual PBZ Setup showed the wiki path/100% requirements without the former personal experiment action, and Basic omitted the FG hint while FG was off.

The physical gameplay and PBZ full-Remove evidence below is from `pbz.2`; the core and native bridge are unchanged in `pbz.3`. The additional game's gameplay/FG GPU behavior was not tested during this upgrade/recovery check.

## Real-game live control

The game reached its main menu and continued into gameplay. The native module reported schema 7, the pinned core identity, verified physical game directory and a ready DX12 callback. The bridge identified the `fsr31` backend and exposed the available `4.1.1b`, `3.1.5` and `2.3.4` FFX list.

Real RPC requests for Show FPS, sharpness override/value and FFX index 0 returned matching `config_request_accepted` receipts. A backend request to `fsr21` was followed by an independent runtime observation of `fsr21`; switching back was followed by `fsr31`. Rendering continued. Test settings were restored afterwards.

A follow-up check temporarily enabled the FSR watermark and entered an actual gameplay scene. The rendered frame displayed **`FSR4-I8 UPSCALE 4.1.1B`**, directly identifying the running INT8 upscaler. The game was then closed and the watermark setting restored to its original `auto`; all configuration values matched the pre-check values. Raw screenshots remain private.

The receipt confirms OptiScaler accepted the configuration request, not that a new backend or FG output has already reached the GPU. Runtime backend, FG state and telemetry are separate observations; actual FFX index remains unknown. PBZ's configured `nofg` path intentionally exposes no OptiScaler FG controls, so FG GPU behavior was not exercised on this game. The complete field scope is covered by native and RPC tests instead of enabling FG alongside the user's LSFG setup.

Earlier user gameplay in Gaming Mode loaded the pinned community DLL and INT8 hooks and created FFX contexts. The user completed gameplay and exited before recovery testing. Startup diagnostics and a loaded provider list alone are not treated as proof of every per-frame path.

## Physical recovery and final configuration

With the game closed, real plugin RPCs performed snapshot rollback, full Remove and reinstallation. Rollback matched all **38 snapshot records**, including bytes, modes and absent paths. Remove restored the **three original game files** (499,345,640 bytes) with exact SHA-256 and modes. Plugin control files, module, manifest and snapshot were absent afterwards. The game's own `D3D12` directory remained; it is distinct from plugin-owned `D3D12_Optiscaler`.

The plugin then recreated the experiment and a fresh restore point. Current user settings were restored through the configuration API. Final configuration is FSR `4.1.1b`, INT8 `1`, backend `fsr31`, FG `Enabled=false` and `FGInput=FGOutput=nofg`. Existing Steam launch options and LSFG configuration remain in use. Saves are not rolled back.

The PR remains a draft in the user's fork. Official 0.9.5 must be repinned and revalidated before considering an upstream submission or merge.

Raw logs, screenshots, addresses, credentials, exact launch strings and profile/save backups are deliberately excluded from this record.
