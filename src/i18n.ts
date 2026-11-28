import { useSyncExternalStore } from "react";
import { getPref, setPref } from "./api";
import { ZH_CN } from "./locales/zh-CN";

export type Locale = "en" | "zh-CN";
export type LanguagePref = "auto" | Locale;

export const PREF_LANGUAGE = "language";
const STORAGE_KEY = "decky-optiscaler:language";

type Listener = () => void;

const listeners = new Set<Listener>();
let languagePref: LanguagePref = readCachedPref();
let backendLocale: string | null = null;
let syncedFromBackend = false;
let prefGeneration = 0;

function isLanguagePref(value: unknown): value is LanguagePref {
  return value === "auto" || value === "en" || value === "zh-CN";
}

function readCachedPref(): LanguagePref {
  try {
    const stored = globalThis.window?.localStorage?.getItem(STORAGE_KEY);
    return isLanguagePref(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

function writeCachedPref(pref: LanguagePref): void {
  try {
    globalThis.window?.localStorage?.setItem(STORAGE_KEY, pref);
  } catch {
    /* localStorage is optional in Steam UI / headless environments */
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Classify a Steam/browser/POSIX locale token into a supported UI locale.
 * Returns null for empty or neutral values (`C`, `POSIX`) so detection can
 * continue down the fallback chain; returns `"en"` for Traditional Chinese
 * and every other non-Simplified-Chinese locale.
 */
export function classifyLocaleToken(raw: unknown): Locale | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toLowerCase().replace(/_/g, "-").split(".")[0].split("@")[0];
  if (!cleaned || cleaned === "c" || cleaned === "posix") return null;

  // Explicitly keep Traditional Chinese on English rather than Simplified Chinese.
  if (
    cleaned === "tchinese" ||
    cleaned.startsWith("zh-tw") ||
    cleaned.startsWith("zh-hk") ||
    cleaned.startsWith("zh-mo") ||
    cleaned.startsWith("zh-hant")
  ) {
    return "en";
  }

  if (
    cleaned === "schinese" ||
    cleaned === "zh" ||
    cleaned.startsWith("zh-cn") ||
    cleaned.startsWith("zh-hans") ||
    cleaned.startsWith("zh-sg")
  ) {
    return "zh-CN";
  }

  return "en";
}

/**
 * Resolve the system locale in priority order:
 *   1. Steam Gaming Mode UI (`window.LocalizationManager.m_rgLocalesToUse`, `window.g_strLanguage`)
 *   2. Browser / DOM (`document.documentElement.lang`, `navigator.languages`, `navigator.language`)
 *   3. Optional OS fallback from backend (`LC_ALL`/`LC_MESSAGES`/`LANG`) ONLY if neither Steam nor browser reported one
 *   4. Default `"en"`
 */
export function detectSystemLocale(fallbackBackendLocale: string | null = backendLocale): Locale {
  const win = globalThis.window as
    | (Window & {
        LocalizationManager?: { m_rgLocalesToUse?: unknown };
        g_strLanguage?: unknown;
      })
    | undefined;

  const steamLocales = win?.LocalizationManager?.m_rgLocalesToUse;
  if (Array.isArray(steamLocales)) {
    for (const token of steamLocales) {
      const match = classifyLocaleToken(token);
      if (match) return match;
    }
  }
  const steamLang = classifyLocaleToken(win?.g_strLanguage);
  if (steamLang) return steamLang;

  const docLang = classifyLocaleToken(globalThis.document?.documentElement?.lang);
  if (docLang) return docLang;

  const nav = globalThis.navigator;
  if (Array.isArray(nav?.languages)) {
    for (const token of nav.languages) {
      const match = classifyLocaleToken(token);
      if (match) return match;
    }
  }
  const navLang = classifyLocaleToken(nav?.language);
  if (navLang) return navLang;

  const osLang = classifyLocaleToken(fallbackBackendLocale);
  if (osLang) return osLang;

  return "en";
}

export function getLanguagePref(): LanguagePref {
  return languagePref;
}

export function getLocale(): Locale {
  return languagePref === "auto" ? detectSystemLocale(backendLocale) : languagePref;
}

export async function setLanguagePref(pref: LanguagePref, persist = true): Promise<void> {
  const next: LanguagePref = isLanguagePref(pref) ? pref : "auto";
  prefGeneration += 1;
  syncedFromBackend = true;
  const changed = next !== languagePref;
  languagePref = next;
  writeCachedPref(next);
  if (changed) notify();
  if (persist) {
    try {
      await setPref(PREF_LANGUAGE, next);
    } catch {
      /* best-effort persistence; local state already updated */
    }
  }
}

export function setBackendLocale(locale: string | null | undefined): void {
  const next = typeof locale === "string" && locale.trim() ? locale.trim() : null;
  if (next === backendLocale) return;
  const before = getLocale();
  backendLocale = next;
  if (languagePref === "auto" && getLocale() !== before) notify();
}

export async function syncLanguagePrefFromBackend(force = false): Promise<LanguagePref> {
  if (syncedFromBackend && !force) return languagePref;
  syncedFromBackend = true;
  const gen = ++prefGeneration;
  try {
    const { value } = await getPref(PREF_LANGUAGE, "auto");
    if (prefGeneration !== gen) return languagePref;
    if (isLanguagePref(value) && value !== languagePref) {
      languagePref = value;
      writeCachedPref(value);
      notify();
    }
  } catch {
    /* keep cached/default preference */
  }
  return languagePref;
}

export function subscribeLocale(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reset module state for deterministic unit/UI harness runs. */
export function resetI18nForTests(pref: LanguagePref = "auto", osLocale: string | null = null): void {
  prefGeneration += 1;
  languagePref = pref;
  backendLocale = osLocale;
  syncedFromBackend = false;
  writeCachedPref(pref);
  notify();
}

export function tLocale(
  locale: Locale,
  en: string,
  vars?: Record<string, string | number>,
): string {
  const template = locale === "zh-CN" ? (ZH_CN[en] ?? en) : en;
  if (!vars) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

const tEn = (en: string, vars?: Record<string, string | number>) => tLocale("en", en, vars);
const tZhCn = (en: string, vars?: Record<string, string | number>) => tLocale("zh-CN", en, vars);

/** Translate an English UI string into the active locale with `{var}` interpolation. */
export function t(en: string, vars?: Record<string, string | number>): string {
  return tLocale(getLocale(), en, vars);
}

function getI18nSnapshot(): string {
  return `${languagePref}:${getLocale()}:${detectSystemLocale(backendLocale)}`;
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

export function useI18n(): {
  locale: Locale;
  pref: LanguagePref;
  systemLocale: Locale;
  t: (en: string, vars?: Record<string, string | number>) => string;
} {
  useSyncExternalStore(subscribeLocale, getI18nSnapshot, getI18nSnapshot);
  const locale = getLocale();
  return {
    locale,
    pref: languagePref,
    systemLocale: detectSystemLocale(backendLocale),
    t: locale === "zh-CN" ? tZhCn : tEn,
  };
}
