import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n, { dirForLang } from '../../i18n';
import { DispatchFrame } from './DispatchFrame';
import PublicFile from './PublicFile';
import PublicFolder from './PublicFolder';
import PasswordGate from './PasswordGate';
import EndScreen from './EndScreen';
import { usePublicMeta } from './queries';

/*
 * SealedDispatch — the public `/s/:token` page (§3.5). The ONE screen a
 * recipient with no account sees. It is bilingual: AR by default, an EN toggle
 * that flips the document to LTR (the only place `dir` changes in the app). It
 * fetches the share metadata and branches on the outcome into the live-file,
 * live-folder, password-gate, or a distinct 404 / 410-stopped / 410-expired end
 * screen — every string authored in AR and EN (§4.9).
 */

/** Seeds the initial language from the browser preference (Accept-Language spirit): EN if the browser prefers English, else AR. */
function initialLang(): 'ar' | 'en' {
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  return nav.toLowerCase().startsWith('en') ? 'en' : 'ar';
}

export default function SealedDispatch() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const [lang, setLang] = useState<'ar' | 'en'>(initialLang);

  // Apply the current language to i18n AND the document: EN → LTR, AR → RTL
  // (the single place the app's writing direction changes).
  useEffect(() => {
    void i18n.changeLanguage(lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = dirForLang(lang);
  }, [lang]);

  // Restore the app-wide AR/RTL default when the recipient leaves this page, so
  // the rest of the (Arabic-only) app is never left in EN/LTR.
  useEffect(
    () => () => {
      void i18n.changeLanguage('ar');
      document.documentElement.lang = 'ar';
      document.documentElement.dir = 'rtl';
    },
    [],
  );

  // A password share is treated as locked on every fresh mount (#11): `revealed`
  // is in-memory only, so a reload/re-open resets it to false and the gate shows
  // again. While false the meta fetch omits the unlock cookie, so a still-valid
  // cookie can't silently reveal the content. Unlocking flips it true.
  const [revealed, setRevealed] = useState(false);
  const meta = usePublicMeta(token, revealed);
  const toggleLang = () => setLang((prev) => (prev === 'ar' ? 'en' : 'ar'));

  return (
    <DispatchFrame lang={lang} onToggleLang={toggleLang}>
      {renderBody()}
    </DispatchFrame>
  );

  function renderBody() {
    if (meta.isPending) {
      return <p className="text-center font-body text-sm text-ink-2">{t('public.loading')}</p>;
    }
    if (meta.isError || meta.data === undefined) {
      return <EndScreen variant="error" lang={lang} />;
    }

    const result = meta.data;
    switch (result.state) {
      case 'live':
        return result.meta.isFolder ? (
          <PublicFolder token={token} meta={result.meta} />
        ) : (
          <PublicFile token={token} meta={result.meta} />
        );
      case 'password':
        return (
          <PasswordGate
            token={token}
            onUnlocked={() => {
              setRevealed(true);
              void meta.refetch();
            }}
          />
        );
      case 'stopped':
        return <EndScreen variant="stopped" lang={lang} />;
      case 'expired':
        return <EndScreen variant="expired" expiresAt={result.expiresAt} lang={lang} />;
      case 'notFound':
        return <EndScreen variant="notFound" lang={lang} />;
      default:
        return <EndScreen variant="error" lang={lang} />;
    }
  }
}
