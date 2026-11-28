/** Shared text and path formatting helpers for UI surfaces. */

/** Shorten a filesystem path to its trailing `keep` segments. */
export function shortenPath(path: string, keep = 3): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= keep ? path : `…/${parts.slice(-keep).join("/")}`;
}

/**
 * Turn wiki markdown/AsciiDoc markup into plain readable text.
 *
 * Handles AsciiDoc strikethrough passthroughs (`+++<s>+++` / `+++</s>+++`),
 * HTML `<br>` line breaks (replaced with a space), remaining HTML tags,
 * markdown links, inline code, and bold/italic emphasis while keeping
 * underscores inside filenames and option names intact.
 */
export function stripWikiMarkup(text: string): string {
  return text
    .replace(/\+\+\+<\/?s>\+\+\+/gi, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/(^|\s)_([^_]+)_(\s|$)/g, "$1$2$3")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
