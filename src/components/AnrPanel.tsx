import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useState } from "react";
import { getAnrStatus, installAnrFg, removeAnrFg } from "../api";
import type { AnrStatus } from "../types";
import { KeyValue, Notice, Pill } from "./Common";

interface Props {
  targetDir: string;
  running: boolean;
  readOnly?: boolean;
  onBeforeMutation?: () => Promise<void> | void;
  onChanged?: () => Promise<void> | void;
}

/**
 * Per-game setup for Apex Neural Rendering (ANR FG).
 *
 * ANR FG replaces NVIDIA DLSS Frame Generation through OptiScaler's
 * `FGNvngxReplacement` custom-provider hook. Because OptiScaler 0.9.5 does not
 * ship that hook yet, enabling ANR FG downloads the pinned ANR release package
 * on demand, swaps the game's OptiScaler proxy DLL to the pinned Apex build,
 * and pauses the 0.9.5 live-control bridge until ANR FG is disabled.
 */
export function AnrPanel({
  targetDir,
  running,
  readOnly = false,
  onBeforeMutation,
  onChanged,
}: Props) {
  const [status, setStatus] = useState<AnrStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getAnrStatus(targetDir));
    } catch (exc) {
      setError(String(exc));
    }
  }, [targetDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!status) return null;

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await onBeforeMutation?.();
      const result = await installAnrFg(targetDir);
      if (!result.ok) throw new Error(result.error ?? "Could not enable ANR FG");
      toaster.toast({
        title: "ANR FG enabled",
        body: `Installed ${status.pinned_version}. Enable DLSS Frame Generation in game.`,
      });
      await onChanged?.();
      await refresh();
    } catch (exc) {
      setError(String(exc));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      await onBeforeMutation?.();
      const result = await removeAnrFg(targetDir);
      if (!result.ok) throw new Error(result.error ?? "Could not disable ANR FG");
      toaster.toast({
        title: "ANR FG disabled",
        body: "Restored bundled OptiScaler 0.9.5.",
      });
      await onChanged?.();
      await refresh();
    } catch (exc) {
      setError(String(exc));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelSection title="Apex Neural Rendering (ANR FG)">
      <PanelSectionRow>
        <div style={{ padding: "2px 0" }}>
          <div style={{ marginBottom: "6px" }}>
            {status.active ? (
              <Pill color="#2f6b3f">active · {status.version ?? status.pinned_version}</Pill>
            ) : status.installed ? (
              <Pill color="#8a5a2b">partial or unverified</Pill>
            ) : (
              <Pill>not installed</Pill>
            )}
          </div>
          <KeyValue label="Pinned release" value={status.pinned_version} />
          <KeyValue label="OptiScaler runtime" value={status.active ? `Apex (${status.optiscaler_commit})` : "Bundled 0.9.5"} />
        </div>
      </PanelSectionRow>

      {error ? (
        <PanelSectionRow>
          <Notice tone="error">{error}</Notice>
        </PanelSectionRow>
      ) : null}

      <PanelSectionRow>
        <Notice tone="info" title={status.active ? "How to use in game" : "Beta frame generation"}>
          {status.active
            ? "Enable NVIDIA DLSS Frame Generation in the game's settings — ANR FG takes its place. In-game live control is paused while ANR FG is active; disable ANR FG below to restore OptiScaler 0.9.5 and live control."
            : "Downloads the pinned ANR FG beta package from github.com/apex-compute/ANR, verifies its SHA-256 checksums, swaps this game's proxy DLL to Apex's OptiScaler build, and pauses 0.9.5 live control. For games with DLSS Frame Generation (D3D12 / Vulkan)."}
        </Notice>
      </PanelSectionRow>

      <PanelSectionRow>
        {status.active || status.installed ? (
          <ButtonItem
            layout="below"
            disabled={busy || running || !status.managed}
            description={
              running
                ? "Close the game first."
                : "Restores bundled OptiScaler 0.9.5, live control, and your previous FrameGen settings."
            }
            onClick={() => void disable()}
          >
            {busy ? "Restoring OptiScaler 0.9.5…" : "Disable ANR FG (restore OptiScaler 0.9.5)"}
          </ButtonItem>
        ) : (
          <ButtonItem
            layout="below"
            disabled={busy || running || readOnly || !status.managed}
            description={
              running
                ? "Close the game first."
                : readOnly
                  ? "Upgrade this game's OptiScaler runtime first."
                  : "Close the game first. Downloads ~11.7 MB once and caches it for other games."
            }
            onClick={() => void enable()}
          >
            {busy ? "Installing ANR FG…" : `Enable ANR FG (${status.pinned_version})`}
          </ButtonItem>
        )}
      </PanelSectionRow>
    </PanelSection>
  );
}
