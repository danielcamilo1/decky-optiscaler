"""GPU identification, used to explain what FSR4 can and cannot do on this device.

FSR 4.1.2 includes INT8 models for RDNA2 and selected AMD APUs. GPU generation
alone does not establish driver, SDK or model compatibility on Proton. Keep
RDNA2 classified as experimental until the active in-game model is confirmed.
"""

import os
import re
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

DRM_ROOT = Path("/sys/class/drm")
KFD_NODES = Path("/sys/class/kfd/kfd/topology/nodes")
MIN_REFRESH_HZ = 24
MAX_REFRESH_HZ = 360

# PCI device id -> generation. Covers the APUs found in Linux handhelds plus the
# common discrete families.
PCI_GENERATIONS = {
    "0x163f": ("RDNA2", "Van Gogh (Steam Deck)"),
    "0x1435": ("RDNA2", "Rembrandt"),
    "0x1681": ("RDNA2", "Rembrandt (680M)"),
    "0x15bf": ("RDNA3", "Phoenix (780M / Z1 Extreme)"),
    "0x15c8": ("RDNA3", "Phoenix 2 (Z1)"),
    "0x1586": ("RDNA3.5", "Strix Point (890M)"),
    "0x150e": ("RDNA3.5", "Krackan (Z2)"),
}

GFX_GENERATIONS = {
    "gfx1030": "RDNA2", "gfx1031": "RDNA2", "gfx1032": "RDNA2",
    "gfx1033": "RDNA2", "gfx1034": "RDNA2", "gfx1035": "RDNA2",
    "gfx1036": "RDNA2",
    "gfx1100": "RDNA3", "gfx1101": "RDNA3", "gfx1102": "RDNA3",
    "gfx1103": "RDNA3",
    "gfx1150": "RDNA3.5", "gfx1151": "RDNA3.5", "gfx1152": "RDNA3.5",
    "gfx1200": "RDNA4", "gfx1201": "RDNA4",
}

MARKETING_GENERATIONS = [
    (re.compile(r"\bRX\s*9\d{3}\b", re.I), "RDNA4"),
    (re.compile(r"\bRX\s*7\d{3}\b", re.I), "RDNA3"),
    (re.compile(r"\bRX\s*6\d{3}\b", re.I), "RDNA2"),
    (re.compile(r"van\s*gogh|steam\s*deck|jupiter|galileo", re.I), "RDNA2"),
    (re.compile(r"\b(780M|760M|Z1)\b", re.I), "RDNA3"),
    (re.compile(r"\b(880M|890M|Z2)\b", re.I), "RDNA3.5"),
]

# What each generation can do with FSR4 through OptiScaler.
FSR4_SUPPORT = {
    "RDNA4": "native",
    "RDNA3": "int8",
    "RDNA3.5": "int8",
    "RDNA2": "experimental",
}


def _read(path):
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""


def _decode_gfx(value):
    """gfx_target_version 100303 -> 'gfx1033' (major/minor/step, 2 digits each)."""
    if not value.isdigit():
        return None
    number = int(value)
    major, minor, step = number // 10000, (number // 100) % 100, number % 100
    return f"gfx{major}{minor:x}{step:x}"


def _gfx_target():
    for properties in sorted(KFD_NODES.glob("*/properties")) if KFD_NODES.is_dir() else []:
        match = re.search(r"gfx_target_version\s+(\d+)", _read(properties))
        if match and match.group(1) != "0":
            decoded = _decode_gfx(match.group(1))
            if decoded:
                return decoded
    return None


def _pci_devices():
    devices = []
    if not DRM_ROOT.is_dir():
        return devices
    for card in sorted(DRM_ROOT.glob("card[0-9]*")):
        device = card / "device"
        vendor = _read(device / "vendor").lower()
        model = _read(device / "device").lower()
        if vendor:
            devices.append((vendor, model))
    return devices


def _names():
    found = []
    if DRM_ROOT.is_dir():
        for card in sorted(DRM_ROOT.glob("card[0-9]*")):
            product = _read(card / "device" / "product_name")
            if product:
                found.append(product)
    board = _read(Path("/sys/devices/virtual/dmi/id/product_name"))
    if board:
        found.append(board)
    return found


@lru_cache(maxsize=1)
def gpu_info():
    """Report GPU generation and what that means for FSR4."""
    names = _names()
    text = " ".join(names)
    devices = _pci_devices()

    generation = None
    codename = None
    vendor = None

    for pci_vendor, model in devices:
        if pci_vendor == "0x1002":
            vendor = "amd"
            if model in PCI_GENERATIONS:
                generation, codename = PCI_GENERATIONS[model]
                break
        elif pci_vendor == "0x10de" and vendor is None:
            vendor = "nvidia"
        elif pci_vendor == "0x8086" and vendor is None:
            vendor = "intel"

    if generation is None:
        gfx = _gfx_target()
        if gfx and gfx in GFX_GENERATIONS:
            generation = GFX_GENERATIONS[gfx]
    else:
        gfx = _gfx_target()

    if generation is None:
        for pattern, gen in MARKETING_GENERATIONS:
            if pattern.search(text):
                generation = gen
                break

    if vendor is None:
        if re.search(r"amd|radeon|van ?gogh|steam ?deck", text, re.I):
            vendor = "amd"
        elif re.search(r"nvidia|geforce|rtx|gtx", text, re.I):
            vendor = "nvidia"
        elif re.search(r"intel|arc", text, re.I):
            vendor = "intel"

    return {
        "names": names,
        "name": codename or (names[0] if names else None),
        "gfx": _gfx_target(),
        "vendor": vendor,
        "generation": generation,
        "fsr4": FSR4_SUPPORT.get(generation or "", "unknown"),
    }


