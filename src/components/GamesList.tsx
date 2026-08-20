import { ButtonItem, Focusable, PanelSection, PanelSectionRow } from "@decky/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listAllGames } from "../api";
import { lastPlayed } from "../hooks/useRunningGame";
import type { Game } from "../types";
import { Centered, Notice, Pill, RowButton } from "./Common";
import { TabStrip } from "./TabStrip";

const PAGE_SIZE = 20;

/**
 * Every detected game, across every library, as one list.
 *
 * A Deck library can run to hundreds of entries, and a single list that long is
 * miserable to walk with a D-pad, so it is paged. Moving to the next page puts
 * focus on that page's first row, which is where the thumb was heading anyway.
 *
 * Paging alone still means walking, though, and the game somebody wants is
 * nearly always one they have just played or one they have already set up. Both
 * are a filter away, and "recently played" is the one this opens on when Steam
 * will say — the previous "show only the ones set up" button could not help
 * with a game that is not set up yet, which is the whole reason to be here.
 */
export function GamesList({ onOpenGame }: { onOpenGame: (game: Game) => void }) {
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [filter, setFilter] = useState("all");
  /** The first row of the page just revealed, so it can take focus. */
  const pageAnchor = useRef<HTMLDivElement | null>(null);
  const pendingFocus = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const found = await listAllGames();
      // Never trust the shape: a backend that failed mid-scan must not take the
      // whole page down with it.
      const list = Array.isArray(found) ? found : [];
      setGames(list);
      // Only open on Recent when there is a recency to show: games added as
      // custom folders have no Steam overview to read a last-played time from.
      if (list.some((game) => lastPlayed(game.appid) !== null)) setFilter("recent");
    } catch (exc) {
      setError(String(exc));
      setGames([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    // The rows render in the same commit that grew the page, so the anchor is
    // already mounted by the time this runs.
    const node = pageAnchor.current?.querySelector<HTMLElement>("[tabindex], button");
    (node ?? pageAnchor.current)?.focus?.();
  }, [shown]);

  // Steam is asked once per list, not once per row: this is an in-memory read
  // of the client's own app overviews, but the list can run to hundreds.
  const played = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const game of games ?? []) map.set(game.path, lastPlayed(game.appid));
    return map;
  }, [games]);

  if (error) {
    return (
      <PanelSection title="Games">
        <PanelSectionRow>
          <Notice tone="error" title="Could not read your libraries">
            {error}
          </Notice>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (games === null) return <Centered>Scanning your libraries…</Centered>;

  const filtered = filterGames(games, filter, played);
  const visible = filtered.slice(0, shown);
  const remaining = filtered.length - visible.length;
  const setUpCount = games.filter((game) => game.installed).length;
  const anyPlayed = Array.from(played.values()).some((value) => value !== null);
  const tabs = [
    ...(anyPlayed ? [{ id: "recent", title: "Recent" }] : []),
    { id: "setup", title: "Set up", badge: setUpCount },
    { id: "all", title: "All", badge: games.length },
  ];
  /** Index of the first row of the most recently revealed page. */
  const anchorIndex = shown - PAGE_SIZE;

  return (
    <>
      <TabStrip
        tabs={tabs}
        marker="filter"
        active={filter}
        onChange={(id) => {
          setFilter(id);
          setShown(PAGE_SIZE);
        }}
      />

      <PanelSection>
        {visible.length === 0 ? (
          <PanelSectionRow>
            <Notice tone="info" title={filter === "setup" ? "None set up yet" : "No games found"}>
              {filter === "setup"
                ? "No game has OptiScaler installed yet. Pick one under All and set it up."
                : "No games were detected in your Steam libraries. Add a folder under Libraries if your games live somewhere else."}
            </Notice>
          </PanelSectionRow>
        ) : (
          visible.map((game, index) => {
            const row = (
              <RowButton
                key={game.path}
                label={game.name}
                description={
                  game.installed
                    ? `OptiScaler · ${game.filename}`
                    : describePlayed(played.get(game.path)) ?? game.library ?? undefined
                }
                right={game.installed ? <Pill color="#2f6b3f">ON</Pill> : null}
                onClick={() => onOpenGame(game)}
              />
            );
            // Wrap only the row that should receive focus after "show more".
            return index === anchorIndex && anchorIndex > 0 ? (
              <div key={game.path} ref={pageAnchor}>
                {row}
              </div>
            ) : (
              row
            );
          })
        )}

        {remaining > 0 ? (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() => {
                pendingFocus.current = true;
                setShown((value) => value + PAGE_SIZE);
              }}
            >
              Show next {Math.min(PAGE_SIZE, remaining)} of {remaining} more
            </ButtonItem>
          </PanelSectionRow>
        ) : null}

        {visible.length > PAGE_SIZE ? (
          <PanelSectionRow>
            <Focusable
              onActivate={() => setShown(PAGE_SIZE)}
              style={{ padding: "6px 0", fontSize: "12px", opacity: 0.7 }}
            >
              Back to the first {PAGE_SIZE}
            </Focusable>
          </PanelSectionRow>
        ) : null}
      </PanelSection>
    </>
  );
}

/** Newest first for Recent, and only the games that have a last-played time. */
function filterGames(games: Game[], filter: string, played: Map<string, number | null>) {
  if (filter === "setup") return games.filter((game) => game.installed);
  if (filter !== "recent") return games;
  return games
    .filter((game) => played.get(game.path) != null)
    .slice()
    .sort((a, b) => (played.get(b.path) ?? 0) - (played.get(a.path) ?? 0));
}

/** "3 days ago" for the row's second line, when Steam knows. */
function describePlayed(when: number | null | undefined) {
  if (!when) return undefined;
  const days = Math.floor((Date.now() / 1000 - when) / 86400);
  if (days <= 0) return "played today";
  if (days === 1) return "played yesterday";
  if (days < 30) return `played ${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "played a month ago" : `played ${months} months ago`;
}
