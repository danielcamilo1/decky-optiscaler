import { PanelSection, PanelSectionRow } from "@decky/ui";
import {
  liveFfxFgLabel,
  liveFrameRates,
  livePresentPathFps,
  liveUpscalerLabel,
} from "../config/basic";
import { hasVerifiedLiveRuntime } from "../liveControl";
import { UPSCALER_LABELS } from "../config/labels";
import { useI18n } from "../i18n";
import type { LiveStatus } from "../types";
import { KeyValue } from "./Common";

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
 * Compact telemetry tiles for the ~310px Quick Access column.
 *
 * Uses "Est. FPS" when only core intervals are reported (while LivePanel's
 * diagnostic telemetry keeps the exact "Present path FPS" wording).
 */
export function LiveTiles({ live }: { live: LiveStatus | null }) {
  const { t } = useI18n();
  if (!hasVerifiedLiveRuntime(live)) return null;
  const rate = (value: number | null | undefined) =>
    typeof value === "number" && value > 0 ? value.toFixed(0) : "—";
  const fg = typeof live.fg_enabled === "boolean" ? (live.fg_enabled ? t("ON") : t("OFF")) : "—";
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
          <Tile label={t("base fps")} value={rate(rates.base)} grow={0.7} min={76} />
          <Tile
            label={t("with fg")}
            value={rate(rates.total)}
            color={rates.generating ? "#7fd08a" : undefined}
            grow={0.7}
            min={76}
          />
        </>
      ) : coreIntervals ? (
        presentPathFps !== null ? (
          <Tile label={t("Est. FPS")} value={presentPathFps.toFixed(1)} grow={0.9} min={84} />
        ) : presentMs !== null ? (
          <Tile label={t("present interval")} value={`${presentMs.toFixed(2)} ms`} grow={0.9} min={98} />
        ) : (
          <Tile label={t("Est. FPS")} value="—" grow={0.9} min={84} />
        )
      ) : (
        <Tile label={t("fps")} value={rate(live.fps)} grow={0.7} min={76} />
      )}
      <Tile
        label={t("frame gen")}
        value={fg}
        sub={
          rates && rates.base === null
            ? t("no reading")
            : rates && !rates.generating
              ? t("idle")
              : undefined
        }
        color={rates?.generating ? "#7fd08a" : undefined}
        grow={0.9}
        min={80}
      />
      <Tile label={t("upscaler")} value={upscaler ?? "—"} grow={1.4} min={100} />
      {ffxFg ? (
        <Tile label="FFX FG" value={ffxFg} grow={1} min={100} />
      ) : null}
    </div>
  );
}

/**
 * Shared key-value telemetry list used by both LiveStats (player view) and
 * LivePanel (diagnostic view). Uses the three-way frame-rate branch so
 * `core_intervals` never renders a misleading "Frame rate: unknown" row.
 */
export function LiveTelemetryList({
  live,
  diagnostic = false,
}: Readonly<{
  live: LiveStatus | null;
  diagnostic?: boolean;
}>) {
  const { t } = useI18n();
  if (!hasVerifiedLiveRuntime(live) || !live) return null;

  const ms = (value: number | null | undefined) =>
    typeof value === "number" && value > 0 ? `${value.toFixed(2)} ms` : "—";
  const fpsText = (value: number | null | undefined) =>
    typeof value === "number" && value > 0 ? `${value.toFixed(1)} fps` : "—";

  const rates = liveFrameRates(live);
  const coreIntervals = live.telemetry_ready === true && live.telemetry_source === "core_intervals";
  const presentPathFps = livePresentPathFps(live);
  const upscalerName = liveUpscalerLabel(live) ?? t("unknown");

  return (
    <div style={{ padding: "2px 0" }}>
      {rates ? (
        <>
          <KeyValue
            label={diagnostic ? t("Presented rate") : t("Frame rate, with FG")}
            value={diagnostic ? fpsText(rates.total) : <b>{rates.total.toFixed(1)} fps</b>}
          />
          <KeyValue
            label={diagnostic ? t("Rendered rate") : t("Rendered")}
            value={
              rates.base === null ? (
                t("not reported by the in-game plugin")
              ) : diagnostic ? (
                fpsText(rates.base)
              ) : (
                <>
                  <b>{rates.base.toFixed(1)} fps</b>
                  {rates.generating ? "" : t(" (no frames being generated)")}
                </>
              )
            }
          />
        </>
      ) : coreIntervals ? (
        <>
          <KeyValue
            label={t("Present path FPS")}
            value={
              presentPathFps === null
                ? t("unavailable")
                : diagnostic
                  ? fpsText(presentPathFps)
                  : <b>{presentPathFps.toFixed(1)} fps</b>
            }
          />
          {!diagnostic && typeof live.presented_ms === "number" && live.presented_ms > 0 ? (
            <KeyValue
              label={t("Present interval")}
              value={`${live.presented_ms.toFixed(2)} ms`}
            />
          ) : null}
        </>
      ) : (
        <KeyValue
          label={diagnostic ? t("Frame counter rate") : t("Frame rate")}
          value={
            diagnostic
              ? fpsText(live.fps)
              : typeof live.fps === "number" && live.fps > 0
                ? <b>{live.fps.toFixed(1)} fps</b>
                : t("unknown")
          }
        />
      )}

      {live.fg_enabled !== null ? (
        <KeyValue
          label={t("Frame generation active")}
          value={live.fg_enabled ? t("on") : t("off")}
        />
      ) : null}
      {typeof live.configured_fg_enabled === "boolean" ? (
        <KeyValue
          label={t("Frame generation configured")}
          value={live.configured_fg_enabled ? t("on") : t("off")}
        />
      ) : null}
      {live.ffx_fg_versions?.length ? (
        <KeyValue
          label={t("FFX frame generator")}
          value={liveFfxFgLabel(live) ?? t("not identified by the runtime")}
        />
      ) : null}

      {diagnostic ? (
        <>
          {live.telemetry_ready === true ? (
            <KeyValue
              label={t("Intervals")}
              value={t("{present} present · {fg} fg", {
                present: ms(live.presented_ms),
                fg: ms(live.rendered_ms),
              })}
            />
          ) : null}
          <KeyValue
            label={t("In-game plugin")}
            value={
              live.schema === null || live.schema === undefined
                ? t("did not report a version")
                : `${t("format {schema}", { schema: live.schema })}${
                    live.asi_current === false
                      ? t(" · older than the one shipped here")
                      : live.asi_current
                        ? t(" · current")
                        : ""
                  }`
            }
          />
          {rates && !rates.generating ? (
            <KeyValue
              label={t("Frame generation")}
              value={t("on, but no frames are being generated")}
            />
          ) : null}
        </>
      ) : (
        <>
          <KeyValue label={t("Upscaler")} value={upscalerName} />
          {live.pending_backend ? (
            <KeyValue
              label={t("Switching to")}
              value={UPSCALER_LABELS[live.pending_backend] ?? live.pending_backend}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

export function LiveStats({ live }: { live: LiveStatus | null }) {
  const { t } = useI18n();
  if (!hasVerifiedLiveRuntime(live) || !live) return null;
  return (
    <PanelSection title={t("In-game now")}>
      <PanelSectionRow>
        <LiveTelemetryList live={live} />
      </PanelSectionRow>
    </PanelSection>
  );
}
