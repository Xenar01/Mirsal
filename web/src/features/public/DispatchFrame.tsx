import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Seal from '../../components/Seal';

/*
 * DispatchFrame — the sealed-dispatch page chrome (§4.4 / §4.6).
 *
 * A calm "dispatch register" surface centered on the cool-paper app background:
 * a top bar carrying the visible AR/EN language toggle (inline-end, so it sits
 * in the reading corner in both directions via logical properties), and a
 * single hairline-bordered card that holds whichever screen is active. Light +
 * dark come for free from the token cascade (bg-paper/bg-surface/text-ink…);
 * nothing here hard-codes a hex.
 */
export function DispatchFrame({
  lang,
  onToggleLang,
  children,
}: {
  lang: 'ar' | 'en';
  onToggleLang: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <main className="min-h-dvh bg-paper text-ink">
      <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 py-6">
        <div className="flex items-center justify-end">
          {/* Visible target-language endonym IS the accessible name (no
              separate aria-label, so "label in name" holds); a lang attribute
              marks the endonym's own language for correct pronunciation. */}
          <button
            type="button"
            onClick={onToggleLang}
            lang={lang === 'ar' ? 'en' : 'ar'}
            className="inline-flex min-h-9 items-center rounded-lg border border-line bg-surface ps-3 pe-3 py-1 font-body text-sm text-teal"
          >
            {lang === 'ar' ? t('public.toEnglish') : t('public.toArabic')}
          </button>
        </div>

        <div className="flex flex-1 items-center justify-center py-6">
          <section className="w-full rounded-[10px] border border-line bg-surface px-6 py-8 shadow-sm">
            {children}
          </section>
        </div>
      </div>
    </main>
  );
}

/*
 * SealHeader — the 72px brass dispatch Seal (§4.4) over the Mirsal wordmark.
 * The seal is the page's hero. `stamp` plays the one-shot press on the live
 * "delivery" moment; the J1 Seal already no-ops that under reduced motion. The
 * wordmark keeps its Arabic logotype in both languages (a logo doesn't
 * translate) and is bidi-isolated so it never disturbs surrounding EN text.
 */
export function SealHeader({ stamp = false }: { stamp?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <Seal size="dispatch" stamp={stamp} />
      <bdi className="font-display text-lg text-ink">مِرسال</bdi>
    </div>
  );
}
