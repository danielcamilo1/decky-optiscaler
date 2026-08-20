import {
  ConfirmModal,
  DialogButton,
  Field,
  Focusable,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  showModal,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useState } from "react";
import { FaCheck } from "react-icons/fa";
import {
  autoInstall,
  getMonitor,
  install,
  resetConfig,
  setAutoMode,
  setGameTarget,
  uninstall,
} from "../api";
import { readLaunchOptions, setLaunchOptions } from "../hooks/useRunningGame";
import type {
  AutoPlan,
  GameDetail,
  LiveStatus,
  MonitorReport,
  Recommendation,
} from "../types";
import { Mono, Notice, Pill } from "./Common";

/**
 * Setting a game up, as a checklist rather than a page of panels.
 *
 * Three things have to happen for OptiScaler to work: the DLL goes next to the
 * game's executable, Steam has to be told to load it instead of Proton's own,
 * and the settings the wiki names for this game have to reach the ini. The old
 * Setup tab had all three, spread over nine sections and a mode switch, and
 * nothing said what had been done. This says all three before they happen and
 * keeps saying them afterwards, which is the same list read twice.
 *
 * Only the first is compulsory: the launch options and the wiki's settings each
 * carry a toggle, before the install as a choice and after it as the way to
 * undo that step alone. Everything else — the file name, the folder,
 * OptiPatcher, FSR 4 files, picking a different wiki entry — is behind "Manual
 * setup", because it is a minority of set-ups and all of it has a default that
 * works.
 */
interface Props {
  detail: GameDetail;
  appid: string | null;
  plan: AutoPlan | null;
  recommendation: Recommendation | null;
  loadingWiki: boolean;
  auto: boolean;
  live: LiveStatus | null;
  /** Whether this game is the one running right now. */
  running: boolean;
  onSetAuto: (enabled: boolean) => Promise<void> | void;
  onManual: () => void;
  onLogs: () => void;
  onChanged: () => Promise<void> | void;
  onReloadPlan: () => Promise<void> | void;
  onResetConfig: () => Promise<void> | void;
}

/** The numbered circle before a step, or a tick once it is done. */
function Mark({ n, done }: Readonly<{ n?: number; done?: boolean }>) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "22px",
        height: "22px",
        borderRadius: "50%",
        marginRight: "9px",
        flexShrink: 0,
        fontSize: "11px",
        fontWeight: 700,
        background: done ? "#3e8a4a" : "transparent",
        border: done ? "none" : "1.5px solid rgba(255,255,255,0.3)",
        color: done ? "#fff" : "rgba(255,255,255,0.65)",
      }}
    >
      {done ? <FaCheck size={11} /> : n}
    </span>
  );
}

function StepLabel({ n, done, children }: Readonly<{
  n?: number;
  done?: boolean;
  children: React.ReactNode;
}>) {
  return (
    <span style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
      <Mark n={n} done={done} />
      <span style={{ minWidth: 0 }}>{children}</span>
    </span>
  );
}

function shorten(path: string, keep = 3) {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= keep ? path : `…/${parts.slice(-keep).join("/")}`;
}

/**
 * Why live control is not answering, in the same four cases the live panel
 * separates — each has a different fix, and "not connected" on its own sends
 * nobody anywhere.
 */
function liveReason(live: LiveStatus | null) {
  if (!live) return "Live control has not reported in yet.";
  if (!live.asi_installed) {
    return "The in-game plugin is not installed for this game. Add it under “Manual setup”.";
  }
  if (live.load_enabled === false) {
    return "OptiScaler is not set to load .asi plugins, so the in-game plugin never ran.";
  }
  if (live.loaded_by_optiscaler === false) {
    return "OptiScaler did not load the in-game plugin.";
  }
  return `OptiScaler loaded the in-game plugin, but it could not attach${
    live.error ? `: ${live.error}` : "."
  }`;
}

/** What the wiki asks to be written, as one readable line. */
function settingsSummary(plan: AutoPlan) {
  const pairs = plan.settings.map((item) => `${item.key}=${item.value}`);
  const fg =
    plan.framegen && plan.framegen.input !== "nofg"
      ? `frame generation through ${plan.framegen.input_label} → ${plan.framegen.output_label}`
      : null;
  return [pairs.join(", "), fg].filter(Boolean).join(", plus ");
}

