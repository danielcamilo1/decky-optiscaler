import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { openFilePicker, toaster } from "@decky/api";
import { useCallback, useEffect, useState } from "react";
import { addCustomLibrary, listLibraries, removeCustomLibrary } from "../api";
import type { Library } from "../types";
import { Centered, Mono, Notice, Pill, RowButton } from "./Common";

/**
 * `FileSelectionType.FOLDER`. Spelled out rather than imported: it is a
 * `const enum`, which the bundler cannot inline across module boundaries.
 */
const SELECT_FOLDER = 1;

/**
 * Where games are looked for.
 *
 * Steam's own library folders are found automatically; this is for the rest —
 * games on a drive Steam does not know about, or non-Steam installs. Browsing
 * the games themselves lives in the games list, not here.
 */
export function LibraryBrowser() {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [busy, setBusy] = useState(false);

  const loadLibraries = useCallback(async () => {
    try {
      setLibraries(await listLibraries());
    } catch {
      setLibraries([]);
    }
  }, []);

  useEffect(() => {
    void loadLibraries();
  }, [loadLibraries]);

  const addFolder = async () => {
    setBusy(true);
    try {
      // Decky's own picker: it knows about the Deck's mount points and reads
      // the filesystem from the plugin host, so the SD card is reachable.
      const picked = await openFilePicker(SELECT_FOLDER, "/home/deck", false, true);
      if (!picked?.path) return;
      const result = await addCustomLibrary(picked.path);
      if (result.ok) {
        toaster.toast({ title: "Library added", body: picked.path });
        await loadLibraries();
      } else {
        toaster.toast({ title: "Could not add", body: String(result.error) });
      }
    } catch {
      /* the picker was dismissed */
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PanelSection title="Game Libraries">
        {libraries === null ? (
          <Centered>Looking for Steam libraries…</Centered>
        ) : libraries.length === 0 ? (
          <PanelSectionRow>
            <Notice tone="warn" title="No libraries found">
              No Steam library folders were detected. Add a folder manually below.
            </Notice>
          </PanelSectionRow>
        ) : (
          libraries.map((library) => (
            <RowButton
              key={library.path}
              label={library.name}
              description={
                library.available ? <Mono>{library.path}</Mono> : "Folder is missing right now"
              }
              right={
                <span>
                  {library.source === "custom" ? <Pill>custom</Pill> : null}
                  <Pill>{library.game_count}</Pill>
                </span>
              }
              disabled
              onClick={() => {}}
            />
          ))
        )}
      </PanelSection>

      <PanelSection title="Custom Folders">
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={() => void addFolder()}>
            Add a games folder
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <Notice tone="info">
            Each subfolder of the folder you pick is treated as one game.
          </Notice>
        </PanelSectionRow>
        {(libraries ?? [])
          .filter((library) => library.source === "custom")
          .map((library) => (
            <PanelSectionRow key={library.path}>
              <ButtonItem
                layout="below"
                onClick={async () => {
                  await removeCustomLibrary(library.path);
                  await loadLibraries();
                }}
              >
                Remove “{library.name}”
              </ButtonItem>
            </PanelSectionRow>
          ))}
      </PanelSection>
    </>
  );
}
