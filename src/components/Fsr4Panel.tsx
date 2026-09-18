import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useState } from "react";
import { getFsr4Info, restoreFsr4Build, importFsr4Files, verifyInstall } from "../api";
import type { Fsr4Build, Fsr4Source, GpuInfo, VerifyResult } from "../types";
import { KeyValue, Mono, Notice, Pill } from "./Common";

interface Props {
  targetDir: string;
  sources: Fsr4Source[];
  gpu: GpuInfo | undefined;
  onChanged: () => Promise<void> | void;
}

const GPU_NOTE: Record<string, string> = {
  native: "This GPU runs FSR 4 natively.",
  int8: "This GPU can run FSR 4 through the INT8 model.",
  experimental: "Select FSR 4.1.1b — Steam Deck in Basic settings for experimental RDNA2 upscaling.",
  unsupported:
    "AMD supports FSR 4 on RDNA 3 and RDNA 4 only. RDNA 2 — which includes the Steam Deck — is not supported yet.",
  unknown: "Could not identify this GPU from sysfs.",
};

/**
 * Reports what actually landed in the game folder.
 *
 * FSR 4 comes from the bundled FidelityFX SDK (amd_fidelityfx_upscaler_dx12.dll),
 * so the useful question is whether that file is really there and which version
 * it is — not whether some extra download is missing.
 */
export function Fsr4Panel({ targetDir, sources, gpu, onChanged }: Props) {
  const [report, setReport] = useState<VerifyResult | null>(null);
  const [build, setBuild] = useState<Fsr4Build | null>(null);
  const [busy, setBusy] = useState(false);

  const verify = useCallback(async () => {
    try {
      setReport(await verifyInstall(targetDir));
      setBuild((await getFsr4Info(targetDir)).status.build ?? null);
    } catch (exc) {
      toaster.toast({ title: "Verification failed", body: String(exc) });
    }
  }, [targetDir]);

  useEffect(() => {
    void verify();
  }, [verify]);

  const ffx = report?.ffx_upscaler;
  const problems = report?.problems ?? [];

  return (
    <PanelSection title="Installed Files & FSR 4">
      <PanelSectionRow>
        <div style={{ padding: "2px 0" }}>
          <div style={{ marginBottom: "6px" }}>
            {report?.complete ? (
              <Pill color="#2f6b3f">all files installed</Pill>
            ) : report ? (
              <Pill color="#8a5a2b">{problems.length} problem(s)</Pill>
            ) : (
              <Pill>checking…</Pill>
            )}
            {gpu?.generation ? <Pill>{gpu.generation}</Pill> : null}
          </div>
          <KeyValue label="Upscaler build" value={build?.label ?? "Unknown"} />
          <KeyValue
            label={<Mono>amd_fidelityfx_upscaler_dx12.dll</Mono>}
            value={
              ffx?.present ? `v${ffx.version ?? "?"}` : "missing"
            }
          />
          <KeyValue
            label="FSR 4 available from it"
            value={ffx?.fsr4_capable ? "yes" : "no"}
          />
        </div>
      </PanelSectionRow>

      {ffx?.fsr4_capable ? (
        <PanelSectionRow>
          <Notice tone="success" title="FSR 4 is present">
            On Steam Deck, select <b>FSR 4.1.1b — Steam Deck</b> in Basic settings.
            This installs the community RDNA2 fix and enables INT8 upscaling.
          </Notice>
        </PanelSectionRow>
      ) : null}

      {problems.length > 0 ? (
        <PanelSectionRow>
          <Notice tone="warn" title="Some files did not install cleanly">
            {problems.join(", ")}. For a changed FSR 4 build, enable it again in Basic settings or restore the bundled upscaler. Reinstall to repair other files.
          </Notice>
        </PanelSectionRow>
      ) : null}

      {gpu?.fsr4 ? (
        <PanelSectionRow>
          <Notice tone={gpu.fsr4 === "unsupported" ? "warn" : "info"} title="This device">
            {gpu.name ? `${gpu.name}. ` : ""}
            {GPU_NOTE[gpu.fsr4] ?? GPU_NOTE.unknown}
          </Notice>
        </PanelSectionRow>
      ) : null}

      {build?.known && build.id !== "bundled" ? (
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={Boolean(busy)}
            description="Close the game first. Keeps your upscaler and frame generation settings."
            onClick={async () => {
              setBusy(true);
              try {
                const result = await restoreFsr4Build(targetDir);
                if (!result.ok) throw new Error(result.error);
                await onChanged();
                await verify();
              } catch (error) {
                toaster.toast({ title: "Could not restore bundled upscaler", body: String(error) });
              } finally { setBusy(false); }
            }}>
            Restore bundled upscaler
          </ButtonItem>
        </PanelSectionRow>
      ) : null}
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy} onClick={() => void verify()}>
          Re-check installed files
        </ButtonItem>
      </PanelSectionRow>

      {sources.length > 0 ? (
        <>
          <PanelSectionRow>
            <Notice tone="info" title="Optional: driver FSR 4">
              OptiScaler can also take FSR 4 from AMD's <Mono>amdxcffx64.dll</Mono> instead of
              the bundled SDK. Only needed if you want a specific driver build — found these
              on this device:
            </Notice>
          </PanelSectionRow>
          {sources.map((source) => (
            <PanelSectionRow key={source.path}>
              <ButtonItem
                layout="below"
                disabled={busy}
                description={source.files.join(", ")}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await importFsr4Files(targetDir, source.path);
                    if (result.ok) {
                      toaster.toast({ title: "Copied into game folder", body: source.files.join(", ") });
                      await onChanged();
                      await verify();
                    } else {
                      toaster.toast({ title: "Copy failed", body: String(result.error) });
                    }
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {shorten(source.path)}
              </ButtonItem>
            </PanelSectionRow>
          ))}
        </>
      ) : null}
    </PanelSection>
  );
}

function shorten(path: string, keep = 3) {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= keep ? path : `…/${parts.slice(-keep).join("/")}`;
}
