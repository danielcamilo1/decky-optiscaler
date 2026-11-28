import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useState } from "react";
import {
  getFsr4Info,
  importFsr4Files,
  restoreFsr4Build,
  setFsr4Build,
  verifyInstall,
} from "../api";
import { isPriorCommunityLiteBuild, STEAM_DECK_FSR4_BUILD_ID } from "../config/basic";
import { useI18n } from "../i18n";
import type { Fsr4Build, Fsr4Source, GpuInfo, VerifyResult } from "../types";
import { shortenPath } from "../utils/format";
import { KeyValue, Mono, Notice, Pill } from "./Common";
import { BADGE_COLORS } from "./setup/helpers";

interface Props {
  targetDir: string;
  sources: Fsr4Source[];
  gpu: GpuInfo | undefined;
  running?: boolean;
  readOnly?: boolean;
  onBeforeMutation?: () => Promise<void> | void;
  onChanged: () => Promise<void> | void;
}

const GPU_NOTE: Record<string, string> = {
  native: "This GPU runs FSR 4 natively.",
  int8: "This GPU runs FSR 4 through the INT8 model.",
  experimental: "Official 4.1.2 includes RDNA2/APU models — verify in game.",
  unsupported: "May require a forced model; verify the in-game watermark.",
  unknown: "Could not identify this GPU from sysfs.",
};

/**
 * Reports what actually landed in the game folder.
 *
 * FSR 4 comes from the bundled FidelityFX SDK (amd_fidelityfx_upscaler_dx12.dll),
 * so the useful question is whether that file is really there and which version
 * it is — not whether some extra download is missing.
 */
