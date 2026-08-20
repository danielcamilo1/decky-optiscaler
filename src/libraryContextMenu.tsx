/**
 * Adds an "OptiScaler Settings" entry to the context menu Steam shows for a
 * game — the same menu SteamGridDB puts "Change Artwork..." in.
 *
 * The structure here follows SteamGridDB's `contextMenuPatch`, which is the
 * reference implementation for this and is kept working against current Steam
 * clients. Two things about it are not guessable and are the reason a
 * straightforward `findModuleExport` approach cannot work:
 *
 *  1. `LibraryContextMenu` is not exported by any module. It is reached by
 *     finding the module whose source mentions the `LibraryContextMenu`
 *     classname, picking the sibling export that renders it, *rendering* that
 *     component in a fake context, and taking the `.type` off the result.
 *  2. The menu's items are not the rendered component's own children. The
 *     outer render returns an element whose `type` has to be patched in turn;
 *     the items live at `props.children[0]` of *that* render.
 *
 * Everything is wrapped defensively: a Steam update that moves any of this
 * costs the shortcut, never the plugin.
 */
import {
  MenuItem,
  afterPatch,
  fakeRenderComponent,
  findInReactTree,
  findInTree,
  findModuleByExport,
} from "@decky/ui";
import type { Patch } from "@decky/ui";
import { openManager } from "./navigation";

const MENU_LABEL = "OptiScaler Settings";
/** Marks our injected node so repeated renders do not stack duplicates. */
const MARKER = "decky-optiscaler-menu-item";
const LOG = "[decky-optiscaler]";

/** What the finder settled on, so the UI can say whether the entry exists. */
export let menuPatchState: "patched" | "not-found" | "failed" | "idle" = "idle";

function openSettings(appid: number) {
  // The app id alone: the page looks the folder up. It travels through the
  // navigation module rather than only on the route, because the Steam client
  // does not hand the query string back to the page that route renders.
  openManager({ appid: String(appid) });
}

/** Insert ahead of "Properties...", where the other plugins' entries go. */
function spliceMenuItem(items: any[], appid: number) {
  const propertiesIdx = items.findIndex((item: any) =>
    findInReactTree(
      item,
      (node: any) =>
        node?.onSelected && String(node.onSelected).includes("AppProperties"),
    ),
  );
  const item = (
    <MenuItem key={MARKER} onSelected={() => openSettings(appid)}>
      {MENU_LABEL}
    </MenuItem>
  );
  if (propertiesIdx >= 0) items.splice(propertiesIdx, 0, item);
  else items.push(item);
}

/**
 * Whether this is the *game* context menu.
 *
 * Steam renders several menus through the same component; the game one is the
 * only one carrying an item that launches something, so its `launchSource` is
 * the distinguishing mark. Without this check the entry also lands on the
 * screenshot and collection menus.
 */
function isAppContextMenu(items: any[]) {
  if (!items?.length) return false;
  return Boolean(
    findInReactTree(items, (node: any) =>
      node?.props?.onSelected && String(node.props.onSelected).includes("launchSource"),
    ),
  );
}

function removeExisting(items: any[]) {
  const index = items.findIndex((item: any) => item?.key === MARKER);
  if (index !== -1) items.splice(index, 1);
}

/**
 * The app id for the menu being rendered.
 *
 * The one captured when the menu component first rendered can be stale — Steam
 * reuses the component — so the items themselves are checked first.
 */
function resolveAppid(items: any[], fallback: number | undefined) {
  const parentOverview = items.find(
    (item: any) =>
      item?._owner?.pendingProps?.overview?.appid &&
      item._owner.pendingProps.overview.appid !== fallback,
  );
  if (parentOverview) return Number(parentOverview._owner.pendingProps.overview.appid);

  const found = findInTree(items, (node: any) => node?.app?.appid, {
    walkable: ["props", "children"],
  });
  if (found?.app?.appid) return Number(found.app.appid);
  return fallback;
}

function patchMenuItems(items: any[], fallbackAppid: number | undefined) {
  const appid = resolveAppid(items, fallbackAppid);
  if (!Number.isFinite(appid) || (appid as number) <= 0) return;
  spliceMenuItem(items, appid as number);
}

