"""Adaptive Frame Generation controller with display refresh-rate matching.

Modeled after MAKO's Adaptive Frame Generation workflow:
- Dynamically adjusts OptiScaler's live frame generation state (1X..2X on FSR FG,
  1X..4X on XeFG) to hold a target frame rate.
- Supports a "Match display refresh rate" mode that automatically tracks the
  active display refresh rate (e.g. Gamescope's 90 Hz on Steam Deck OLED or
  60 Hz when docked), falling back cleanly to the manual Target FPS whenever
  display refresh telemetry is unavailable.
- Uses exponential moving-average smoothing, separate step-up/step-down hold
  windows, and a post-switch cooldown so frametime spikes never cause rapid
  oscillation.
"""

import math
import time

MIN_TARGET_FPS = 30
MAX_TARGET_FPS = 240
VALID_MULTIPLIERS = (2, 3, 4)

# Smoothing and hysteresis tuning.
EMA_ALPHA = 0.35
MIN_SAMPLES = 2
STEP_UP_MARGIN = 0.94     # Step up when projected FPS < 94% of target
STEP_UP_AIM = 0.97        # Choose lowest multiplier reaching >= 97% of target
STEP_DOWN_MARGIN = 1.05   # Step down only when lower multiplier >= 105% of target
STEP_UP_HOLD_S = 1.5
STEP_DOWN_HOLD_S = 3.5
SWITCH_COOLDOWN_S = 2.0

DEFAULT_CONFIG = {
    "enabled": False,
    "match_refresh_rate": True,
    "target_fps": 60,
    "max_multiplier": 2,
    "allow_1x": True,
    "cap_to_target": False,
}


def normalize_config(raw=None, base=None):
    """Validate and normalize per-game Adaptive FG settings."""
    merged = dict(DEFAULT_CONFIG)
    if isinstance(base, dict):
        merged.update(base)
    if isinstance(raw, dict):
        merged.update(raw)

    enabled = bool(merged.get("enabled", False))
    match_refresh = bool(merged.get("match_refresh_rate", True))
    allow_1x = bool(merged.get("allow_1x", True))
    cap_to_target = bool(merged.get("cap_to_target", False))

    try:
        target_fps = int(round(float(merged.get("target_fps", 60))))
    except (TypeError, ValueError):
        target_fps = DEFAULT_CONFIG["target_fps"]
    target_fps = max(MIN_TARGET_FPS, min(MAX_TARGET_FPS, target_fps))

    try:
        max_multiplier = int(merged.get("max_multiplier", 2))
    except (TypeError, ValueError):
        max_multiplier = DEFAULT_CONFIG["max_multiplier"]
    if max_multiplier not in VALID_MULTIPLIERS:
        max_multiplier = min(VALID_MULTIPLIERS, key=lambda m: abs(m - max_multiplier))

    return {
        "enabled": enabled,
        "match_refresh_rate": match_refresh,
        "target_fps": target_fps,
        "max_multiplier": max_multiplier,
        "allow_1x": allow_1x,
        "cap_to_target": cap_to_target,
    }


def resolve_target_fps(config, display=None):
    """Compute the effective target FPS and where it came from.

    When ``match_refresh_rate`` is enabled and the display reports a valid Hz,
    the display refresh rate is used (clamped to ``[MIN_TARGET_FPS, MAX_TARGET_FPS]``).
    Otherwise falls back to the manual ``target_fps`` setting.
    """
    cfg = normalize_config(config)
    display_hz = None
    display_source = None
    if isinstance(display, dict):
        raw_hz = display.get("refresh_hz")
        if isinstance(raw_hz, (int, float)) and not isinstance(raw_hz, bool) and raw_hz > 0:
            display_hz = int(round(raw_hz))
            display_source = display.get("source")

    if cfg["match_refresh_rate"] and display_hz is not None:
        effective = max(MIN_TARGET_FPS, min(MAX_TARGET_FPS, display_hz))
        return {
            "effective_target_fps": effective,
            "target_source": "display",
            "display_refresh_hz": display_hz,
            "display_source": display_source,
            "fallback_used": False,
        }

    return {
        "effective_target_fps": cfg["target_fps"],
        "target_source": "manual",
        "display_refresh_hz": display_hz,
        "display_source": display_source,
        "fallback_used": bool(cfg["match_refresh_rate"]),
    }


