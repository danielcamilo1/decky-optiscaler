import { ButtonItem, Focusable, PanelSection, PanelSectionRow } from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listAllGames } from "../api";
import { lastPlayed } from "../hooks/useRunningGame";
import { t as translate, useI18n } from "../i18n";
import { resolveGame } from "../shortcuts";
import type { Game, RunningGame } from "../types";
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
export function GamesList({
  onOpenGame,
  runningGame,
}: {
  onOpenGame: (game: Game) => void;
  runningGame?: RunningGame | null;
}) {
  const { t } = useI18n();
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [filter, setFilter] = useState("all");
  const [openingRunning, setOpeningRunning] = useState(false);
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

  const runningMatch = useMemo(() => {
    if (!runningGame || !games) return null;
    const id = String(runningGame.appid);
    return games.find((game) => game.appid === id) ?? null;
  }, [runningGame, games]);

  const openRunningGame = useCallback(async () => {
    if (!runningGame || openingRunning) return;
    const appid = String(runningGame.appid);
    if (runningMatch) {
      onOpenGame({ ...runningMatch, appid });
      return;
    }
    setOpeningRunning(true);
    try {
      const resolved = await resolveGame(runningGame.appid);
      if (resolved.found && resolved.path) {
        onOpenGame({
          appid,
          name: resolved.name ?? runningGame.name,
          path: resolved.path,
          source: "steam",
          size_on_disk: 0,
        });
      } else {
        toaster.toast({
          title: t("Could not open running game"),
          body: t(
            "This game's install folder could not be found. Pick it from the list or add its folder under Libraries.",
          ),
        });
      }
    } catch (exc) {
      toaster.toast({
        title: t("Could not open running game"),
        body: String(exc),
      });
    } finally {
      setOpeningRunning(false);
    }
  }, [runningGame, runningMatch, openingRunning, onOpenGame, t]);

  const runningBanner = runningGame ? (
    <PanelSection title={t("Running now")}>
      <RowButton
        label={t("Running now · {name}", { name: runningGame.name })}
        description={
          openingRunning
            ? t("Opening game settings…")
            : runningMatch?.installed
              ? t("OptiScaler · {filename} · Open settings", {
                  filename: runningMatch.filename ?? "",
                })
              : t("Open OptiScaler setup and settings")
        }
        right={
          <span>
            <Pill tone="info">{t("running")}</Pill>
            {runningMatch?.installed ? <Pill tone="success">{t("ON")}</Pill> : null}
          </span>
        }
        disabled={openingRunning}
        onClick={() => void openRunningGame()}
      />
    </PanelSection>
  ) : null;

  if (error) {
    return (
      <>
        {runningBanner}
        <PanelSection title={t("Games")}>
          <PanelSectionRow>
            <Notice tone="error" title={t("Could not read your libraries")}>
              {error}
            </Notice>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => void load()}>
              {t("Try again")}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      </>
    );
  }

  if (games === null) {
    return (
      <>
        {runningBanner}
        <Centered>{t("Scanning your libraries…")}</Centered>
      </>
    );
  }

  const filtered = filterGames(games, filter, played);
  const visible = filtered.slice(0, shown);
  const remaining = filtered.length - visible.length;
  const setUpCount = games.filter((game) => game.installed).length;
  const anyPlayed = Array.from(played.values()).some((value) => value !== null);
  const tabs = [
    ...(anyPlayed ? [{ id: "recent", title: t("Recent") }] : []),
    { id: "setup", title: t("Set up"), badge: setUpCount },
    { id: "all", title: t("All"), badge: games.length },
  ];
  /** Index of the first row of the most recently revealed page. */
  const anchorIndex = shown - PAGE_SIZE;

  return (
    <>
      {runningBanner}

      <TabStrip
        tabs={tabs}
        marker="filter"
        variant="filter"
        active={filter}
        onChange={(id) => {
          setFilter(id);
          setShown(PAGE_SIZE);
        }}
      />

      <PanelSection>
        {visible.length === 0 ? (
          <PanelSectionRow>
            <Notice tone="info" title={filter === "setup" ? t("None set up yet") : t("No games found")}>
              {filter === "setup"
                ? t("No game has OptiScaler installed yet. Pick one under All and set it up.")
                : t("No games were detected in your Steam libraries. Add a folder under Libraries if your games live somewhere else.")}
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
                right={game.installed ? <Pill tone="success">{t("ON")}</Pill> : null}
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
              {t("Show next {count} of {remaining} more", {
                count: Math.min(PAGE_SIZE, remaining),
                remaining,
              })}
            </ButtonItem>
          </PanelSectionRow>
        ) : null}

        {visible.length > PAGE_SIZE ? (
          <PanelSectionRow>
            <Focusable
              onClick={() => setShown(PAGE_SIZE)}
              onActivate={() => setShown(PAGE_SIZE)}
              style={{ padding: "6px 0", fontSize: "12px", opacity: 0.7 }}
            >
              {t("Back to the first {count}", { count: PAGE_SIZE })}
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
  if (days <= 0) return translate("played today");
  if (days === 1) return translate("played yesterday");
  if (days < 30) return translate("played {days} days ago", { days });
  const months = Math.floor(days / 30);
  return months === 1
    ? translate("played a month ago")
    : translate("played {months} months ago", { months });
}
