"""Shared constants for the Decky OptiScaler plugin."""

OPTISCALER_VERSION = "0.9.5"
PAYLOAD_ARCHIVE = "Optiscaler_0.9.5-final.20261116.7z"
PAYLOAD_SHA256 = "77e3ed76bed04e1fb32bacb5a72799ff172f3da22ed5231c0cf3e84fe6761662"

INI_NAME = "OptiScaler.ini"
LOG_NAME = "OptiScaler.log"
# Written by this plugin so an install can be recognised later with certainty.
MANIFEST_NAME = ".decky-optiscaler.json"
# Anything OptiScaler would overwrite is moved here instead, and moved back on
# uninstall. Kept as a visible folder so it is obvious what happened.
BACKUP_DIR = "decky_optiscaler_backup_files"
# The same idea for the one thing that is not a file in this folder: the Steam
# launch options the game had before OptiScaler went in. Only the frontend can
# read them out of Steam, so they are handed here and written verbatim, and
# removing OptiScaler can then offer to put them back.
LAUNCH_RECORD_NAME = "decky_optiscaler_previous_launch_options.txt"

# OptiPatcher (https://github.com/optiscaler/OptiPatcher) is a separate ASI from
# the OptiScaler project. It patches supported games so their DLSS/DLSS-FG
# inputs are exposed without DXGI spoofing, which some games - Red Dead
# Redemption 2, for one - need before OptiScaler can do anything useful. It is
# shipped as a rolling release, so this records the build bundled here.
OPTIPATCHER_NAME = "OptiPatcher.asi"
OPTIPATCHER_ARCHIVE = "OptiPatcher.asi"
OPTIPATCHER_SHA256 = "1324e6d131410fd43b721d684e7fd950c4f33c4c31a1db475f3d134a0ef3faeb"
OPTIPATCHER_VERSION = "rolling (2026-08-18)"

# REFramework (https://github.com/praydog/REFramework) is a separate mod, not
# part of OptiScaler. A handful of RE Engine games — the Resident Evil titles,
# Devil May Cry 5, Monster Hunter Wilds, PRAGMATA — cannot host OptiScaler at
# all without it, because REF is what exposes the upscaler hooks OptiScaler
# attaches to. The compatibility list says so in prose ("Requires REFramework"),
# and until this the plugin read straight past it: the install succeeded, the
# launch options were set, and the game rendered exactly as it had before.
#
# Both builds ship the same single file, which is the whole reason installing it
# from here is safe to do automatically.
#
# **Automatic installation is withdrawn** as of 0.0.5.3-testing. Downloading a
# third-party engine hook and placing it in somebody's game folder on their
# behalf is a bigger promise than the rest of this plugin makes, and the two
# prereleases that did it turned up more ways for that to go wrong than it was
# worth. Nothing is deleted: detection, classification, the launch-options
# override, the status read and the removal path all stay exactly as they were
# and are still covered by the selftest, because the requirement is real and
# saying so is the useful half. What the flag switches off is the download —
# the plugin states what the game needs and where to get it, and the file is
# the user's to place. Setting this back to True restores the whole feature.
REFRAMEWORK_AUTO_INSTALL = False
# What the plan says instead, in the sentence the checklist builds around it.
REFRAMEWORK_WITHHELD = (
    "this plugin no longer downloads it for you"
)
REFRAMEWORK_DLL = "dinput8.dll"
REFRAMEWORK_REVISION = "reframework_revision.txt"
# What may be taken out of an REFramework archive at all: this writes into a
# folder full of somebody's game, and "extract the zip" is not a thing to do on
# trust.
REFRAMEWORK_FILES = [REFRAMEWORK_DLL, REFRAMEWORK_REVISION]
# ...but only the DLL is placed next to the executable. The nightly's own
# release notes are blunt about it — "do NOT extract any file other than
# dinput8.dll into your game folder, or your game may become unstable" — so the
# revision stamp stays in the download cache and is recorded in our manifest
# instead, which is where we wanted to read it from anyway.
REFRAMEWORK_INSTALL_FILES = [REFRAMEWORK_DLL]