export function SetupChecklist({
  detail,
  appid,
  plan,
  recommendation,
  loadingWiki,
  auto,
  live,
  running,
  onSetAuto,
  onManual,
  onLogs,
  onChanged,
  onReloadPlan,
  onResetConfig,
}: Readonly<Props>) {
  const installed = Boolean(detail.install.installed);
  const planned = plan?.available ? plan : null;
  const filename = detail.install.filename ?? planned?.filename ?? "dxgi.dll";
  // An .asi build is loaded by an ASI loader, so Proton has nothing to shadow
  // and there is no override to set.
  const needsOverride = !filename.toLowerCase().endsWith(".asi");
  const launchWanted = planned?.launch_options ?? `WINEDLLOVERRIDES="${filename.replace(/\.dll$/i, "")}=n,b" %command%`;

  const [withLaunch, setWithLaunch] = useState(true);
  const [withSettings, setWithSettings] = useState(true);
  const [busy, setBusy] = useState(false);
  /** Steam's current launch options, or null when the client will not say. */
  const [launchNow, setLaunchNow] = useState<string | null>(null);
  const [launchReadable, setLaunchReadable] = useState(false);
  const [report, setReport] = useState<MonitorReport | null>(null);

  const refreshLaunch = useCallback(async () => {
    if (!appid) {
      setLaunchReadable(false);
      return;
    }
    const value = await readLaunchOptions(Number(appid));
    setLaunchNow(value);
    setLaunchReadable(value !== null);
  }, [appid]);

  useEffect(() => {
    void refreshLaunch();
  }, [refreshLaunch]);

  useEffect(() => {
    if (!installed) return;
    void (async () => {
      try {
        setReport(await getMonitor(detail.install.path));
      } catch {
        /* the log is optional; the row falls back to what it knows */
      }
    })();
  }, [installed, detail.install.path]);

  const overrideSet =
    launchNow !== null &&
    launchNow.toLowerCase().includes(`${filename.replace(/\.dll$/i, "").toLowerCase()}=n,b`);

  const applyLaunchOptions = (value: string) => {
    if (!appid) return;
    if (setLaunchOptions(Number(appid), value)) {
      void refreshLaunch();
      toaster.toast({
        title: value ? "Launch options set" : "Launch options cleared",
        body: value || detail.name,
      });
    } else {
      toaster.toast({
        title: "Could not reach Steam",
        body: "Set the launch options manually.",
      });
    }
  };

  /** Step 1, plus whichever of steps 2 and 3 are switched on. */
  const run = async () => {
    if (!planned) return;
    setBusy(true);
    try {
      const folder = detail.path.split("/").filter(Boolean).pop() ?? detail.name;
      if (withSettings) {
        const result = await autoInstall(detail.target, detail.path, detail.name, [folder]);
        if (!result.ok) {
          toaster.toast({ title: "Setup failed", body: String(result.error) });
          return;
        }
      } else {
        const result = await install(detail.target, planned.filename, false, planned.optipatcher);
        if (!result.ok) {
          toaster.toast({ title: "Install failed", body: String(result.error) });
          return;
        }
        await setGameTarget(detail.path, detail.target);
        // Nothing is following the wiki, so every option stays the user's.
        await setAutoMode(detail.path, false);
      }
      if (withLaunch && appid && needsOverride) {
        setLaunchOptions(Number(appid), planned.launch_options);
      }
      toaster.toast({
        title: `${detail.name} is set up`,
        body: `Installed as ${planned.filename}.`,
      });
      await onChanged();
      await onReloadPlan();
      await refreshLaunch();
    } finally {
      setBusy(false);
    }
  };

  const reapply = async () => {
    if (!planned) return;
    setBusy(true);
    try {
      const folder = detail.path.split("/").filter(Boolean).pop() ?? detail.name;
      const result = await autoInstall(detail.target, detail.path, detail.name, [folder]);
      if (result.ok) {
        toaster.toast({ title: "Set up again from the wiki", body: planned.game ?? detail.name });
        await onChanged();
        await onReloadPlan();
      } else {
        toaster.toast({ title: "Could not re-apply", body: String(result.error) });
      }
    } finally {
      setBusy(false);
    }
  };

  const doUninstall = async () => {
    setBusy(true);
    try {
      const result = await uninstall(detail.install.path, true);
      if (result.ok) {
        toaster.toast({ title: "OptiScaler removed", body: detail.name });
        if (appid && overrideSet) setLaunchOptions(Number(appid), "");
        await onChanged();
        await refreshLaunch();
      } else {
        toaster.toast({ title: "Uninstall failed", body: String(result.error) });
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmUninstall = () =>
    showModal(
      <ConfirmModal
        strTitle="Remove OptiScaler?"
        strOKButtonText="Remove"
        strCancelButtonText="Keep it"
        onOK={() => void doUninstall()}
      >
        <div style={{ fontSize: "14px", lineHeight: 1.5 }}>
          {detail.install.backed_up.length > 0
            ? `The ${detail.install.backed_up.length} file${
                detail.install.backed_up.length === 1 ? "" : "s"
              } it set aside are put back, and its settings are removed.`
            : "Its files and settings are removed from this game's folder."}
          {overrideSet ? " The Steam launch options are cleared too." : ""}
        </div>
      </ConfirmModal>
    );

  const doReset = async () => {
    setBusy(true);
    try {
      const result = await resetConfig(detail.install.path);
      if (result.ok) {
        await onResetConfig();
        toaster.toast({ title: "Config reset", body: "Stock OptiScaler.ini restored." });
      } else {
        toaster.toast({ title: "Reset failed", body: String(result.error) });
      }
    } finally {
      setBusy(false);
    }
  };

  // -- what the log row has to say -----------------------------------------
  const problems = report?.problems?.length ?? 0;
  const logSummary = !report?.log_present
    ? "No log yet. Turn logging on here and launch the game once."
    : problems > 0
      ? `${problems} warning${problems === 1 ? "" : "s"} or error${
          problems === 1 ? "" : "s"
        } in the log.`
      : "Nothing wrong in the log.";
  const logPill = !report?.log_present ? (
    <Pill>no log yet</Pill>
  ) : problems > 0 ? (
    <Pill color="#5a4a20">{problems}</Pill>
  ) : (
    <Pill color="#2f6b3f">no problems</Pill>
  );

  const foldRows = (
    <PanelSection>
      <PanelSectionRow>
        <Field
          label="Manual setup"
          description="File name, folder, OptiPatcher, FSR 4 files, launch options."
          onClick={onManual}
          onActivate={onManual}
          focusable
          bottomSeparator="standard"
          childrenLayout="inline"
          childrenContainerWidth="min"
        >
          <span style={{ opacity: 0.5 }}>›</span>
        </Field>
      </PanelSectionRow>
      <PanelSectionRow>
        <Field
          label="Logs"
          // What the log says once there is one: that sentence used to be on
          // the "Not running" row, which was never a step of setting a game up.
          description={
            installed
              ? logSummary
              : "What OptiScaler loaded, the GPU it found, and any errors."
          }
          onClick={onLogs}
          onActivate={onLogs}
          focusable
          bottomSeparator="standard"
          childrenLayout="inline"
          childrenContainerWidth="min"
        >
          {installed ? logPill : <Pill>no log yet</Pill>}
        </Field>
      </PanelSectionRow>
    </PanelSection>
  );

  // -- not set up yet -------------------------------------------------------
  if (!installed) {
    const steps = 1 + (planned && needsOverride && appid && withLaunch ? 1 : 0) +
      (planned && withSettings ? 1 : 0);
    const runLabel = busy
      ? "Setting up…"
      : steps === 3
        ? "Do all three"
        : steps === 2
          ? "Do both"
          : "Just install it";

    return (
      <>
        <PanelSection title={detail.name}>
          <PanelSectionRow>
            {loadingWiki ? (
              <Notice tone="info">Checking the OptiScaler wiki…</Notice>
            ) : planned ? (
              <Notice tone="success" title="This game can be set up automatically">
                Matched “{planned.game}” on the OptiScaler wiki
                {recommendation?.compatibility
                  ? ` — reported ${recommendation.compatibility}`
                  : ""}
                .
              </Notice>
            ) : (
              <Notice tone="warn" title="No wiki entry matched this game">
                OptiScaler still works with most DLSS, FSR 2+ and XeSS games. Set it up by hand —
                <Mono>dxgi.dll</Mono> is the usual choice — or find this game in the wiki list
                yourself.
              </Notice>
            )}
          </PanelSectionRow>
          {!planned && !loadingWiki ? (
            <PanelSectionRow>
              <Focusable style={{ display: "flex" }}>
                <DialogButton
                  onClick={onManual}
                  onOKActionDescription="Set this game up by hand"
                  style={{ flexGrow: 1 }}
                >
                  Manual setup
                </DialogButton>
              </Focusable>
            </PanelSectionRow>
          ) : null}
        </PanelSection>

        {planned ? (
          <PanelSection>
            <PanelSectionRow>
              <Field
                label={<StepLabel n={1}>Install OptiScaler as <Mono>{planned.filename}</Mono></StepLabel>}
                description={`Into ${shorten(detail.target)}, next to the executable that renders the game.`}
                bottomSeparator="standard"
                childrenLayout="inline"
                childrenContainerWidth="min"
              >
                <span style={{ fontSize: "11px", opacity: 0.5 }}>required</span>
              </Field>
            </PanelSectionRow>

            {needsOverride && appid ? (
              <PanelSectionRow>
                <ToggleField
                  label={<StepLabel n={2}>Set the Steam launch options</StepLabel>}
                  description={`${planned.launch_options} — without it Proton loads its own ${planned.filename}.`}
                  checked={withLaunch}
                  disabled={busy}
                  bottomSeparator="standard"
                  onChange={setWithLaunch}
                />
              </PanelSectionRow>
            ) : null}

            {!appid && needsOverride ? (
              <PanelSectionRow>
                <Notice tone="warn" title="Set the launch options yourself">
                  This game came from a custom folder rather than Steam, so nothing here can set
                  them. Add <Mono>{planned.launch_options}</Mono> in whichever launcher starts it.
                </Notice>
              </PanelSectionRow>
            ) : null}

            <PanelSectionRow>
              <ToggleField
                label={
                  <StepLabel n={needsOverride && appid ? 3 : 2}>
                    {planned.settings.length > 0
                      ? `Apply the ${planned.settings.length} setting${
                          planned.settings.length === 1 ? "" : "s"
                        } the entry asks for`
                      : "Follow this game's wiki entry"}
                  </StepLabel>
                }
                description={
                  settingsSummary(planned) ||
                  "This entry needs no special settings, but keeping it on means later wiki changes reach this game."
                }
                checked={withSettings}
                disabled={busy}
                bottomSeparator="standard"
                onChange={setWithSettings}
              />
            </PanelSectionRow>

            {!detail.writable ? (
              <PanelSectionRow>
                <Notice tone="error" title="Folder is not writable">
                  <Mono>{shorten(detail.target)}</Mono>
                </Notice>
              </PanelSectionRow>
            ) : null}

            <PanelSectionRow>
              <Focusable style={{ display: "flex" }}>
                <DialogButton
                  disabled={busy || !detail.writable}
                  onClick={() => void run()}
                  onOKActionDescription="Set this game up"
                  style={{ flexGrow: 1 }}
                >
                  {runLabel}
                </DialogButton>
              </Focusable>
            </PanelSectionRow>
          </PanelSection>
        ) : null}

        {foldRows}

        <PanelSection>
          <PanelSectionRow>
            <Focusable
              focusWithinClassName="gpfocuswithin"
              style={{ fontSize: "12px", opacity: 0.6, padding: "4px 0", lineHeight: 1.45 }}
            >
              Nothing gets lost: any file OptiScaler replaces is set aside and put back when you
              remove it.
            </Focusable>
          </PanelSectionRow>
        </PanelSection>
      </>
    );
  }

  // -- already set up -------------------------------------------------------
  const backedUp = detail.install.backed_up.length;
  return (
    <>
      <PanelSection title={detail.name}>
        <PanelSectionRow>
          <Field
            label={<StepLabel done>Installed as <Mono>{detail.install.filename}</Mono></StepLabel>}
            description={[
              detail.install.version ?? "unknown build",
              backedUp > 0 ? `${backedUp} file${backedUp === 1 ? "" : "s"} set aside` : null,
              detail.install.managed ? "managed by this plugin" : "installed externally",
            ]
              .filter(Boolean)
              .join(" · ")}
            onClick={onManual}
            onActivate={onManual}
            focusable
            bottomSeparator="standard"
            childrenLayout="inline"
            childrenContainerWidth="min"
          >
            <Pill>change</Pill>
          </Field>
        </PanelSectionRow>

        {needsOverride && appid ? (
          launchReadable ? (
            <PanelSectionRow>
              <ToggleField
                label={
                  <StepLabel done={overrideSet}>
                    {overrideSet ? "Launch options set" : "Launch options not set"}
                  </StepLabel>
                }
                description={
                  overrideSet
                    ? launchNow ?? launchWanted
                    : `Without ${launchWanted} Proton loads its own ${detail.install.filename}.`
                }
                checked={overrideSet}
                disabled={busy}
                bottomSeparator="standard"
                onChange={(checked) => applyLaunchOptions(checked ? launchWanted : "")}
              />
            </PanelSectionRow>
          ) : (
            <PanelSectionRow>
              <Field
                label={<StepLabel>Steam launch options</StepLabel>}
                description={`Steam did not report this game's launch options, so they cannot be
                  checked from here. Setting them again is harmless.`}
                onClick={() => applyLaunchOptions(launchWanted)}
                onActivate={() => applyLaunchOptions(launchWanted)}
                focusable
                bottomSeparator="standard"
                childrenLayout="inline"
                childrenContainerWidth="min"
              >
                <Pill>set them</Pill>
              </Field>
            </PanelSectionRow>
          )
        ) : null}

        {!planned && !loadingWiki ? (
          <PanelSectionRow>
            <Field
              label={<StepLabel>No wiki entry matched this game</StepLabel>}
              description="Nothing is being kept up to date for it. Pick an entry yourself under “Manual setup”, or leave the settings to you."
              onClick={onManual}
              onActivate={onManual}
              focusable
              bottomSeparator="standard"
              childrenLayout="inline"
              childrenContainerWidth="min"
            >
              <span style={{ opacity: 0.5 }}>›</span>
            </Field>
          </PanelSectionRow>
        ) : null}

        {planned ? (
          <PanelSectionRow>
            <ToggleField
              label={
                <StepLabel done={auto}>
                  {auto ? "Following the wiki entry" : "Not following the wiki entry"}
                </StepLabel>
              }
              description={
                auto
                  ? `${settingsSummary(planned) || "No special settings"} — kept up to date.`
                  : "Every option is yours. Turn this on to let the wiki keep the ones this game needs."
              }
              checked={auto}
              disabled={busy}
              bottomSeparator="standard"
              onChange={(checked) => void onSetAuto(checked)}
            />
          </PanelSectionRow>
        ) : null}

        {/* Only while this game is up. "Not running" was being listed as the
            last step of setting a game up, which it never was: nothing about it
            is a step, and a game sitting in the library is not half-configured
            for being closed. What the log had to say is one row down, under
            Logs, where it belongs whether or not the game is running. */}
        {running ? (
          <PanelSectionRow>
            <Field
              label={
                <StepLabel done={Boolean(live?.attached)}>
                  {live?.attached ? "Running now" : "Running, without live control"}
                </StepLabel>
              }
              description={
                live?.attached ? `Live control connected. ${logSummary}` : liveReason(live)
              }
              onClick={onLogs}
              onActivate={onLogs}
              focusable
              bottomSeparator="standard"
              childrenLayout="inline"
              childrenContainerWidth="min"
            >
              {logPill}
            </Field>
          </PanelSectionRow>
        ) : null}
      </PanelSection>

      {foldRows}

      <PanelSection>
        <PanelSectionRow>
          {/* One row rather than three stacked buttons: on a handheld the
              things you rarely do should not each cost a screenful, and
              removing has to stay reachable without hunting for it. */}
          <Focusable style={{ display: "flex", gap: "8px" }} flow-children="horizontal">
            {planned ? (
              <DialogButton
                disabled={busy}
                onClick={() => void reapply()}
                onOKActionDescription="Set up again from the wiki"
                style={{ flex: "1 1 0", minWidth: 0, fontSize: "13px", padding: "8px 6px" }}
              >
                Set up again
              </DialogButton>
            ) : null}
            <DialogButton
              disabled={busy}
              onClick={() => void doReset()}
              onOKActionDescription="Reset settings to stock"
              style={{ flex: "1 1 0", minWidth: 0, fontSize: "13px", padding: "8px 6px" }}
            >
              Reset settings
            </DialogButton>
            <DialogButton
              disabled={busy}
              onClick={confirmUninstall}
              onOKActionDescription="Remove OptiScaler"
              style={{
                flex: "1 1 0",
                minWidth: 0,
                fontSize: "13px",
                padding: "8px 6px",
                color: "#ff9d9d",
              }}
            >
              Remove
            </DialogButton>
          </Focusable>
        </PanelSectionRow>
        <PanelSectionRow>
          <Focusable
            focusWithinClassName="gpfocuswithin"
            style={{ fontSize: "12px", opacity: 0.6, padding: "4px 0", lineHeight: 1.45 }}
          >
            {backedUp > 0
              ? `Removing puts back the ${backedUp} file${backedUp === 1 ? "" : "s"} it set aside.`
              : "Removing takes every file it installed back out."}
          </Focusable>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}
