import { PanelSection, PanelSectionRow } from "@decky/ui";
import type { ReactNode } from "react";
import { t as translate, useI18n } from "../i18n";
import { isConfirmedLiveResult, receiptAuthorizationChanged } from "../liveControl";
import type { LiveApplyResult, LiveStatus } from "../types";
import { Notice, TONE_BACKGROUNDS, TONE_COLORS } from "./Common";
import type { NoticeTone } from "./Common";

type Message = { tone: NoticeTone; title: string; detail?: string };

/** Keep protocol jargon out of player-facing save banners. */
function playerLiveDetail(raw?: string | null): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  if (
    /schema[-\s]*7|directory authorization|explicit\b.*\bcapability|verified session and capabilities/i.test(
      text,
    )
  ) {
    return translate("Takes effect the next time you start the game.");
  }
  return text;
}

function outcome(result: LiveApplyResult, status: LiveStatus | null): Message {
  if (result.sent && result.session && status?.session && result.session !== status.session) {
    return { tone: "info", title: translate("Saved · previous game session") };
  }
  if (
    result.sent &&
    status &&
    (status.dir_matches === false ||
      status.supported === false ||
      (status.state === "awaiting_config" && status.dir_verified !== true))
  ) {
    return {
      tone: "warn",
      title: translate("Saved · live control unavailable"),
      detail: playerLiveDetail(status.reason),
    };
  }
  if (status && receiptAuthorizationChanged(result, status)) {
    return { tone: "warn", title: translate("Saved · live session changed") };
  }
  if (result.ack === "rejected") {
    return {
      tone: "error",
      title: translate("Saved · game rejected live change"),
      detail: playerLiveDetail(result.error ?? result.reason),
    };
  }
  if (isConfirmedLiveResult(result)) {
    const disconnected = !status || status.state === "disconnected";
    return {
      tone: disconnected ? "info" : (result.deferred?.length ?? 0) > 0 ? "warn" : "success",
      title: disconnected
        ? translate("Applied · game disconnected")
        : (result.deferred?.length ?? 0) > 0
          ? translate("Applied · some settings need restart")
          : translate("Applied to running game"),
    };
  }
  if (result.sent && (!status || status.state === "disconnected")) {
    return { tone: "warn", title: translate("Saved · live control disconnected") };
  }
  if (result.ack === "timeout") {
    return {
      tone: "warn",
      title: translate("Saved · live change unconfirmed"),
      detail: playerLiveDetail(result.error ?? result.reason),
    };
  }
  if (result.sent && result.ack === "pending") {
    return { tone: "info", title: translate("Saved · waiting for game") };
  }
  return {
    tone: "info",
    title: translate("Saved · restart required"),
    detail: playerLiveDetail(result.error ?? result.reason),
  };
}

export function LiveOutcome({
  result,
  status,
  saving = false,
  inline = false,
  action,
}: Readonly<{
  result: LiveApplyResult | null;
  status: LiveStatus | null;
  saving?: boolean;
  inline?: boolean;
  action?: ReactNode;
}>) {
  const { t } = useI18n();
  if (!result && !saving) return null;
  const message: Message = saving
    ? { tone: "info", title: t("Saving settings…") }
    : outcome(result as LiveApplyResult, status);

  if (inline) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          margin: "0 12px 4px",
          padding: "5px 9px",
          borderLeft: `3px solid ${TONE_COLORS[message.tone]}`,
          background: TONE_BACKGROUNDS[message.tone],
          borderRadius: "3px",
          fontSize: "12px",
          flexShrink: 0,
        }}
      >
        <span style={{ flexGrow: 1, minWidth: 0 }}>
          <strong>{message.title}</strong>
          {message.detail ? <span style={{ opacity: 0.85 }}> — {message.detail}</span> : null}
        </span>
        {action}
      </div>
    );
  }

  return (
    <PanelSection>
      <PanelSectionRow>
        <Notice tone={message.tone} title={message.title}>
          {message.detail}
        </Notice>
      </PanelSectionRow>
    </PanelSection>
  );
}