# praydog's own nightly, which is now one unified build covering every game it
# supports — hence a single asset rather than the per-game ones the wiki text
# still describes.
REFRAMEWORK_NIGHTLY_URL = (
    "https://github.com/praydog/REFramework-nightly/releases/latest/download/REFramework.zip"
)
REFRAMEWORK_NIGHTLY_PAGE = "https://github.com/praydog/REFramework-nightly/releases/latest"

# The pd-upscaler branch, which the Resident Evil entries and DMC5 ask for by
# name. It is built per game, and PDPerfPlugin does not support the unified
# nightly above, so the two are genuinely different downloads rather than one
# being a newer version of the other. The official repo's artifact links expire,
# which is why the wiki points at this mirror.
REFRAMEWORK_PD_RELEASES = "https://api.github.com/repos/TheRazerMD/REFramework/releases"
REFRAMEWORK_PD_PAGE = "https://github.com/TheRazerMD/REFramework/releases"

# Which per-game asset each compatibility-list entry needs, by the entry's
# normalised key. Curated rather than guessed: the asset names are game codes
# ("RE2", "DMC5") that no amount of matching gets to from "Resident Evil 2
# (2019)", and installing the wrong game's REFramework build is a crash on
# launch. A game not in here reports that it could not be fetched and links the
# release page — it never falls back to a near-enough asset.
REFRAMEWORK_PD_ASSETS = {
    "devilmaycry5": "DMC5.zip",
    "dragonsdogmaii": "DD2.zip",
    "monsterhunterrise": "MHRISE.zip",
    "monsterhunterstories3twistedreflection": "MHSTORIES3.zip",
    "monsterhunterwilds": "MHWILDS.zip",
    "pragmata": "PRAGMATA.zip",
    "residentevil22019": "RE2.zip",
    "residentevil32020": "RE3.zip",
    "residentevil42023": "RE4.zip",
    "residentevil7biohazard": "RE7.zip",
    "residentevil8village": "RE8.zip",
    "residentevil9requiem": "RE9.zip",
}

# PureDark's UpscalerBasePlugin, which the pd-upscaler entries need alongside
# REFramework. It is on Nexus Mods behind a login, so it cannot be downloaded
# from here at all — the checklist names it, links it, and ticks when the file
# turns up next to the executable.
REFRAMEWORK_PD_PLUGIN = "PDPerfPlugin.dll"
REFRAMEWORK_PD_PLUGIN_NAME = "UpscalerBasePlugin 1.1.2"
REFRAMEWORK_PD_PLUGIN_URL = (
    "https://www.nexusmods.com/site/mods/502?tab=files&file_id=2293"
)

# The filenames OptiScaler may be installed under. Order matters: it is the
# order setup_linux.sh presents and the order we probe for existing installs.
PROXY_FILENAMES = [
    "dxgi.dll",
    "winmm.dll",
    "version.dll",
    "dbghelp.dll",
    "d3d12.dll",
    "wininet.dll",
    "winhttp.dll",
    "OptiScaler.asi",
]
DEFAULT_PROXY = "dxgi.dll"

# Support libraries copied next to the proxy dll.
PAYLOAD_FILES = [
    "amd_fidelityfx_dx12.dll",
    "amd_fidelityfx_framegeneration_dx12.dll",
    "amd_fidelityfx_upscaler_dx12.dll",
    "amd_fidelityfx_vk.dll",
    "amd_fidelityfx_upscaler_vk.dll",
    "amd_fidelityfx_framegeneration_vk.dll",
    "dlssg_to_fsr3_amd_is_better.dll",
    "fakenvapi.dll",
    "fakenvapi.ini",
    "libxell.dll",
    "libxess.dll",
    "libxess_dx11.dll",
    "libxess_fg.dll",
]
PAYLOAD_DIRS = ["D3D12_Optiscaler", "Licenses"]

# Extra files OptiScaler or its helpers create at runtime; removed on uninstall.
RUNTIME_ARTIFACTS = [
    "OptiScaler.log",
    "fakenvapi.log",
    "dlssg_to_fsr3.log",
    "nvngx.ini",
]