export function Fsr4Panel({
  targetDir,
  sources,
  gpu,
  running = false,
  readOnly = false,
  onBeforeMutation,
  onChanged,
}: Props) {
  const { t } = useI18n();
  const [report, setReport] = useState<VerifyResult | null>(null);
  const [build, setBuild] = useState<Fsr4Build | null>(null);
  const [busy, setBusy] = useState(false);

  const verify = useCallback(async () => {
    try {
      setReport(await verifyInstall(targetDir));
      setBuild((await getFsr4Info(targetDir)).status.build ?? null);
    } catch (exc) {
      toaster.toast({ title: t("Verification failed"), body: String(exc) });
    }
  }, [targetDir, t]);

  useEffect(() => {
    void verify();
  }, [verify]);

  const ffx = report?.ffx_upscaler;
  const problems = report?.problems ?? [];
  const dllActionsDisabled = Boolean(busy || readOnly || running);
  const isLiteBuild =
    build?.id === STEAM_DECK_FSR4_BUILD_ID || isPriorCommunityLiteBuild(build?.id);

  return (
    <PanelSection title={t("Installed Files & FSR 4")}>
      <PanelSectionRow>
        <div style={{ padding: "2px 0" }}>
          <div style={{ marginBottom: "6px" }}>
            {report?.complete ? (
              <Pill color={BADGE_COLORS.success}>{t("all files installed")}</Pill>
            ) : report ? (
              <Pill color={BADGE_COLORS.warn}>
                {t("{count} problem(s)", { count: problems.length })}
              </Pill>
            ) : (
              <Pill>{t("checking…")}</Pill>
            )}
            {gpu?.generation ? <Pill>{gpu.generation}</Pill> : null}
          </div>
          <KeyValue label={t("Upscaler build")} value={build?.label ?? t("Unknown")} />
          <KeyValue
            label={<Mono>amd_fidelityfx_upscaler_dx12.dll</Mono>}
            value={ffx?.present ? `v${ffx.version ?? "?"}` : t("missing")}
          />
          <KeyValue
            label={t("FSR 4 available from it")}
            value={ffx?.fsr4_capable ? t("yes") : t("no")}
          />
        </div>
      </PanelSectionRow>

      {isLiteBuild ? (
        <PanelSectionRow>
          <Notice tone="info" title={t("Community Lite (experimental)")}>
            {t(
              "4.1.2 Lite DLL (reports 4.1.1 version; verify 4.1.2l-exact in overlay). Close the game and use the buttons below to switch DLLs. Selecting a settings preset alone does not restore this DLL.",
            )}
          </Notice>
        </PanelSectionRow>
      ) : ffx?.fsr4_capable && build?.id === "bundled" ? (
        <PanelSectionRow>
          <Notice tone="success" title={t("FSR 4 is present")}>
            {t(
              "Official FSR 4.1.2 is bundled. Pick FSR 3.X/4 in Basic settings and verify the in-game watermark (community Lite preset swaps this DLL only when chosen).",
            )}
          </Notice>
        </PanelSectionRow>
      ) : ffx?.fsr4_capable && build?.known && build.id !== "bundled" ? (
        <PanelSectionRow>
          <Notice tone="info" title={t("Return to official FSR 4.1.2")}>
            {t(
              "Close the game, click Restore bundled upscaler below, then pick FSR 3.X/4. Selecting a settings preset alone does not restore this DLL.",
            )}
          </Notice>
        </PanelSectionRow>
      ) : null}

      {problems.length > 0 ? (
        <PanelSectionRow>
          <Notice tone="warn" title={t("Some files did not install cleanly")}>
            {t("{problems}. Re-enable your FSR 4 build, restore the bundled DLL, or reinstall.", {
              problems: problems.join(", "),
            })}
          </Notice>
        </PanelSectionRow>
      ) : null}

      {gpu?.fsr4 ? (
        <PanelSectionRow>
          <Notice tone={gpu.fsr4 === "unsupported" ? "warn" : "info"} title={t("This device")}>
            {gpu.name ? `${gpu.name}. ` : ""}
            {t(GPU_NOTE[gpu.fsr4] ?? GPU_NOTE.unknown)}
          </Notice>
        </PanelSectionRow>
      ) : null}

      {build?.known && build.id !== "bundled" ? (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={dllActionsDisabled}
            description={
              running
                ? t("Close the game first.")
                : t("Close the game first. Keeps upscaler and FG settings.")
            }
            onClick={async () => {
              if (running || readOnly) return;
              setBusy(true);
              try {
                await onBeforeMutation?.();
                const result = await restoreFsr4Build(targetDir);
                if (!result.ok) throw new Error(result.error);
                toaster.toast({
                  title: t("Bundled upscaler restored"),
                  body: t("Official FSR 4.1.2 DLL is back in place."),
                });
                await onChanged();
                await verify();
              } catch (error) {
                toaster.toast({
                  title: t("Could not restore bundled upscaler"),
                  body: String(error),
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("Restore bundled upscaler")}
          </ButtonItem>
        </PanelSectionRow>
      ) : null}

      {isLiteBuild ? (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={dllActionsDisabled}
            description={
              running
                ? t("Close the game first.")
                : t("Fallback build. Close the game first; keeps FG settings.")
            }
            onClick={async () => {
              if (running || readOnly) return;
              setBusy(true);
              try {
                await onBeforeMutation?.();
                const result = await setFsr4Build(targetDir, "4.1.1b");
                if (!result.ok) throw new Error(result.error);
                toaster.toast({
                  title: t("Legacy upscaler installed"),
                  body: t("FSR 4.1.1b DLL is now in place."),
                });
                await onChanged();
                await verify();
              } catch (error) {
                toaster.toast({
                  title: t("Could not restore legacy upscaler"),
                  body: String(error),
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("Use legacy 4.1.1b")}
          </ButtonItem>
        </PanelSectionRow>
      ) : null}

      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy} onClick={() => void verify()}>
          {t("Re-check installed files")}
        </ButtonItem>
      </PanelSectionRow>

      {sources.length > 0 ? (
        <>
          <PanelSectionRow>
            <Notice tone="info" title={t("Optional: driver FSR 4")}>
              {t(
                "Import AMD's amdxcffx64.dll from a local driver folder instead of the bundled SDK:",
              )}
            </Notice>
          </PanelSectionRow>
          {sources.map((source) => (
            <PanelSectionRow key={source.path}>
              <ButtonItem
                layout="below"
                disabled={dllActionsDisabled}
                description={running ? t("Close the game first.") : source.files.join(", ")}
                onClick={async () => {
                  if (running || readOnly) return;
                  setBusy(true);
                  try {
                    await onBeforeMutation?.();
                    const result = await importFsr4Files(targetDir, source.path);
                    if (result.ok) {
                      toaster.toast({
                        title: t("Copied into game folder"),
                        body: source.files.join(", "),
                      });
                      await onChanged();
                      await verify();
                    } else {
                      toaster.toast({ title: t("Copy failed"), body: String(result.error) });
                    }
                  } catch (exc) {
                    toaster.toast({ title: t("Copy failed"), body: String(exc) });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {shortenPath(source.path)}
              </ButtonItem>
            </PanelSectionRow>
          ))}
        </>
      ) : null}
    </PanelSection>
  );
}
