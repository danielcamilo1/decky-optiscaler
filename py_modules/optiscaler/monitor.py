"""Derive OptiScaler's runtime state from the log it writes next to the game.

OptiScaler exposes no IPC, so the log file is the only window into what it
actually did: which proxy dll loaded, which upscaler backend was created and
which frame generation path came up.
"""

import os
import re
from pathlib import Path

from .constants import INI_NAME, LOG_NAME
from .inifile import IniFile

LINE_RE = re.compile(r"^\[?(\d{2}:\d{2}:\d{2}\.\d+)\]?\s*[\t ]\[?([A-Z])\]?\s*[\t ]?(.*)$")

# Ordered: later matches overwrite earlier ones, so the newest state wins.
FACTS = [
    ("wine", re.compile(r"Running on Wine (.+?)!")),
    ("proxy", re.compile(r"OptiScaler working as ([A-Za-z0-9_]+\.dll)")),
    ("game_exe", re.compile(r"Game's Exe:\s*(.+)")),
    ("game_name", re.compile(r"Game Name:\s*(.+)")),
    ("game_version", re.compile(r"Game Version:\s*(.+)")),
    ("gpu", re.compile(r"Adapter Desc:\s*(.+)")),
    ("upscaler", re.compile(r"Creating new (.+?) upscaler")),
    ("upscaler", re.compile(r"init successful for (.+?), upscaler changed")),
    ("upscaler", re.compile(r"changing backend to (.+?)\s*$")),
    ("optiscaler_version", re.compile(r"OptiScaler\s+v?(\d+\.\d+[\w.\-]*)")),
]

# Presence of a line implies a frame generation path is live.
FG_SIGNALS = [
    ("XeFG", re.compile(r"XeFG (?:swapchain|context) created")),
    ("Nukem's dlssg-to-fsr3", re.compile(r"Nukem's initialized")),
    ("FSR FG", re.compile(r"FSR(?:3)?\s*FG .*(?:created|initialized|enabled)", re.I)),
    ("OptiFG", re.compile(r"OptiFG .*(?:created|initialized|enabled)", re.I)),
    ("DLSSG via Streamline", re.compile(r"DLSSG .*(?:created|initialized|enabled)", re.I)),
]

LEVELS = {"T": "trace", "D": "debug", "I": "info", "W": "warning", "E": "error", "C": "critical"}

# Log lines that have a known cause worth explaining rather than just showing.
HINTS = [
    (
        re.compile(r"Failed to load amdxcffx64\.dll"),
        "FSR 4 is unavailable: amdxcffx64.dll is missing. OptiScaler does not ship it, and "
        "under Proton there is no AMD driver store to load it from. Add it to the game "
        "folder from the Setup tab.",
    ),
    (
        re.compile(r"Failed to load.*nvngx", re.I),
        "DLSS inputs are unavailable: nvngx could not be loaded. This is expected on "
        "non-Nvidia hardware unless spoofing is enabled.",
    ),
    (
        re.compile(r"No supported.*(upscaler|feature)", re.I),
        "OptiScaler found no upscaler it could hook. The game may not expose DLSS/FSR2+/XeSS, "
        "or the proxy dll is not being loaded — check the WINEDLLOVERRIDES launch option.",
    ),
]


def tail(path, max_bytes=512 * 1024):
    """Read the last max_bytes of a file as text."""
    path = Path(path)
    size = path.stat().st_size
    with open(path, "rb") as handle:
        if size > max_bytes:
            handle.seek(size - max_bytes)
            handle.readline()  # discard the partial first line
        data = handle.read()
    return data.decode("utf-8", errors="replace")


def parse_log(text, recent=80):
    """Extract runtime facts, level counts and the tail of a log."""
    state = {
        "wine": None,
        "proxy": None,
        "game_exe": None,
        "game_name": None,
        "game_version": None,
        "gpu": None,
        "upscaler": None,
        "optiscaler_version": None,
    }
    counts = {name: 0 for name in LEVELS.values()}
    fg_paths = []
    problems = []
    lines = []

    for raw in text.splitlines():
        m = LINE_RE.match(raw)
        if m:
            timestamp, level_code, message = m.group(1), m.group(2), m.group(3)
            level = LEVELS.get(level_code, "info")
        else:
            timestamp, level, message = None, "info", raw
        if not message.strip():
            continue

        counts[level] = counts.get(level, 0) + 1
        entry = {"time": timestamp, "level": level, "message": message.strip()}
        lines.append(entry)
        if level in ("error", "critical", "warning"):
            problems.append(entry)

        for key, pattern in FACTS:
            found = pattern.search(message)
            if found:
                state[key] = found.group(1).strip()
        for label, pattern in FG_SIGNALS:
            if pattern.search(message) and label not in fg_paths:
                fg_paths.append(label)

    hints = []
    for pattern, explanation in HINTS:
        if any(pattern.search(entry["message"]) for entry in lines):
            hints.append(explanation)

    return {
        "state": state,
        "counts": counts,
        "frame_generation": fg_paths,
        "problems": problems[-25:],
        "recent": lines[-recent:],
        "hints": hints,
        "total_lines": len(lines),
    }


def status(target_dir):
    """Full monitoring snapshot for an install directory."""
    target = Path(target_dir)
    log_path = target / LOG_NAME
    ini_path = target / INI_NAME

    report = {
        "path": str(target),
        "log_path": str(log_path),
        "log_present": log_path.is_file(),
        "log_size": 0,
        "log_modified": None,
        "logging_enabled": None,
        "state": {},
        "counts": {},
        "frame_generation": [],
        "problems": [],
        "recent": [],
        "hints": [],
        "configured": {},
    }

    if ini_path.is_file():
        values = IniFile(ini_path).to_dict()
        report["logging_enabled"] = values.get("Log", {}).get("LogToFile", "auto")
        report["configured"] = {
            "fg_enabled": values.get("FrameGen", {}).get("Enabled", "auto"),
            "fg_input": values.get("FrameGen", {}).get("FGInput", "auto"),
            "fg_output": values.get("FrameGen", {}).get("FGOutput", "auto"),
            "dx11_upscaler": values.get("Upscalers", {}).get("Dx11Upscaler", "auto"),
            "dx12_upscaler": values.get("Upscalers", {}).get("Dx12Upscaler", "auto"),
            "vulkan_upscaler": values.get("Upscalers", {}).get("VulkanUpscaler", "auto"),
            "framerate_limit": values.get("Framerate", {}).get("FramerateLimit", "auto"),
            "output_scaling": values.get("OutputScaling", {}).get("Enabled", "auto"),
            "sharpness_override": values.get("Sharpness", {}).get("OverrideSharpness", "auto"),
        }

    if not log_path.is_file():
        return report

    try:
        stat = log_path.stat()
        report["log_size"] = stat.st_size
        report["log_modified"] = stat.st_mtime
        report.update(parse_log(tail(log_path)))
    except OSError as exc:
        report["error"] = str(exc)
    return report


def clear_log(target_dir):
    log_path = Path(target_dir) / LOG_NAME
    if log_path.is_file():
        os.truncate(log_path, 0)
        return True
    return False