/** Find the menu class. See the note at the top of this file. */
function findLibraryContextMenu(): any {
  try {
    const module = findModuleByExport(
      (e: any) => e?.toString && e.toString().includes("().LibraryContextMenu"),
    );
    if (!module) return null;
    const wrapper = Object.values(module).find(
      (sibling: any) => sibling?.toString && sibling.toString().includes("navigator:"),
    );
    if (!wrapper) return null;
    return fakeRenderComponent(wrapper as Function)?.type ?? null;
  } catch (err) {
    console.warn(`${LOG} could not resolve the library context menu`, err);
    return null;
  }
}

export function patchLibraryContextMenu(): () => void {
  const LibraryContextMenu = findLibraryContextMenu();
  if (!LibraryContextMenu?.prototype?.render) {
    menuPatchState = "not-found";
    console.warn(`${LOG} library context menu not found; no Steam menu entry this session`);
    return () => {};
  }

  let inner: Patch | undefined;
  let outer: Patch | undefined;

  try {
    outer = afterPatch(
      LibraryContextMenu.prototype,
      "render",
      (_args: any[], component: any) => {
        let appid: number | undefined;
        try {
          appid = Number(component?._owner?.pendingProps?.overview?.appid);
          if (!Number.isFinite(appid)) {
            const found = findInTree(component?.props?.children, (node: any) => node?.app?.appid, {
              walkable: ["props", "children"],
            });
            appid = found?.app?.appid ? Number(found.app.appid) : undefined;
          }
        } catch {
          appid = undefined;
        }

        try {
          if (!inner) {
            // The items belong to the component this render *returns*, so the
            // element's `type` is patched to get at it on the way through.
            inner = afterPatch(component, "type", (_: any, ret: any) => {
              try {
                afterPatch(ret.type.prototype, "render", (_a: any, rendered: any) => {
                  try {
                    const items = rendered?.props?.children?.[0];
                    if (!Array.isArray(items) || !isAppContextMenu(items)) return rendered;
                    removeExisting(items);
                    patchMenuItems(items, appid);
                  } catch {
                    /* leave the menu untouched on any shape change */
                  }
                  return rendered;
                });

                // Steam refreshes the overview behind an open menu.
                afterPatch(
                  ret.type.prototype,
                  "shouldComponentUpdate",
                  ([nextProps]: any[], shouldUpdate: any) => {
                    try {
                      const items = nextProps?.children;
                      if (!Array.isArray(items) || !isAppContextMenu(items)) return shouldUpdate;
                      removeExisting(items);
                      if (shouldUpdate === true) patchMenuItems(items, appid);
                    } catch {
                      /* wrong menu, probably */
                    }
                    return shouldUpdate;
                  },
                );
              } catch (err) {
                console.warn(`${LOG} could not patch the menu body`, err);
              }
              return ret;
            });
          } else if (Array.isArray(component?.props?.children)) {
            const items = component.props.children;
            if (isAppContextMenu(items)) {
              removeExisting(items);
              patchMenuItems(items, appid);
            }
          }
        } catch (err) {
          console.warn(`${LOG} could not add the menu entry`, err);
        }
        return component;
      },
    );
    menuPatchState = "patched";
    console.info(`${LOG} library context menu patched`);
  } catch (err) {
    menuPatchState = "failed";
    console.warn(`${LOG} could not patch the library context menu`, err);
    return () => {};
  }

  return () => {
    try {
      inner?.unpatch();
    } catch {
      /* already gone */
    }
    try {
      outer?.unpatch();
    } catch {
      /* already gone */
    }
  };
}

/**
 * Internals exposed for the headless harness. The tree shapes this walks come
 * from Steam, so they are worth testing against fixtures even though the patch
 * itself can only run inside the client.
 */
export const __testing = {
  MARKER,
  MENU_LABEL,
  spliceMenuItem,
  isAppContextMenu,
  removeExisting,
  resolveAppid,
  patchMenuItems,
};
