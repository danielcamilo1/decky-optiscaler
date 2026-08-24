"""Shared constants for the Decky OptiScaler plugin."""

OPTISCALER_VERSION = "0.9.4"
PAYLOAD_ARCHIVE = "OptiScaler-0.9.4.7z"
PAYLOAD_SHA256 = "575cb4df866116093df75af607e37fd70e10f5163e0f23fd5c804142e80ef0ad"

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
# IS bundled in the OptiScaler release — 4.1.1 in v0.9.4. amdxcffx64.dll is the
# alternative, driver-provided FSR4 source; OptiScaler only falls back to it when
# the SDK does not supply the effect. It is optional, not required.
FSR4_SUPPORT_FILES = ["amdxcffx64.dll", "amdxc64.dll"]

# The FidelityFX SDK dll that actually carries FSR4, and the minimum version
# that reports INT8 model support (see FSR4Upgrade.cpp).
FFX_UPSCALER_DLL = "amd_fidelityfx_upscaler_dx12.dll"
FSR4_MIN_SDK_VERSION = (4, 1, 1, 0)

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
