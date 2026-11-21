# Adaptive Frame Generation & Display Refresh Matching

Decky OptiScaler supports per-game **Adaptive Frame Generation** modeled after MAKO's adaptive pacing workflow:

- **Adaptive Frame Generation:** Uses OptiScaler's live telemetry (`base_fps` / `fps`) and live-control bridge (`FrameGen.Enabled` and `XeFG.InterpolationCount`) to adjust frame generation dynamically toward a target frame rate:
  - **XeFG:** adapts across **1X, 2X, 3X, and 4X** up to your chosen maximum multiplier.
  - **FSR FG:** adapts between **1X (FG paused)** and **2X** when the game supports live FG toggling.
- **Match display refresh rate:** Automatically detects the active display refresh rate from Gamescope / XRandR (`xrandr --current`) or DRM sysfs (for example, `90 Hz` on Steam Deck OLED or `60 Hz` when docked) and uses it as the Adaptive FG target FPS. If display refresh telemetry is unavailable or disabled, it falls back cleanly to your manual **Target FPS**.
- **Hysteresis & cooldown:** Applies exponential moving-average smoothing to base FPS, requires a sustained dip (`1.5s`) before stepping up and sustained headroom (`3.5s`) before stepping down, and enforces a `2.0s` cooldown between switches so brief frame-time spikes do not cause oscillation.
- **Allow 1X (pause FG at target):** Lets Adaptive FG disable frame generation (`1X`) whenever native rendered FPS comfortably exceeds the target.
- **Cap FPS to target:** Optionally syncs OptiScaler's `[Framerate] FramerateLimit` to the effective target FPS for steadier frame pacing.

## Where to configure it

Open a game's **Settings → Frame Generation** section (or Quick Access while playing), turn **Adaptive frame generation** on, and toggle **Match display refresh rate** (or pick a manual **Target FPS**).
