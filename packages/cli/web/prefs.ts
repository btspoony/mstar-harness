/**
 * The dashboard's two persisted choices — colour scheme and language — and the
 * rules that make them predictable.
 *
 * Storage is not trusted: it holds whatever an earlier version, another tab or a
 * hand edit left there. An unreadable value is therefore treated exactly like no
 * value, because a dashboard that refuses to boot over one malformed key is a worse
 * failure than one that picks the sane default.
 */
import { LOCALES, type Locale } from "@mstar-harness/ui";

/** The stored keys. Namespaced so another tool on the same origin cannot collide. */
export const THEME_KEY = "mstar.dashboard.theme";
export const LOCALE_KEY = "mstar.dashboard.locale";

/** The colour schemes the shared package's token block defines. */
export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** The slice of `Storage` this module needs, so a test can supply its own. */
export type Store = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** Reads a key, treating a throwing storage as an empty one. */
function read(store: Store, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function write(store: Store, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // A full or blocked storage must not stop the switch from working for this
    // session; the choice simply is not remembered.
  }
}

function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value);
}

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * The scheme to render.
 *
 * A stored choice wins. With nothing stored, the operating system decides — that is
 * what `prefers-color-scheme` is for, and it is read through a parameter so the
 * resolution is testable without a browser.
 */
export function resolveTheme(
  store: Store,
  prefersDark: (query: string) => boolean = defaultPrefersDark,
): Theme {
  const stored = read(store, THEME_KEY);
  if (stored !== null && isTheme(stored)) return stored;
  return prefersDark("(prefers-color-scheme: dark)") ? "dark" : "light";
}

/**
 * The language to render.
 *
 * A stored choice wins; otherwise the browser's own preference order decides, and
 * an unsupported language falls back to English rather than to an untranslated
 * screen.
 */
export function resolveLocale(store: Store, languages: string = defaultLanguages()): Locale {
  const stored = read(store, LOCALE_KEY);
  if (stored !== null && isLocale(stored)) return stored;
  for (const tag of languages.split(",")) {
    const primary = tag.trim().toLowerCase().split(";")[0]?.split("-")[0];
    if (primary !== undefined && isLocale(primary)) return primary;
  }
  return "en";
}

export function storeTheme(store: Store, theme: Theme): void {
  write(store, THEME_KEY, theme);
}

export function storeLocale(store: Store, locale: Locale): void {
  write(store, LOCALE_KEY, locale);
}

/**
 * The browser's storage, or an in-memory stand-in.
 *
 * Some browsers throw on merely *touching* `localStorage` — private windows and
 * blocked-storage policies are the common cases. Reaching for it inside a `try` and
 * falling back to memory means the switches still work for the session; only the
 * remembering is lost.
 */
export function browserStore(): Store {
  try {
    const storage = globalThis.localStorage;
    storage.getItem(THEME_KEY);
    return storage;
  } catch {
    const memory = new Map<string, string>();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
      removeItem: (key) => {
        memory.delete(key);
      },
    };
  }
}

/** The browser's language preference, or empty outside a browser. */
function defaultLanguages(): string {
  return typeof navigator === "undefined" ? "" : navigator.languages?.join(",") ?? navigator.language ?? "";
}

/** The OS colour-scheme preference, or light outside a browser. */
function defaultPrefersDark(query: string): boolean {
  return typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? false
    : window.matchMedia(query).matches;
}