# Directories that never contain a game's shipping executable.
EXE_DIR_BLACKLIST = {
    "engine",
    "_commonredist",
    "commonredist",
    "directx",
    "dotnet",
    "vcredist",
    "redist",
    "installers",
    "support",
    "tools",
    "dxsetup",
}

# Launcher executables that are not the real render target.
EXE_NAME_BLACKLIST = {
    "unitycrashhandler64.exe",
    "unitycrashhandler32.exe",
    "crashreportclient.exe",
    "crashhandler.exe",
    "uninstall.exe",
    "vcredist_x64.exe",
    "vcredist_x86.exe",
    "dxsetup.exe",
    "eossdk-win64-shipping.exe",
    "epicwebhelper.exe",
    "activationui.exe",
    "touchup.exe",
    "notification_helper.exe",
}

# FSR4 comes from amd_fidelityfx_upscaler_dx12.dll (the FidelityFX SDK), which
# IS bundled in the OptiScaler release — 4.1.2 in v0.9.5. amdxcffx64.dll is the
# alternative, driver-provided FSR4 source; OptiScaler only falls back to it when
# the SDK does not supply the effect. It is optional, not required.
FSR4_SUPPORT_FILES = ["amdxcffx64.dll", "amdxc64.dll"]

# The FidelityFX SDK dll that actually carries FSR4. FSR 4 arrived with the
# 4.0.2 build (FFX SDK 2.0), so that is the floor for "this file is a FSR 4
# library at all"; the INT8 model specifically needs 4.1.1, which is what
# OptiScaler's own menu asks for before it will offer the FSR 3.X/4 entry off
# the back of Fsr4ForceEnableInt8 (menu_common.cpp).
FFX_UPSCALER_DLL = "amd_fidelityfx_upscaler_dx12.dll"
FSR4_MIN_SDK_VERSION = (4, 0, 2, 0)
FSR4_INT8_MIN_SDK_VERSION = (4, 1, 1, 0)

# Places a user is likely to already have those DLLs.
FSR4_SOURCE_HINTS = [
    "fgmod",
    "fgmod/fsr4-rdna2-3",
    "fgmod/fsr4-rdna4",
    "fgmod/fsr4-rdna3-4-official-411",
    "fgmod/fsr4-rdna2-valve-411-pre10",
    "Downloads",
    "decky-optiscaler",
]

# Community RDNA2 upscaler, pinned independently of the bundled runtime.
# Version resources are identical to stock 4.1.1; identify by SHA-256.
FSR4_BUILD_PRIMARY = "the3rdparty1917/fsr4xyz"
FSR4_BUILD_MIRROR = "Optiscaler-Client/OptiScaler-Extras"
FSR4_BUNDLED_BUILD_ID = "bundled"
#: The released SDK build, identified by hash like any other. Not downloadable:
#: it is already in bin/ and is what "reinstall" and "restore" put back.
FSR4_BUNDLED_FILE_SHA256 = (
    "aad4fccccb29084a655f9a4f9f613bd22c8c03fb4a0f8840148cc6543b4ccace"
)
FSR4_BUNDLED_FILE_BYTES = 57664272
FSR4_STEAM_DECK_BUILD_ID = "4.1.2-lite-exact-20261105"
FSR4_BUILDS = [
    {
        "id": FSR4_STEAM_DECK_BUILD_ID,
        "label": "4.1.2 Lite Exact (community, RDNA2 APU)",
        "note": "Experimental community Lite model; PE resource remains 4.1.1. "
                "Not a measured improvement over 4.1.1b on this device.",
        "sources": [{
            "repo": "zgauthier2000/fsr4-shader-performance-overrides",
            "tag": "dll-2026-11-05",
            "asset": "fsr4.1.2-igpu-cyboman-rdna2-2026-11-05.7z",
            "archive_sha256": "da7c7681bffe7ac60a01e859d5b107900d963557793ef67ddcfd03a832e1c03f",
        }],
        "archive_path": "4.1.2l-exact/amd_fidelityfx_upscaler_dx12.dll",
        "fsr4_update": "true",
        "file": "amd_fidelityfx_upscaler_dx12.dll",
        "file_sha256": "f991d06a8b800ed3e01b95696333c842c3de590aec7d2e6b2340c4e583d84ef4",
        "file_bytes": 39608832,
        "reaches_fsr4_by": "int8",
    },
    {
        "id": "4.1.1b",
        "label": "4.1.1b (INT8, RDNA 2 ghosting fix)",
        "note": "Community INT8 build with the RDNA2 ghosting fix.",
        "sources": [
            {
                "repo": FSR4_BUILD_PRIMARY,
                "tag": "4.1.1b",
                "asset": "FSR_4.1.1b_INT8_with_RDNA2_fix.7z",
                "archive_sha256": "66e9a818e0c914def7712c8dac06b08e64a64dbcfe77f3162d43ea6de93869ff",
            },
            {
                "repo": FSR4_BUILD_MIRROR,
                "tag": "FSR_4.1.1b",
                "asset": "FSR4_INT8_4.1.1b.7z",
                "archive_sha256": "ddedf6fd452904c4598719feac33f098644de7e1f0ed53c54274aedb0a586be1",
            },
        ],
        "file": "amd_fidelityfx_upscaler_dx12.dll",
        "file_sha256": "0dd77d9c78d1ef9bc330cf4697ab3ffe24bc1aa7850e4130263dc922107fbd75",
        "file_bytes": 34013696,
        "reaches_fsr4_by": "int8",
    },

]


