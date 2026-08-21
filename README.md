# Decky OptiScaler

[![Build](https://github.com/danielcamilo1/decky-optiscaler/actions/workflows/build.yml/badge.svg)](https://github.com/danielcamilo1/decky-optiscaler/actions/workflows/build.yml)
[![Latest release](https://img.shields.io/github/v/release/danielcamilo1/decky-optiscaler)](https://github.com/danielcamilo1/decky-optiscaler/releases/latest)
[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/danielcamilo)

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin that installs and
configures [OptiScaler](https://github.com/optiscaler/OptiScaler) per game from Game Mode
(SteamOS, Bazzite, whatever you run). Frame generation, upscaler overrides and the rest of
OptiScaler's settings, with a gamepad. The ones OptiScaler can change on the fly apply while the
game is running, so you don't have to restart it every time you want to try something; the rest
say plainly that they take effect on the next launch.

OptiScaler v0.9.4 is bundled, so installing works offline and every game gets the same build.

> **Unofficial.** I am an independent developer with no connection to the OptiScaler project.
> This plugin is not made, endorsed or supported by them — it bundles their release and drives
> it from the Steam Deck UI. Please report problems with the plugin
> [here](https://github.com/danielcamilo1/decky-optiscaler/issues), not to the OptiScaler
> maintainers.

## What it does

- **Finds your games and the folder to install into.** Steam libraries come from
  `libraryfolders.vdf`, including the SD card, and you can add any folder as a custom library.
  OptiScaler has to sit next to the executable that creates the D3D device, so the plugin scores
  the candidates (Unreal's `Binaries/Win64`, launchers like Cyberpunk's `bin/x64`) and lets you
  override its pick.
- **Sets the game up from the wiki.** Your game is matched against the OptiScaler
  [Compatibility List](https://github.com/optiscaler/OptiScaler/wiki/Compatibility-List), with a
  search box to pin the right entry when the name doesn't match. Setup is then a checklist:
  install the DLL under the filename the entry names, write the launch options, apply the
  settings it lists. Every line says which wiki field it came from before anything is written,
  and anything the plugin couldn't place is shown to you instead of guessed at.
- **Basic or Advanced settings.** Basic is a handful of controls (frame generation on/off, which
  generator runs it, 2X/3X/4X, which upscaler to force), each driving several INI keys at once.
  Advanced gives you all 288 settings across 34 sections. Controls and help text are generated
  from the comments in `OptiScaler.ini`, so they match the shipped build, and edits keep every
  comment in the file. Names are the overlay's own, so `fsr31` shows up as "FSR 3.1 / FSR 4".
- **Changes settings while you play.** A bundled ASI plugin applies frame generation, FidelityFX
  FG version, the upscaler and the FSR version immediately from the Quick Access panel — next to
  what the game actually ended up running and, with frame generation on, both frame rates: what
  the game renders and what reaches the screen. See
  [Live in-game control](#live-in-game-control).
- **Doesn't lose your files.** Anything an install would overwrite is moved into
  `decky_optiscaler_backup_files/` and put back when you uninstall.
- **Odds and ends.** `OptiScaler.log` is parsed for the backend that actually got created, the
  GPU and the Proton version. [OptiPatcher](https://github.com/optiscaler/OptiPatcher) is bundled
  for the games that need it. An **OptiScaler Settings** entry is added to the game's context
  menu in the Steam library.

## Screenshots

<img src="assets/quick-access-live-tiles.jpg" alt="The Quick Access panel over a running game, showing base and frame-generated frame rates side by side, frame generation on, and FSR 4.1.1 as the upscaler" />

Over the running game: what it renders, what reaches the screen, and the exact
FSR version it ended up with — above the controls that change them.

| | |
|---|---|
| <img src="assets/library-context-menu.jpg" alt="The Steam library context menu with an OptiScaler Settings entry" /> | <img src="assets/setup-checklist.jpg" alt="The setup checklist for a game matched on the OptiScaler wiki" /> |
| **OptiScaler Settings** in the game's library context menu. | Setup is a checklist, and it says what it will write before it writes it. |
| <img src="assets/quick-access-frame-generation.jpg" alt="The Quick Access panel showing the frame generation toggle, the in-game state and the frame rate" /> | <img src="assets/quick-access-upscaler.jpg" alt="The Quick Access panel showing the upscaler override and the FG method the wiki recommends" /> |
| Frame generation, the FidelityFX FG version and the live frame rate, over the running game. | The upscaler applies live too; what doesn't is under **Needs a restart**, with the wiki's recommendation under it. |

## Installing

Grab `Decky-OptiScaler-v*.zip` from the
[latest release](https://github.com/danielcamilo1/decky-optiscaler/releases/latest), then either:

- In Game Mode, open Decky's settings, turn on **Developer mode**, and use
  **Install Plugin from URL** with the zip's download link; or
- unpack the zip into `~/homebrew/plugins/` and restart Decky Loader.

Every release bundles OptiScaler itself, so there is nothing else to download.
See the [changelog](CHANGELOG.md) for what changed.

## Live in-game control

OptiScaler reads its INI once, at startup. There's no file watcher and no IPC, and its overlay
gets away with live changes only because it *is* the game process. So the plugin ships a small
ASI plugin that OptiScaler loads into the game and that makes the same writes the overlay makes,
which is what lets the Quick Access panel change these three things mid-game:

- **Frame generation** — flips `Config::FGEnabled`, which is read every frame.
- **Upscaler** — writes the backend id into `State::newBackend` and marks every entry of
  `State::changeBackend`. That's the overlay's "Change Upscaler" button in full.
- **FidelityFX FG version** — writes `Config::FfxFGIndex`, then sets `State::FGchanged` and
  `State::SCchanged` so the generator's context gets destroyed and rebuilt on the new index. The
  versions you pick from are the ones the SDK reported to *that* game, read back out of `State`.
- **FSR version** — writes `Config::FfxUpscalerIndex` and asks for the same feature rebuild the
  upscaler switch uses, which is what the overlay's "Change Upscaler" under FFX Settings does.
  One backend id covers every FSR from 2.3.4 to 4.1.1, so the exact version comes from the list
  the running game reported — the same list its overlay names in the title bar.

It also reads out both frame rates. Frame generation gives a game two of them, and OptiScaler
times both sides; the panel shows what the game renders next to what reaches the screen, and says
when the generator is switched on but not actually inserting frames.

## Steam launch options

Proton loads its own `dxgi.dll` unless you tell it not to, so the proxy needs an override:

```
WINEDLLOVERRIDES="dxgi=n,b" %command%
```

Setup shows the exact string for the filename you picked and can write it into the game's launch
options for you. `OptiScaler.asi` installs don't need it.

## Requirements

- Decky Loader
- One of `7z`, `7zz`, `7za`, `7zr` or `bsdtar` to unpack the bundled release. SteamOS has both
  p7zip and bsdtar. It runs once, on first install.

## Building

```sh
pnpm install
python3 scripts/generate_schema.py   # option metadata, from the reference INI
./asi/build.sh                       # live-control ASI -> bin/ (needs zig)
pnpm build
python3 scripts/package.py           # -> out/Decky OptiScaler.zip
```

`asi/build.sh` cross-compiles a Windows x64 DLL with `zig cc`, so you don't need MSVC or a
Windows machine; `brew install zig` is the only prerequisite. Packaging without the ASI works
fine, live control just reports itself as unavailable.

Tests:

```sh
python3 scripts/selftest.py                          # backend, against a synthetic library
HARNESS=run.tsx node testharness/build-and-run.mjs    # renders the UI headlessly
HARNESS=all-options.tsx node testharness/build-and-run.mjs
```

## Support

This plugin is free and open source, and it will stay that way. If it got a game running better
on your Deck and you feel like saying thanks, you can buy me a coffee — it is genuinely
appreciated and it keeps the updates coming ☕

[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/danielcamilo)

## Credits

This is an unofficial, independently developed plugin. It is not affiliated with, endorsed by or
supported by the OptiScaler project or any of the projects below; all it does is package and
drive their work.

- [OptiScaler](https://github.com/optiscaler/OptiScaler) and its wiki contributors.
- [Decky Framegen](https://github.com/xXJSONDeruloXx/Decky-Framegen) — reference for how
  OptiScaler is deployed into a game folder on Linux.
- [Decky LSFG-VK](https://github.com/xXJSONDeruloXx/decky-lsfg-vk) — reference for the
  configuration-driven plugin UI.

## AI disclosure

This plugin was built with heavy use of AI: Claude Opus 5 was the model mainly used for its development. Every design decision, review and manual testing runs were mine, and everything here has been run on an Xbox Ally X running Bazzite.
