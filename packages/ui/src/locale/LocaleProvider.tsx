/**
 * The locale context both hosts wrap their trees in.
 *
 * The provider holds the **choice**, not the strings: the dictionary is imported,
 * not fetched, so there is no loading state to render and nothing to fail. A host
 * that stores the choice (a panel setting, an address-bar parameter) writes it
 * here; `useCopy()` reads one screen's section.
 *
 * Locale is deliberately *not* a theme concern and *not* a routing concern: the
 * product has one copy tree per locale and one token set per scheme, and neither
 * may read the other (plan Technical decisions §4).
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { copyFor, isLocale, type Copy, type Locale } from "./index.ts";

/** The context value: the current locale and its tree. */
export type LocaleContextValue = {
  locale: Locale;
  copy: Copy;
  /** Set by the host. A locale string it does not recognise falls back to `en`. */
  setLocale?: (locale: Locale) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export type LocaleProviderProps = {
  locale: string;
  /** The host's setter; omitted when the host manages the locale itself. */
  onLocaleChange?: (locale: Locale) => void;
  children: ReactNode;
};

export function LocaleProvider(props: LocaleProviderProps) {
  const locale: Locale = isLocale(props.locale) ? props.locale : "en";
  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      copy: copyFor(locale),
      ...(props.onLocaleChange === undefined ? {} : { setLocale: props.onLocaleChange }),
    }),
    [locale, props.onLocaleChange],
  );
  return <LocaleContext.Provider value={value}>{props.children}</LocaleContext.Provider>;
}

/**
 * The current locale value.
 *
 * Outside a provider this throws rather than defaulting: a screen rendering
 * English because nobody wrapped it would look correct and be wrong, and the
 * failure is a wiring mistake the host should see immediately.
 */
export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (value === null) {
    throw new Error("@mstar-harness/ui: useLocale/useCopy must be used inside <LocaleProvider>.");
  }
  return value;
}

/** One locale's whole tree — for a screen that takes a copy object as a prop. */
export function useCopy(): Copy {
  return useLocale().copy;
}