WIKI_RAW_BASE = "https://raw.githubusercontent.com/wiki/optiscaler/OptiScaler"
WIKI_HTML_BASE = "https://github.com/optiscaler/OptiScaler/wiki"
COMPAT_LIST_PAGE = "Compatibility-List.md"
COMPAT_CACHE_TTL = 24 * 60 * 60  # seconds

STEAM_ROOTS = [
    ".steam/steam",
    ".local/share/Steam",
    ".steam/root",
    ".var/app/com.valvesoftware.Steam/data/Steam",
]

# Live control is built for one reviewed OptiScaler ABI. This flag describes
# the code shipped by the plugin; whether one game can use it is determined
# from that game's manifest, runtime, installed ASI and matching live heartbeat.
LIVE_CONTROL_SUPPORTED = True
LIVE_CONTROL_REASON = None
LIVE_SCHEMA = 7
LIVE_BUILD_ID = "decky-live-095-v1"
LIVE_PROFILE_ID = "optiscaler-0.9.5-90d9568"
LIVE_SOURCE_COMMIT = "90d9568d576d93ebb2d6c1c207596d21e9900651"
LIVE_CORE_SHA256 = "e2300905b2b7e6e14c8c4b02c0c555c4582fafc92a2e36e117ce027b7e259d59"
LIVE_PROFILE_FILE = "live-profile.json"
LIVE_BUILD_FILE = "live-build.json"
LIVE_OPTISCALER_VERSION = "0.9.5"
LEGACY_LIVE_ASI_SHA256 = "ca4db054e42864a4bf754a18dc6288e7b9be888e24d119916ddedaef3c5de207"
UPGRADE_LIVE_ASI_SHA256 = (
    "a70d492e677cd366cfbb774f249102a0f1d2e100a0079be10ff2f3ed985dcc13",
    "58ed07a85bd6dc23bb48082015ccbf27c53b7339d39e406e36335d1215ac9ec5",
)
RUNTIME_DLL_SHA256 = LIVE_CORE_SHA256
# Core from the former pinned 0.9.4 support archive (SHA-256 575cb4df…ef0ad).
UPGRADE_RUNTIME_HASHES = {
    "0.9.4": "fbfb6676b829dad7e020fb830586a16aa0ec6add78016db48ef12e2ae1803231",
    "0.9.5-pre5": "bd6fe5e7defdf7520ecd7a45eb3b5fe173d70551af5ad4a21b2837dd5d2e8a28",
}