def _positive_float(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
        return float(value)
    return None


def _estimate_base_fps(live_report, current_multiplier):
    """Best available rendered (base) FPS from the live status payload."""
    base = _positive_float(live_report.get("base_fps"))
    if base is not None:
        return base
    fg_enabled = live_report.get("fg_enabled")
    total = _positive_float(live_report.get("total_fps")) or _positive_float(live_report.get("fps"))
    if total is not None:
        if fg_enabled is False:
            return total
        if current_multiplier >= 1:
            return total / float(current_multiplier)
    present_path = _positive_float(live_report.get("present_path_fps"))
    if present_path is not None:
        if fg_enabled is False:
            return present_path
        if current_multiplier >= 1:
            return present_path / float(current_multiplier)
    return None


def _plan_changes(current_multiplier, desired_multiplier, can_change_fg_enable,
                  can_change_xefg_count, uses_xefg):
    """Translate a multiplier transition into live OptiScaler INI changes."""
    if desired_multiplier == current_multiplier:
        return []
    changes = []
    if desired_multiplier == 1:
        if not can_change_fg_enable:
            return []
        changes.append({"section": "FrameGen", "key": "Enabled", "value": "false"})
        return changes

    # desired_multiplier >= 2
    if current_multiplier == 1:
        if not can_change_fg_enable:
            return []
        changes.append({"section": "FrameGen", "key": "Enabled", "value": "true"})
        if uses_xefg and can_change_xefg_count:
            changes.append({
                "section": "XeFG",
                "key": "InterpolationCount",
                "value": str(desired_multiplier - 1),
            })
        return changes

    # Switching between 2X / 3X / 4X while FG is already active.
    if uses_xefg and can_change_xefg_count:
        changes.append({
            "section": "XeFG",
            "key": "InterpolationCount",
            "value": str(desired_multiplier - 1),
        })
    return changes


class AdaptiveFgController:
    """Per-target stateful adaptive frame-generation controller."""

    def __init__(self):
        self._targets = {}

    def reset(self, target_key=None):
        if target_key is None:
            self._targets.clear()
        else:
            self._targets.pop(str(target_key), None)

    def _state(self, target_key):
        key = str(target_key)
        state = self._targets.get(key)
        if state is None:
            state = {
                "session": None,
                "smoothed_base_fps": None,
                "samples": 0,
                "pending_multiplier": None,
                "pending_since": None,
                "last_switch_at": None,
                "last_action": None,
                "last_changed_at": None,
            }
            self._targets[key] = state
        return state

    def evaluate(self, target_key, config, live_report, display=None,
                 fg_output="auto", current_xefg_count=1, now=None):
        """Evaluate one telemetry sample and return ``(status, changes)``.

        ``changes`` is a list of ``{"section", "key", "value"}`` dicts to apply
        via live control, or ``[]`` when no change should be sent on this tick.
        """
        cfg = normalize_config(config)
        target_info = resolve_target_fps(cfg, display)
        effective_target = target_info["effective_target_fps"]
        state = self._state(target_key)
        ts = time.monotonic() if now is None else float(now)

        fg_out = str(fg_output or "auto").strip().lower()
        uses_xefg = fg_out == "xefg"
        caps = (live_report or {}).get("capabilities") or {}
        can_enable = bool(caps.get("fg_enable") or caps.get("fg_change") or
                          (live_report or {}).get("can_change_fg_enable"))
        can_xefg = bool(caps.get("change_xefg_count") or
                        (live_report or {}).get("can_change_xefg_count"))
        max_supported = cfg["max_multiplier"] if (uses_xefg and can_xefg) else 2
        max_supported = max(2, min(4, max_supported))
        min_supported = 1 if (cfg["allow_1x"] and can_enable) else 2

        fg_enabled = (live_report or {}).get("fg_enabled")
        try:
            xefg_mult = max(2, min(4, int(current_xefg_count) + 1))
        except (TypeError, ValueError):
            xefg_mult = 2
        current_multiplier = 1 if fg_enabled is False else (xefg_mult if uses_xefg else 2)

        def _status(active, reason, desired=None, base_fps=None):
            return {
                "enabled": cfg["enabled"],
                "active": active,
                "reason": reason,
                **target_info,
                "max_multiplier": cfg["max_multiplier"],
                "max_supported_multiplier": max_supported,
                "min_supported_multiplier": min_supported,
                "current_multiplier": current_multiplier if (live_report or {}).get("attached") else None,
                "desired_multiplier": desired,
                "smoothed_base_fps": round(base_fps, 1) if base_fps is not None else None,
                "last_action": state["last_action"],
                "last_changed_at": state["last_changed_at"],
            }

        if not cfg["enabled"]:
            self.reset(target_key)
            return _status(False, "Adaptive frame generation is off."), []

        if not live_report or not live_report.get("ready") or not live_report.get("live_write_safe"):
            state["pending_multiplier"] = None
            state["pending_since"] = None
            return _status(False, "Waiting for live control to attach and become ready."), []

        if not can_enable and not (uses_xefg and can_xefg):
            return _status(
                False,
                "This running game exposes neither live FG enable nor XeFG multiplier control.",
            ), []

        # Reset EMA when a new game session starts.
        session = live_report.get("session")
        if session != state["session"]:
            state["session"] = session
            state["smoothed_base_fps"] = None
            state["samples"] = 0
            state["pending_multiplier"] = None
            state["pending_since"] = None
            state["last_switch_at"] = None

        base_fps = _estimate_base_fps(live_report, current_multiplier)
        if base_fps is None:
            return _status(False, "Waiting for live FPS telemetry."), []

        if state["smoothed_base_fps"] is None:
            state["smoothed_base_fps"] = base_fps
        else:
            state["smoothed_base_fps"] = (
                EMA_ALPHA * base_fps + (1.0 - EMA_ALPHA) * state["smoothed_base_fps"]
            )
        state["samples"] += 1
        smoothed = state["smoothed_base_fps"]

        if state["samples"] < MIN_SAMPLES:
            return _status(True, "Sampling frame rate…", current_multiplier, smoothed), []

        # Decide candidate multiplier with hysteresis.
        desired = current_multiplier
        if smoothed * current_multiplier < effective_target * STEP_UP_MARGIN and current_multiplier < max_supported:
            desired = max_supported
            for m in range(current_multiplier + 1, max_supported + 1):
                if smoothed * m >= effective_target * STEP_UP_AIM:
                    desired = m
                    break
        elif current_multiplier > min_supported and smoothed * (current_multiplier - 1) >= effective_target * STEP_DOWN_MARGIN:
            desired = current_multiplier - 1

        if desired == current_multiplier:
            state["pending_multiplier"] = None
            state["pending_since"] = None
            return _status(True, f"Holding {current_multiplier}X near {effective_target} fps.", current_multiplier, smoothed), []

        # Enforce post-switch cooldown.
        if state["last_switch_at"] is not None and (ts - state["last_switch_at"]) < SWITCH_COOLDOWN_S:
            return _status(True, f"Settling at {current_multiplier}X.", desired, smoothed), []

        # Require sustained condition before stepping up or down.
        hold_required = STEP_UP_HOLD_S if desired > current_multiplier else STEP_DOWN_HOLD_S
        if state["pending_multiplier"] != desired:
            state["pending_multiplier"] = desired
            state["pending_since"] = ts
            return _status(
                True,
                f"Watching for {desired}X (base {smoothed:.1f} fps → target {effective_target} fps).",
                desired,
                smoothed,
            ), []

        if (ts - state["pending_since"]) < hold_required:
            return _status(
                True,
                f"Holding before switching to {desired}X.",
                desired,
                smoothed,
            ), []

        changes = _plan_changes(
            current_multiplier, desired, can_enable, can_xefg, uses_xefg
        )
        if not changes:
            state["pending_multiplier"] = None
            state["pending_since"] = None
            return _status(True, f"Cannot change multiplier beyond {current_multiplier}X in this game.", current_multiplier, smoothed), []

        state["pending_multiplier"] = None
        state["pending_since"] = None
        state["last_switch_at"] = ts
        state["last_changed_at"] = time.time()
        state["last_action"] = f"{current_multiplier}X -> {desired}X"
        return _status(
            True,
            f"Adjusted frame generation {current_multiplier}X → {desired}X for {effective_target} fps target.",
            desired,
            smoothed,
        ), changes