_XRANDR_CONNECTOR_RE = re.compile(r"^(\S+)\s+connected\b")
_XRANDR_ACTIVE_HZ_RE = re.compile(r"(\d+(?:\.\d+)?)\*")
_DRM_MODE_HZ_RE = re.compile(r"^\d+x\d+(?:i)?@(\d+(?:\.\d+)?)")


def _parse_xrandr_refresh(output):
    """Extract the active display refresh rate from `xrandr --current` output.

    Gamescope (SteamOS Gaming Mode) and X11 mark the currently active mode's
    refresh rate with ``*`` (for example ``90.00*+`` on Steam Deck OLED or
    ``60.00*`` when docked). Returns ``(exact_hz, connector)`` or ``(None, None)``.
    """
    connector = None
    fallback = (None, None)
    for raw in (output or "").splitlines():
        conn_match = _XRANDR_CONNECTOR_RE.match(raw)
        if conn_match:
            connector = conn_match.group(1)
            continue
        if not raw.startswith((" ", "\t")):
            connector = None
            continue
        if connector is None or "*" not in raw:
            continue
        hz_match = _XRANDR_ACTIVE_HZ_RE.search(raw)
        if not hz_match:
            continue
        try:
            hz = float(hz_match.group(1))
        except ValueError:
            continue
        if MIN_REFRESH_HZ <= hz <= MAX_REFRESH_HZ:
            # Prefer a primary/internal or first valid active mode; keep highest
            # active rate if multiple outputs are active at once.
            if fallback[0] is None or hz > fallback[0]:
                fallback = (hz, connector)
    return fallback


def _xrandr_refresh():
    binary = shutil.which("xrandr")
    if not binary:
        return None, None
    displays = []
    env_display = os.environ.get("DISPLAY")
    if env_display:
        displays.append(env_display)
    for candidate in (":0", ":1"):
        if candidate not in displays:
            displays.append(candidate)
    for display in displays:
        env = dict(os.environ, DISPLAY=display)
        try:
            result = subprocess.run(
                [binary, "--current"],
                capture_output=True,
                text=True,
                timeout=1.5,
                check=False,
                env=env,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode != 0 or not result.stdout:
            continue
        hz, connector = _parse_xrandr_refresh(result.stdout)
        if hz is not None:
            return hz, connector
    return None, None


def _drm_refresh(drm_root=None):
    """Fallback refresh detection from connected DRM sysfs connectors."""
    root = Path(drm_root) if drm_root is not None else DRM_ROOT
    if not root.is_dir():
        return None, None
    best = (None, None)
    for status_file in sorted(root.glob("card[0-9]*-*/status")):
        if _read(status_file).lower() != "connected":
            continue
        connector_dir = status_file.parent
        connector = connector_dir.name
        # Some kernels/drivers expose an explicit vrefresh attribute.
        vrefresh = _read(connector_dir / "vrefresh")
        if vrefresh:
            try:
                hz = float(vrefresh)
                if MIN_REFRESH_HZ <= hz <= MAX_REFRESH_HZ:
                    if best[0] is None or hz > best[0]:
                        best = (hz, connector)
                    continue
            except ValueError:
                pass
        for filename in ("mode", "modes"):
            text = _read(connector_dir / filename)
            if not text:
                continue
            first_line = text.splitlines()[0].strip()
            match = _DRM_MODE_HZ_RE.match(first_line)
            if match:
                try:
                    hz = float(match.group(1))
                except ValueError:
                    continue
                if MIN_REFRESH_HZ <= hz <= MAX_REFRESH_HZ:
                    if best[0] is None or hz > best[0]:
                        best = (hz, connector)
                    break
    return best


def display_info():
    """Detect the active display refresh rate (Hz) for Adaptive FG target matching.

    Not cached across calls because Steam Deck users change Gamescope's refresh
    rate slider or dock/undock to external displays while playing.
    """
    hz, connector = _xrandr_refresh()
    source = "xrandr" if hz is not None else None
    if hz is None:
        hz, connector = _drm_refresh()
        source = "drm" if hz is not None else None
    if hz is None:
        return {
            "available": False,
            "refresh_hz": None,
            "exact_hz": None,
            "source": None,
            "connector": None,
        }
    return {
        "available": True,
        "refresh_hz": int(round(hz)),
        "exact_hz": round(hz, 2),
        "source": source,
        "connector": connector,
    }
