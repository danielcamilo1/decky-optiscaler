import { PanelSection, PanelSectionRow } from "@decky/ui";
import { isConfirmedLiveResult, receiptAuthorizationChanged } from "../liveControl";
import type { LiveApplyResult, LiveStatus } from "../types";
import { Notice } from "./Common";

type Message = { tone: "info" | "warn" | "error" | "success"; title: string; detail?: string };

function outcome(result: LiveApplyResult, status: LiveStatus | null): Message {
  if (result.sent && result.session && status?.session && result.session !== status.session) {
    return { tone: "info", title: "Saved · previous game session" };
  }
  if (result.sent && status && (status.dir_matches === false || status.supported === false ||
      (status.state === "awaiting_config" && status.dir_verified !== true))) {
    return { tone: "warn", title: "Saved · live unavailable", detail: status.reason ?? undefined };
  }
  if (status && receiptAuthorizationChanged(result, status)) {
    return { tone: "warn", title: "Saved · live authorization changed" };
  }
  if (result.ack === "rejected") {
    return { tone: "error", title: "Saved · live request rejected", detail: result.error ?? result.reason };
  }
  if (isConfirmedLiveResult(result)) {
    const disconnected = !status || status.state === "disconnected";
    return {
      tone: disconnected ? "info" : (result.deferred?.length ?? 0) > 0 ? "warn" : "success",
      title: disconnected ? "Request accepted · disconnected"
        : (result.deferred?.length ?? 0) > 0 ? "Request accepted · some settings need restart"
          : "Sent to OptiScaler",
    };
  }
  if (result.sent && (!status || status.state === "disconnected")) {
    return { tone: "warn", title: "Saved · live disconnected" };
  }
  if (result.ack === "timeout") {
    return { tone: "warn", title: "Saved · live request unconfirmed", detail: result.error ?? result.reason };
  }
  if (result.sent && result.ack === "pending") {
    return { tone: "info", title: "Saved · waiting for OptiScaler" };
  }
  return {
    tone: "info", title: "Saved · restart required",
    detail: result.error ?? result.reason,
  };
}

export function LiveOutcome({ result, status, saving = false }: Readonly<{
  result: LiveApplyResult | null; status: LiveStatus | null; saving?: boolean;
}>) {
  if (!result && !saving) return null;
  const message: Message = saving
    ? { tone: "info", title: "Saving settings" }
    : outcome(result as LiveApplyResult, status);
  return (
    <PanelSection>
      <PanelSectionRow>
        <Notice tone={message.tone} title={message.title}>{message.detail}</Notice>
      </PanelSectionRow>
    </PanelSection>
  );
}
