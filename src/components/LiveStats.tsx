import { PanelSection, PanelSectionRow } from "@decky/ui";
import { liveFrameRates, liveUpscalerLabel } from "../config/basic";
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
 * Frame generation splits the frame rate in two, so with it on there are two to
 * show: what the game renders and what reaches the screen. That is the whole
 * point of turning it on, and one number could only ever answer half of it — so
 * both appear whenever it is on, and the row wraps to make room for them. When
 * they come out equal the generator is not actually running, which the
 * frame-generation tile says rather than leaving two identical numbers to look
 * like a fault; when the rendered rate was never read at all the tile is still
 * there and says that instead, because a pair of counters that silently becomes
 * one counter reads as the feature not being there.
 */
export function LiveTiles({ live, fgSub }: { live: LiveStatus | null; fgSub?: string }) {
  if (!live?.attached) return null;
  const rate = (value: number | null | undefined) =>
    typeof value === "number" && value > 0 ? value.toFixed(0) : "—";
  const fg = typeof live.fg_enabled === "boolean" ? (live.fg_enabled ? "ON" : "OFF") : "—";
  const rates = liveFrameRates(live);
  const upscaler = liveUpscalerLabel(live);
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
              : live.fg_enabled
                ? fgSub
                : undefined
        }
        color={rates?.generating ? "#7fd08a" : undefined}
        grow={0.9}
        min={80}
      />
      <Tile label="upscaler" value={upscaler ?? "—"} grow={1.4} min={100} />
    </div>
  );
}

export function LiveStats({ live }: { live: LiveStatus | null }) {
  if (!live?.attached) return null;

  const upscalerName = liveUpscalerLabel(live) ?? "unknown";
  // A status file written by an older build of the in-game plugin has none of
  // these fields, so every one of them is treated as optional.
  const rates = liveFrameRates(live);
  // The counter on its own does not say which rate it counted, so what is
  // labelled the frame rate here is the derived total wherever there is one.
  const fps = rates?.total ?? (typeof live.fps === "number" ? live.fps : null);

  return (
    <PanelSection title="In-game now">
      <PanelSectionRow>
        <div style={{ padding: "2px 0" }}>
          <KeyValue
            label={rates ? "Frame rate, with FG" : "Frame rate"}
            value={fps === null || fps <= 0 ? "measuring…" : <b>{fps.toFixed(1)} fps</b>}
          />
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
