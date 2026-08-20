/**
 * Opening the full page at a particular game.
 *
 * The route is entered from three places — the Quick Access panel, the Steam
 * library context menu, and "Libraries & all settings" — and two of those know
 * which game they mean. That used to travel as a query string on the route and
 * be read back with `window.location.search`, which is why picking a game
 * landed on Now Playing instead: the Steam client's router does not put the
 * query where `window.location` can be read for it, so the page always came up
 * with no selection at all.
 *
 * The request therefore travels in this module, which both sides are already
 * inside. The query string is still appended — it costs nothing, it makes the
 * route readable in the client's own history, and `targetFromUrl` reads it back
 * on the clients where it does survive — but nothing depends on it.
 */
import { Navigation } from "@decky/ui";

export const ROUTE = "/decky-optiscaler";

/** Which game the page should open at. Empty means the library list. */
export interface ManagerTarget {
  /** The game's folder. With `name`, enough to open the detail view directly. */
  path?: string;
  name?: string;
  /** Steam's app id. On its own the folder has to be looked up first. */
  appid?: string;
}

type Listener = (target: ManagerTarget) => void;

/** Set before navigating, taken by the page when it mounts. */
let pending: ManagerTarget | null = null;
const listeners = new Set<Listener>();

function isEmpty(target: ManagerTarget) {
  return !target.path && !target.name && !target.appid;
}

function routeFor(target: ManagerTarget) {
  const params: string[] = [];
  if (target.path) params.push(`path=${encodeURIComponent(target.path)}`);
  if (target.name) params.push(`name=${encodeURIComponent(target.name)}`);
  if (target.appid) params.push(`appid=${encodeURIComponent(target.appid)}`);
  return params.length > 0 ? `${ROUTE}?${params.join("&")}` : ROUTE;
}

/** Navigate to the full page, at a game when one is named. */
export function openManager(target: ManagerTarget = {}) {
  // Always overwritten, never merged: a request with no game is a request for
  // the library list, and must not be answered with the last game picked.
  pending = isEmpty(target) ? null : { ...target };
  Navigation.Navigate(routeFor(target));
  Navigation.CloseSideMenus();
  // The page may already be open — the Quick Access panel can be pulled up over
  // it — in which case nothing mounts and the pending request would sit unread.
  for (const listener of listeners) listener({ ...target });
}

/** The request the page was opened with, consumed once. */
export function takePendingTarget(): ManagerTarget | null {
  const target = pending;
  pending = null;
  return target;
}

/** Called when a game is asked for while the page is already open. */
export function subscribeManagerTarget(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The same request read off the URL, for clients that do keep it there.
 *
 * Both halves are searched: a hash-based history puts the query after the `#`,
 * where `window.location.search` is empty.
 */
export function targetFromUrl(): ManagerTarget | null {
  try {
    const query = (text: string) => {
      const at = text.indexOf("?");
      return at === -1 ? "" : text.slice(at + 1);
    };
    const search =
      query(window.location.search ? `?${window.location.search.slice(1)}` : "") ||
      query(window.location.hash);
    if (!search) return null;
    const params = new URLSearchParams(search);
    const target: ManagerTarget = {
      path: params.get("path") ?? undefined,
      name: params.get("name") ?? undefined,
      appid: params.get("appid") ?? undefined,
    };
    return isEmpty(target) ? null : target;
  } catch {
    /* no query string available in this client */
    return null;
  }
}
