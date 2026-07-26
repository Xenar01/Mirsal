import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './ar.json';
import en from './en.json';

/**
 * i18next setup. AR is the app language (the whole authenticated UI); EN
 * exists only for the public share page (§4.9). `fallbackLng: 'ar'` so any
 * key absent from `en` (i.e. everything outside `public.*`) falls back to the
 * authored Arabic. No language switcher yet (YAGNI) — the app stays on `ar`.
 */

void i18n.use(initReactI18next).init({
  resources: {
    ar: { translation: ar },
    en: { translation: en },
  },
  lng: 'ar',
  fallbackLng: 'ar',
  // React already escapes interpolated values, so i18next must not double-escape.
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

/** Maps a language to the document writing direction (ar → rtl, en → ltr). */
export function dirForLang(lang: string): 'rtl' | 'ltr' {
  return lang === 'en' ? 'ltr' : 'rtl';
}

export default i18n;
