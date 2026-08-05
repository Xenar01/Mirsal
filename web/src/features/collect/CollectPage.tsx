import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n, { dirForLang } from '../../i18n';
import { DispatchFrame, SealHeader } from '../public/DispatchFrame';
import CollectPasswordGate from './CollectPasswordGate';
import CollectForm from './CollectForm';
import { useCollectMeta } from './queries';

/*
 * CollectPage — the public `/c/:token` uploader page (Collections Phase 3 /
 * Task 7). The bilingual mirror of `SealedDispatch` for the collect-intake
 * surface: AR/RTL by default, an EN toggle that flips the document to LTR,
 * and a metadata fetch that branches into the live upload form, the
 * password gate, or a neutral terminal state (closed / not-found / error) —
 * every string authored in AR and EN.
 */

/** Seeds the initial language from the browser preference: EN if the browser prefers English, else AR. */
function initialLang(): 'ar' | 'en' {
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  return nav.toLowerCase().startsWith('en') ? 'en' : 'ar';
}

export default function CollectPage() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const [lang, setLang] = useState<'ar' | 'en'>(initialLang);

  // Apply the current language to i18n AND the document: EN → LTR, AR → RTL
  // (the single place the app's writing direction changes, together with
  // SealedDispatch on the /s/:token page).
  useEffect(() => {
    void i18n.changeLanguage(lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = dirForLang(lang);
  }, [lang]);

  // Restore the app-wide AR/RTL default when the department leaves this
  // page, so the rest of the (Arabic-only) app is never left in EN/LTR.
  useEffect(
    () => () => {
      void i18n.changeLanguage('ar');
      document.documentElement.lang = 'ar';
      document.documentElement.dir = 'rtl';
    },
    []
  );

  // A password collection is treated as locked on every fresh mount:
  // `revealed` is in-memory only, so a reload/re-open resets it to false and
  // the gate shows again. While false the meta fetch omits the unlock
  // cookie, so a still-valid cookie can't silently reveal the content.
  // Unlocking flips it true.
  const [revealed, setRevealed] = useState(false);
  const meta = useCollectMeta(token, revealed);
  const toggleLang = () => setLang((prev) => (prev === 'ar' ? 'en' : 'ar'));

  return (
    <DispatchFrame lang={lang} onToggleLang={toggleLang}>
      {renderBody()}
    </DispatchFrame>
  );

  function renderBody() {
    if (meta.isPending) {
      return <p className="text-center font-body text-sm text-ink-2">{t('collect.loading')}</p>;
    }
    if (meta.isError || meta.data === undefined) {
      return <NeutralState message={t('collect.error')} />;
    }

    const result = meta.data;
    switch (result.state) {
      case 'open':
        return <CollectForm token={token} meta={result.meta} />;
      case 'password':
        return (
          <CollectPasswordGate
            token={token}
            onUnlocked={() => {
              setRevealed(true);
              void meta.refetch();
            }}
          />
        );
      case 'closed':
        return <NeutralState message={t('collect.closed')} />;
      case 'notFound':
        return <NeutralState message={t('collect.notFound')} />;
      default:
        return <NeutralState message={t('collect.error')} />;
    }
  }
}

/**
 * A branded, neutral terminal screen (closed / not-found / error) — reveals
 * nothing about the collection beyond the message itself, mirroring
 * `EndScreen` on the public share page.
 */
function NeutralState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <SealHeader />
      <p role="status" className="font-body text-base text-ink-2">
        {message}
      </p>
    </div>
  );
}
