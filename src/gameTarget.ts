import type { GameDetail } from "./types";

export const normalizeGamePath = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** A PBZ target must contain the main executable at a canonical physical location. */
export function canonicalPbzTarget(detail: GameDetail): string | null {
  if (detail.pbz_target !== undefined) return detail.pbz_target;
  const root = normalizeGamePath(detail.path);
  const allowed = new Set([`${root}/platform/steam`, `${root}/pbz/platform/steam`]);
  if (root.endsWith("/platform/steam")) allowed.add(root);
  return detail.candidates.find((candidate) =>
    allowed.has(normalizeGamePath(candidate.path)) && candidate.executables.some((exe) =>
      exe.replace(/\\/g, "/").split("/").pop()?.toLowerCase() === "pbz.exe",
    ),
  )?.path ?? null;
}

export function pbzTargetMismatch(detail: GameDetail, required: boolean, target: string): boolean {
  if (!required) return false;
  const expected = canonicalPbzTarget(detail);
  return !expected || normalizeGamePath(expected) !== normalizeGamePath(target);
}

export function isPbzTitle(name: string): boolean {
  return ["phantombladezero", "pbz", "影之刃零"].includes(name.toLowerCase().replace(/[\s_-]/g, ""));
}

/** Identity is already available before the asynchronous wiki plan arrives. */
export function hasPbzIdentity(detail: Pick<GameDetail, "name" | "wiki_entry" | "path" | "pbz_identity">): boolean {
  if (detail.pbz_identity !== undefined) return detail.pbz_identity;
  const folder = detail.path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  return [detail.name, detail.wiki_entry ?? "", folder].some(isPbzTitle);
}
