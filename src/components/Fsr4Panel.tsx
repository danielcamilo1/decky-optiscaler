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
import type {
  Fsr4Build,
  Fsr4BuildOption,
  Fsr4Source,
  GpuInfo,
  VerifyResult,
} from "../types";
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
  experimental:
    "FSR 4 runs here through the forced INT8 model. Turn on FSR 4 INT8 (experimental) in Basic settings, restart the game, and check the overlay's FSR watermark — FSR4-I8 means the INT8 model ran, plain FSR3 means OptiScaler fell back. Performance and stability vary by game.",
  unsupported:
    "AMD does not support FSR 4 on this device. The INT8 override under Advanced is the only route OptiScaler offers for it.",
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
  const [build, setBuild] = useState<Fsr4Build | null | undefined>(undefined);
  const [builds, setBuilds] = useState<Fsr4BuildOption[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const verify = useCallback(async () => {
    try {
      setReport(await verifyInstall(targetDir));
    } catch (exc) {
      toaster.toast({ title: "Verification failed", body: String(exc) });
    }
    try {
      const info = await getFsr4Info(targetDir);
      setBuild(info.status?.build ?? null);
      setBuilds(info.builds ?? []);
    } catch (exc) {
      toaster.toast({ title: "Could not read the FSR 4 build", body: String(exc) });
    }
  }, [targetDir]);

  useEffect(() => {
    void verify();
  }, [verify]);

  const useBuild = useCallback(
    async (option: Fsr4BuildOption) => {
      setBusy(option.id);
      try {
        const result = await setFsr4Build(targetDir, option.id);
        if (result.ok) {
          toaster.toast({
            title: `FSR 4 ${option.label} installed`,
            body: "Takes effect on the next launch of the game.",
          });
          await onChanged();
          await verify();
        } else {
          toaster.toast({ title: "Download failed", body: String(result.error) });
        }
      } finally {
        setBusy(null);
      }
    },
    [targetDir, onChanged, verify]
  );

  const useBundled = useCallback(async () => {
    setBusy("bundled");
    try {
      const result = await restoreFsr4Build(targetDir);
      if (result.ok) {
        toaster.toast({
          title: "Bundled FSR 4 restored",
          body: "The build OptiScaler ships is back in the game folder.",
        });
        await onChanged();
        await verify();
      } else {
        toaster.toast({ title: "Could not restore", body: String(result.error) });
      }
    } finally {
      setBusy(null);
    }
  }, [targetDir, onChanged, verify]);

  const ffx = report?.ffx_upscaler;
  const problems = report?.problems ?? [];
  const swapped = Boolean(build && build.id && build.id !== "bundled");
  const unrecognised = Boolean(build && !build.known);

  return (
    <>
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
          {build !== undefined ? (
            <KeyValue
              label="Which build"
              value={build?.label ?? "no upscaler in this folder"}
            />
          ) : null}
          {build?.sha256 ? (
            <KeyValue label="Its hash" value={<Mono>{build.sha256.slice(0, 16)}…</Mono>} />
          ) : null}
        </div>
      </PanelSectionRow>

      {unrecognised ? (
        <PanelSectionRow>
          <Notice tone="warn" title="A build this plugin does not know">
            {build?.note} Its version says {ffx?.version ?? "nothing"} either way: the
            modelled 4.1.1b reports exactly what the released SDK reports, so the hash
            above is the only thing that tells them apart.
          </Notice>
        </PanelSectionRow>
      ) : null}

      {ffx?.fsr4_capable ? (
        <PanelSectionRow>
          <Notice tone="success" title="FSR 4 is present">
            The FidelityFX SDK bundled with OptiScaler is v{ffx.version}, which provides
            FSR 4. On Steam Deck / RDNA 2, select <b>FSR 4 INT8 (experimental)</b> in
            Basic settings and restart the game. The installed version alone does not
            confirm the active model; use the FSR watermark to check for fallback.
          </Notice>
        </PanelSectionRow>
      ) : null}

      {problems.length > 0 ? (
        <PanelSectionRow>
          <Notice tone="warn" title="Some files did not install cleanly">
            {problems.join(", ")}. Reinstall from the button above to replace them.
          </Notice>
        </PanelSectionRow>
      ) : null}

      {gpu?.fsr4 ? (
        <PanelSectionRow>
          <Notice tone={gpu.fsr4 === "unsupported" || gpu.fsr4 === "experimental" ? "warn" : "info"} title="This device">
            {gpu.name ? `${gpu.name}. ` : ""}
            {GPU_NOTE[gpu.fsr4] ?? GPU_NOTE.unknown}
          </Notice>
        </PanelSectionRow>
      ) : null}

      <PanelSectionRow>
        <ButtonItem layout="below" disabled={Boolean(busy)} onClick={() => void verify()}>
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
                disabled={Boolean(busy)}
                description={source.files.join(", ")}
                onClick={async () => {
                  setBusy(source.path);
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
                    setBusy(null);
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

    {/* OptiScaler's release carries AMD's 4.1.1 SDK build, which is what FSR 4
        runs on here through the INT8 override. What it is not is modelled for
        RDNA 2, and these are — this mirror is the one the OptiScaler Client takes
        its FSR 4 Swap versions from. Nothing is fetched until one is picked, and
        what is fetched is checked against the pinned hashes before it goes near
        the game folder. The version strings cannot tell these builds apart, so
        the hash and the release they came from are what get reported. */}
    <PanelSection title="FSR 4 upscaler build">
      {builds.map((option) => (
        <PanelSectionRow key={option.id}>
          <ButtonItem
            layout="below"
            disabled={Boolean(busy)}
            description={`${option.note} (${option.mb} MB from ${option.source}${
              option.cached ? ", already downloaded" : ""
            })`}
            onClick={() => void useBuild(option)}
          >
            {busy === option.id
              ? "Downloading…"
              : build?.id === option.id
                ? `In use: ${option.label}`
                : `Use ${option.label}`}
          </ButtonItem>
        </PanelSectionRow>
      ))}

      {swapped || unrecognised ? (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={Boolean(busy)}
            onClick={() => void useBundled()}
          >
            {busy === "bundled" ? "Restoring…" : "Restore the bundled build"}
          </ButtonItem>
        </PanelSectionRow>
      ) : null}

      {build?.reaches_fsr4_by === "upgrade" ? (
        <PanelSectionRow>
          <Notice tone="warn" title="This build reaches FSR 4 through the upgrade path">
            A 4.0.2 build is below the 4.1.1 that OptiScaler asks for before it will offer
            FSR 4 off the INT8 override, so what gets it running is <b>Fsr4Update</b> — the
            plain <b>FSR 3.X/4</b> preset in Basic settings. The INT8 preset does nothing
            with this build in place.
          </Notice>
        </PanelSectionRow>
      ) : null}

      <PanelSectionRow>
        <Notice tone="info" title="These builds are community work">
          Each package is one modified copy of <Mono>amd_fidelityfx_upscaler_dx12.dll</Mono>
          that replaces the released one in this game's folder — the same file, by the same
          instruction the releases themselves give ("just drop inside the game folder"). The
          archive is checked against the hash GitHub publishes for it and the DLL inside it
          against the hash this plugin pins, and the result is named above once it is in
          place. Restoring, reinstalling OptiScaler, or uninstalling it takes the released
          build back.
        </Notice>
      </PanelSectionRow>

      <PanelSectionRow>
        <Notice tone="warn" title="What these are, and are not">
          Modified game DLLs, redistributed by hand, so keep them away from anything with
          anti-cheat — the same warning the OptiScaler project and the people behind these
          builds publish with them. They are also not AMD's implementation: FSR 4 for RDNA 2
          is not official until AMD ships it, and how a build like this behaves will differ
          from game to game. Nothing here is downloaded until a build is picked.
        </Notice>
      </PanelSectionRow>
    </PanelSection>
    </>
  );
}

function shorten(path: string, keep = 3) {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= keep ? path : `…/${parts.slice(-keep).join("/")}`;
}
