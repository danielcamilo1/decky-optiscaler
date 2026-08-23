import { ConfirmModal, DropdownItem, ToggleField } from "@decky/ui";
import { useState } from "react";
import { launchChoices, resolveChoice } from "../launchOptions";
import type { LaunchAction, LaunchState } from "../launchOptions";
import { Mono, Notice } from "./Common";

/**
 * The question removing OptiScaler has always had and never asked.
 *
 * Installing writes a `WINEDLLOVERRIDES` entry into Steam; removing used to
 * clear it, but only when the plugin could still read the field, and never
 * considered that the game might have had launch options of its own first —
 * which it then destroyed. Both halves are now decisions rather than side
 * effects, and the choice is made from what was actually recorded at install
 * time: "put back what was there" is only offered when there was something.
 *
 * The answer can be remembered, because most people set every game up the same
 * way and being asked each time is the same nag twice. A remembered answer is
 * shown here rather than applied invisibly, and the Settings tab is where it is
 * taken back.
 */
export function RemovePrompt({
  gameName,
  filename,
  backedUp,
  launch,
  remembered,
  canRemember,
  closeModal,
  onConfirm,
}: Readonly<{
  gameName: string;
  filename: string | null;
  backedUp: number;
  /** Null when this game has no launch options to decide about at all. */
  launch: LaunchState | null;
  remembered: LaunchAction | null;
  canRemember: boolean;
  closeModal?: () => void;
  onConfirm: (action: LaunchAction, remember: boolean) => void;
}>) {
  const choices = launch ? launchChoices(launch) : [];
  const asked = choices.filter((choice) => choice.action !== "keep").length > 0;
  const initial = resolveChoice(choices, remembered);
  const [action, setAction] = useState<LaunchAction>(initial?.action ?? "keep");
  const [remember, setRemember] = useState(false);
  const chosen = choices.find((choice) => choice.action === action) ?? initial;

  return (
    <ConfirmModal
      strTitle="Remove OptiScaler?"
      strOKButtonText="Remove"
      strCancelButtonText="Keep it"
      closeModal={closeModal}
      onOK={() => onConfirm(action, remember)}
    >
      <div style={{ fontSize: "14px", lineHeight: 1.5 }}>
        {backedUp > 0
          ? `The ${backedUp} file${backedUp === 1 ? "" : "s"} it set aside in ${gameName} are put
             back, and its settings are removed.`
          : `Its files and settings are removed from ${gameName}'s folder.`}
        {filename ? (
          <>
            {" "}
            <Mono>{filename}</Mono> goes with them.
          </>
        ) : null}
      </div>

      {asked && remembered ? (
        <Notice tone="info" title="Steam launch options">
          {chosen?.label}. This is the answer you asked to be remembered — change it under
          Settings on the main page.
        </Notice>
      ) : null}

      {asked && !remembered ? (
        <>
          <DropdownItem
            label="Steam launch options"
            description={chosen?.description}
            rgOptions={choices.map((choice) => ({ data: choice.action, label: choice.label }))}
            selectedOption={action}
            bottomSeparator="none"
            onChange={(option: { data: LaunchAction }) => setAction(option.data)}
          />
          {canRemember ? (
            <ToggleField
              label="Remember my choice"
              description="Later removals do this without asking."
              checked={remember}
              bottomSeparator="none"
              onChange={setRemember}
            />
          ) : null}
        </>
      ) : null}

      {!asked ? (
        <div style={{ fontSize: "13px", opacity: 0.7, marginTop: "6px" }}>
          Steam has no launch options for this game to put back.
        </div>
      ) : null}
    </ConfirmModal>
  );
}
