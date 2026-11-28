import { PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import { useCallback, useEffect, useState } from "react";
import { getOptipatcherStatus, installOptipatcher } from "../api";
import { useI18n } from "../i18n";
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
export function OptipatcherPanel({
  targetDir,
  running = false,
  readOnly = false,
  onBeforeMutation,
  onChanged,
}: {
  targetDir: string;
  running?: boolean;
  readOnly?: boolean;
  onBeforeMutation?: () => Promise<void> | void;
  onChanged?: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<OptipatcherStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getOptipatcherStatus(targetDir);
      setStatus(next);
      setError(null);
    } catch (exc) {
      setError(String(exc));
    }
  }, [targetDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!status) {
    if (!error) return null;
    return (
      <PanelSection title="OptiPatcher">
        <PanelSectionRow>
          <Notice tone="error" title={t("Could not check OptiPatcher")}>
            {error}
          </Notice>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const toggle = async (enabled: boolean) => {
    if (running || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await onBeforeMutation?.();
      const result = await installOptipatcher(targetDir, enabled);
      if (!result.ok) setError(result.error ?? t("Could not change OptiPatcher"));
      else await onChanged?.();
      await refresh();
    } catch (exc) {
      setError(String(exc));
    } finally {
      setBusy(false);
    }
  };

  const description = !status.available
    ? t("This build of the plugin does not bundle OptiPatcher.")
    : running
      ? t("Close the game first.")
      : readOnly
        ? t("Upgrade the OptiScaler runtime in Setup first.")
        : t("Exposes a supported game's DLSS and DLSS-FG inputs without GPU spoofing.");

  return (
    <PanelSection title="OptiPatcher">
      <PanelSectionRow>
        <ToggleField
          label={t("Install OptiPatcher")}
          description={description}
          checked={status.installed}
          disabled={busy || !status.available || running || readOnly}
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
        <Notice tone="info" title={status.installed ? t("Installed") : t("When to use it")}>
          {status.installed
            ? t("Overlay shows (OP) next to the title with Spoof OFF when active.")
            : t("Needed by some games (e.g. RDR2) for DLSS inputs without GPU spoofing; harmless elsewhere.")}{" "}
          {t("Build: {version}.", { version: status.version })}
        </Notice>
      </PanelSectionRow>
    </PanelSection>
  );
}
