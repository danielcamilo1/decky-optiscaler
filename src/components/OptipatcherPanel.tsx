import { PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import { useCallback, useEffect, useState } from "react";
import { getOptipatcherStatus, installOptipatcher } from "../api";
import type { OptipatcherStatus } from "../types";
import { Notice } from "./Common";

/**
 * OptiPatcher, added or removed after the fact.
 *
 * It is a separate ASI from the OptiScaler project that patches supported games
 * so their DLSS / DLSS-FG inputs are visible without spoofing the GPU through
 * DXGI. Games differ on whether they need it, so it stays opt-in rather than
 * being installed for everyone.
 */
export function OptipatcherPanel({ targetDir }: { targetDir: string }) {
  const [status, setStatus] = useState<OptipatcherStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getOptipatcherStatus(targetDir));
    } catch (exc) {
      setError(String(exc));
    }
  }, [targetDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!status) return null;

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await installOptipatcher(targetDir, enabled);
      if (!result.ok) setError(result.error ?? "Could not change OptiPatcher");
      await refresh();
    } catch (exc) {
      setError(String(exc));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelSection title="OptiPatcher">
      <PanelSectionRow>
        <ToggleField
          label="Install OptiPatcher"
          description={
            status.available
              ? "Exposes a supported game's DLSS and DLSS-FG inputs without GPU spoofing."
              : "This build of the plugin does not bundle OptiPatcher."
          }
          checked={status.installed}
          disabled={busy || !status.available}
          bottomSeparator="standard"
          onChange={(checked) => void toggle(checked)}
        />
      </PanelSectionRow>

      {error ? (
        <PanelSectionRow>
          <Notice tone="error">{error}</Notice>
        </PanelSectionRow>
      ) : null}

      <PanelSectionRow>
        <Notice tone="info" title={status.installed ? "Installed" : "When to use it"}>
          {status.installed
            ? "OptiScaler shows (OP) next to the game title in its overlay when a patch actually applied, and Spoof reads OFF."
            : "Some games — Red Dead Redemption 2 among them — need it before OptiScaler can use their DLSS inputs. It does nothing in games it has no patterns for."}{" "}
          Build: {status.version}.
        </Notice>
      </PanelSectionRow>
    </PanelSection>
  );
}
