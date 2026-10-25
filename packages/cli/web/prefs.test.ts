/**
 * The dashboard's two persisted choices: colour scheme and language.
 *
 * The rules, and why each is a rule rather than an implementation detail:
 *
 *  - **A stored choice wins.** The reader said what they want; the OS saying
 *    otherwise is not a reason to overrule them.
 *  - **`prefers-color-scheme` supplies the default** when nothing is stored, so a
 *    reader who has never chosen gets the scheme their machine uses.
 *  - **An unreadable stored value falls back, it does not throw.** Storage holds
 *    whatever some earlier version (or another tab, or a hand edit) left there. A
 *    dashboard that refuses to boot because one key is malformed is a worse
 *    outcome than one that picks a sane default — so a bad value is treated exactly
 *    like no value.
 *  - **The attribute is the only channel.** The shared package selects its dark
 *    tokens through `[data-ms-theme="dark"]`; a media query over product colours
 *    would be a second mechanism that disagrees with the first.
 */
import { describe, expect, test } from "bun:test";

import { copyFor } from "@mstar-harness/ui";

import { LOCALE_KEY, THEME_KEY, browserStore, resolveLocale, resolveTheme, storeLocale, storeTheme } from "./prefs";

/** A storage that behaves like the real one for the cases that matter. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
  };
}

const darkOs = (matches: boolean) => (query: string) => matches && query.includes("dark");

describe("theme resolution", () => {
  test("nothing stored follows the operating system", () => {
    expect(resolveTheme(fakeStorage(), darkOs(true))).toBe("dark");
    expect(resolveTheme(fakeStorage(), darkOs(false))).toBe("light");
  });

  test("a stored choice wins over the operating system", () => {
    expect(resolveTheme(fakeStorage({ [THEME_KEY]: "light" }), darkOs(true))).toBe("light");
    expect(resolveTheme(fakeStorage({ [THEME_KEY]: "dark" }), darkOs(false))).toBe("dark");
  });

  test("an unreadable stored value falls back to the OS rather than throwing", () => {
    for (const junk of ["", "DARK", "purple", "dark;","  ", "{}"]) {
      expect(resolveTheme(fakeStorage({ [THEME_KEY]: junk }), darkOs(true))).toBe("dark");
      expect(resolveTheme(fakeStorage({ [THEME_KEY]: junk }), darkOs(false))).toBe("light");
    }
  });

  test("a storage that throws is treated as empty", () => {
    const hostile = {
      getItem: (): string => {
        throw new Error("access denied");
      },
      setItem: (): void => {},
      removeItem: (): void => {},
    };
    expect(resolveTheme(hostile, darkOs(true))).toBe("dark");
  });

  test("a browser store that throws is replaced by one that works", () => {
    // Private windows throw on merely touching `localStorage`; the switch must still
    // work for the session rather than taking the page down.
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get(): never {
        throw new Error("SecurityError");
      },
    });
    try {
      const { store, persisted } = browserStore();
      storeTheme(store, "dark");
      expect(resolveTheme(store, darkOs(false))).toBe("dark");
      // The fallback says so, so the shell can disclose it instead of pretending.
      expect(persisted).toBe(false);
    } finally {
      if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, "localStorage", original);
    }
  });

  test("a stored choice round-trips", () => {
    const storage = fakeStorage();
    storeTheme(storage, "dark");
    expect(storage.getItem(THEME_KEY)).toBe("dark");
    expect(resolveTheme(storage, darkOs(false))).toBe("dark");
  });
});

describe("locale resolution", () => {
  test("nothing stored is English", () => {
    expect(resolveLocale(fakeStorage())).toBe("en");
  });

  test("a stored choice wins", () => {
    const storage = fakeStorage();
    storeLocale(storage, "zh");
    expect(resolveLocale(storage)).toBe("zh");
  });

  test("an unreadable stored value falls back rather than throwing", () => {
    for (const junk of ["", "fr", "ZH-CN", "zh_TW", "  ", "{}"]) {
      expect(resolveLocale(fakeStorage({ [LOCALE_KEY]: junk }))).toBe("en");
    }
  });

  test("a storage that throws is treated as empty", () => {
    const hostile = {
      getItem: (): string => {
        throw new Error("access denied");
      },
      setItem: (): void => {},
      removeItem: (): void => {},
    };
    expect(resolveLocale(hostile)).toBe("en");
  });

  test("a browser preference is used when nothing is stored", () => {
    // The dashboard has no separate negotiation: a `zh` browser gets `zh` unless
    // the reader stored otherwise.
    expect(resolveLocale(fakeStorage(), "zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
    expect(resolveLocale(fakeStorage(), "en-US,en;q=0.9")).toBe("en");
    expect(resolveLocale(fakeStorage({ [LOCALE_KEY]: "en" }), "zh-CN")).toBe("en");
  });
});

describe("the shell's own copy", () => {
  test("the navigation landmark's label resolves through the dictionary in both languages", () => {
    // An `aria-label` is copy: it reaches the reader through assistive technology
    // even though nothing paints it. A literal here would survive every screening
    // of `zh` and leave the landmark English.
    expect(copyFor("en").shell.nav.primary).toBe("Primary");
    expect(copyFor("zh").shell.nav.primary).toBe("主导航");
    expect(copyFor("zh").shell.nav.primary).not.toBe(copyFor("en").shell.nav.primary);
  });

  test("both switches are labelled in both languages, and the labels differ", () => {
    for (const section of ["theme", "language"] as const) {
      expect(copyFor("en").shell[section].label).not.toBe("");
      expect(copyFor("zh").shell[section].label).not.toBe("");
      expect(copyFor("zh").shell[section].label).not.toBe(copyFor("en").shell[section].label);
    }
    // The two schemes and the two languages are each named in the reader's language.
    expect(copyFor("zh").shell.theme.dark).toBe("深色");
    expect(copyFor("en").shell.language.zh).toBe("中文");
  });

  test("a session-only store is disclosed in both languages", () => {
    for (const locale of ["en", "zh"] as const) {
      expect(copyFor(locale).shell.store.sessionOnly).not.toBe("");
    }
    expect(copyFor("zh").shell.store.sessionOnly).not.toBe(copyFor("en").shell.store.sessionOnly);
  });

  test("the English and Chinese shell sections carry the same shape", () => {
    const shape = (copy: ReturnType<typeof copyFor>): string[] => [
      ...Object.keys(copy.shell).sort(),
      ...Object.keys(copy.shell.theme).sort(),
      ...Object.keys(copy.shell.language).sort(),
      ...Object.keys(copy.shell.store).sort(),
    ];
    expect(shape(copyFor("zh"))).toEqual(shape(copyFor("en")));
  });
});
