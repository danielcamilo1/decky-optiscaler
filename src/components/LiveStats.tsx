import { PanelSection, PanelSectionRow } from "@decky/ui";
import {
  liveFfxFgLabel,
  liveFrameRates,
  livePresentPathFps,
  liveUpscalerLabel,
} from "../config/basic";
import { hasVerifiedLiveRuntime } from "../liveControl";
import { UPSCALER_LABELS } from "../config/labels";
import type { LiveStatus } from "../types";
import { KeyValue } from "./Common";

/**
 * What the game is doing right now, read out of OptiScaler itself.
 *
 * Read-only on purpose. Changing things live belongs next to the control that
 * changes them — the frame-generation state sits with the toggle, and the
 * upscaler switch appears beside the upscaler dropdown once one is picked — so
 * this is only the report: frame rate and the upscaler that is actually up.
 */
/**
 * One number, labelled, sized to be read at a glance over a running game.
 *
 * `min` is what decides how many fit on a line. The row wraps rather than
 * scrolls, so a tile that appears only sometimes — the second frame rate —
 * pushes the row onto two lines instead of squeezing every tile past
 * legibility in a ~310px column.
 */
function Tile({
  label,
  value,
  sub,
  color,
  grow = 1,
  min = 80,
}: Readonly<{
  label: string;
  value: string;
  sub?: string;
  color?: string;
  grow?: number;
  min?: number;
}>) {
  return (
    <div
      style={{
        flex: `${grow} 1 ${min}px`,
        minWidth: `${min}px`,
        background: "rgba(255,255,255,0.05)",
        borderRadius: "4px",
        padding: "8px 9px",
      }}
    >
      <div
        style={{
          fontSize: "10px",
          letterSpacing: "0.7px",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
          overflow: "hidden",
          opacity: 0.42,
          marginBottom: "3px",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "16px",
          fontWeight: 700,
          color,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
        {sub ? <span style={{ fontSize: "11px", fontWeight: 400, opacity: 0.55 }}> {sub}</span> : null}
      </div>
    </div>
  );
}

/**
 * The answers `LiveStats` gives, laid out to be read rather than scrolled past:
 * what the frame rate is, whether frame generation is on, and which upscaler
 * the game actually ended up with.
 *
 * The Quick Access panel opens over a running game, so these sit at the top of
 * it and the controls that change them follow underneath.
 *
 * When a frame counter can be matched to both intervals, frame generation
 * splits its rate in two and both are shown. If only core intervals are
 * available, the panel says "present path FPS" (or the measured interval) and
 * does not turn one interval into a generated-frame multiplier. The actual FG
 * object state is also kept separate from the configured setting.
 */
export function LiveTiles({ live }: { live: LiveStatus | null }) {
  if (!hasVerifiedLiveRuntime(live)) return null;
  const rate = (value: number | null | undefined) =>
    typeof value === "number" && value > 0 ? value.toFixed(0) : "—";
  const fg = typeof live.fg_enabled === "boolean" ? (live.fg_enabled ? "ON" : "OFF") : "—";
  const rates = liveFrameRates(live);
  const coreIntervals = live.telemetry_ready === true && live.telemetry_source === "core_intervals";
  const presentPathFps = livePresentPathFps(live);
  const presentMs =
    coreIntervals && typeof live.presented_ms === "number" && live.presented_ms > 0
      ? live.presented_ms
      : null;
  const upscaler = liveUpscalerLabel(live);
  const ffxFg = liveFfxFgLabel(live);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", padding: "2px 0 4px" }}>
      {rates ? (
        <>
          <Tile label="base fps" value={rate(rates.base)} grow={0.7} min={76} />
          <Tile
            label="with fg"
            value={rate(rates.total)}
            color={rates.generating ? "#7fd08a" : undefined}
            grow={0.7}
            min={76}
          />
        </>
      ) : coreIntervals ? (
        presentPathFps !== null ? (
          <Tile label="present path fps" value={presentPathFps.toFixed(1)} grow={0.9} min={98} />
        ) : presentMs !== null ? (
          <Tile label="present interval" value={`${presentMs.toFixed(2)} ms`} grow={0.9} min={98} />
        ) : (
          <Tile label="present path fps" value="—" grow={0.9} min={98} />
        )
      ) : (
        <Tile label="fps" value={rate(live.fps)} grow={0.7} min={76} />
      )}
      <Tile
        label="frame gen"
        value={fg}
        // Frame generation on and not generating is the state that otherwise
        // shows up as two identical frame rates and no reason for them.
        sub={
          rates && rates.base === null
            ? "no reading"
            : rates && !rates.generating
              ? "idle"
              : undefined
        }
        color={rates?.generating ? "#7fd08a" : undefined}
        grow={0.9}
        min={80}
      />
      <Tile label="upscaler" value={upscaler ?? "—"} grow={1.4} min={100} />
      {ffxFg ? (
        <Tile label="FFX FG" value={ffxFg} grow={1} min={100} />
      ) : null}
    </div>
  );
}

export function LiveStats({ live }: { live: LiveStatus | null }) {
  if (!hasVerifiedLiveRuntime(live) || !live) return null;

  const upscalerName = liveUpscalerLabel(live) ?? "unknown";
  // A status file written by an older build of the in-game plugin has none of
  // these fields, so every one of them is treated as optional.
  const rates = liveFrameRates(live);
  const coreIntervals = live.telemetry_ready === true && live.telemetry_source === "core_intervals";
  const presentPathFps = livePresentPathFps(live);
  // The counter on its own does not say which rate it counted, so what is
  // labelled the frame rate here is the derived total wherever there is one.
  const fps = coreIntervals
    ? null
    : rates?.total ?? (typeof live.fps === "number" ? live.fps : null);

  return (
    <PanelSection title="In-game now">
      <PanelSectionRow>
        <div style={{ padding: "2px 0" }}>
          <KeyValue
            label={rates ? "Frame rate, with FG" : "Frame rate"}
            value={fps === null || fps <= 0 ? "unknown" : <b>{fps.toFixed(1)} fps</b>}
          />
          {live.fg_enabled !== null ? (
            <KeyValue
              label="Frame generation active"
              value={live.fg_enabled ? "on" : "off"}
            />
          ) : null}
          {typeof live.configured_fg_enabled === "boolean" ? (
            <KeyValue
              label="Frame generation configured"
              value={live.configured_fg_enabled ? "on" : "off"}
            />
          ) : null}
          {coreIntervals ? (
            <KeyValue
              label="Present path FPS"
              value={
                presentPathFps === null
                  ? "unavailable"
                  : <b>{presentPathFps.toFixed(1)} fps</b>
              }
            />
          ) : null}
          {live.ffx_fg_versions?.length ? (
            <KeyValue
              label="FFX frame generator"
              value={liveFfxFgLabel(live) ?? "not identified by the runtime"}
            />
          ) : null}
          {rates ? (
            <KeyValue
              label="Rendered"
              value={
                rates.base === null ? (
                  "not reported by the in-game plugin"
                ) : (
                  <>
                    <b>{rates.base.toFixed(1)} fps</b>
                    {rates.generating ? "" : " (no frames being generated)"}
                  </>
                )
              }
            />
          ) : null}
          {coreIntervals && typeof live.presented_ms === "number" && live.presented_ms > 0 ? (
            <KeyValue
              label="Present interval"
              value={`${live.presented_ms.toFixed(2)} ms`}
            />
          ) : null}
          <KeyValue label="Upscaler" value={upscalerName} />
          {live.pending_backend ? (
            <KeyValue
              label="Switching to"
              value={UPSCALER_LABELS[live.pending_backend] ?? live.pending_backend}
            />
          ) : null}
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
}
