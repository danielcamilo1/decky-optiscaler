import { PanelSection, PanelSectionRow } from "@decky/ui";
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
/** One number, labelled, sized to be read at a glance over a running game. */
function Tile({
  label,
  value,
  sub,
  color,
  grow = 1,
}: Readonly<{ label: string; value: string; sub?: string; color?: string; grow?: number }>) {
  return (
    <div
      style={{
        flex: `${grow} 1 0`,
        minWidth: 0,
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
 * The same three answers as `LiveStats`, laid out to be read rather than
 * scrolled past: what the frame rate is, whether frame generation is on, and
 * which upscaler the game actually ended up with.
 *
 * The Quick Access panel opens over a running game, so these three sit at the
 * top of it and the controls that change them follow underneath.
 */
export function LiveTiles({ live, fgSub }: { live: LiveStatus | null; fgSub?: string }) {
  if (!live?.attached) return null;
  const backend = live.upscaler?.dx12 ?? live.upscaler?.vulkan ?? live.upscaler?.dx11 ?? null;
  const fps = typeof live.fps === "number" && live.fps > 0 ? live.fps.toFixed(0) : "—";
  const fg = typeof live.fg_enabled === "boolean" ? (live.fg_enabled ? "ON" : "OFF") : "—";
  return (
    <div style={{ display: "flex", gap: "6px", padding: "2px 0 4px" }}>
      <Tile label="fps" value={fps} grow={0.7} />
      <Tile
        label="frame gen"
        value={fg}
        sub={live.fg_enabled ? fgSub : undefined}
        color={live.fg_enabled ? "#7fd08a" : undefined}
        grow={0.9}
      />
      <Tile
        label="upscaler"
        value={backend ? UPSCALER_LABELS[backend] ?? backend : "—"}
        grow={1.4}
      />
    </div>
  );
}

export function LiveStats({ live }: { live: LiveStatus | null }) {
  if (!live?.attached) return null;

  const upscaler = live.upscaler?.dx12 ?? live.upscaler?.vulkan ?? live.upscaler?.dx11 ?? null;
  const upscalerName = upscaler ? UPSCALER_LABELS[upscaler] ?? upscaler : "unknown";
  // A status file written by an older build of the in-game plugin has none of
  // these fields, so every one of them is treated as optional.
  const fps = typeof live.fps === "number" ? live.fps : null;

  return (
    <PanelSection title="In-game now">
      <PanelSectionRow>
        <div style={{ padding: "2px 0" }}>
          <KeyValue
            label="Frame rate"
            value={fps === null || fps <= 0 ? "measuring…" : <b>{fps.toFixed(1)} fps</b>}
          />
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
