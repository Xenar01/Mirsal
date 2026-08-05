import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Seal from '../../components/Seal';

/*
 * AuthCard — the sealed-dispatch chrome for the Arabic-only auth entry pages
 * (login, forced password change). Mirrors the public DispatchFrame identity
 * (§4.4 / §4.6): the 72px brass Seal over the Mirsal wordmark, centered on the
 * cool-paper app background inside a single hairline `bg-surface` card — but
 * without the bilingual language toggle (the authenticated app is Arabic-only).
 * Light + dark come for free from the token cascade; nothing hard-codes a hex.
 *
 * The Seal is the page's hero and plays its one-shot `stamp` settle on mount
 * (the J1 Seal no-ops that under prefers-reduced-motion). The wordmark is a
 * logotype, not a heading; the page's own `<h1>` is `title`.
 */
export default function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-paper px-4 py-10 text-ink">
      <div className="w-full max-w-sm">
        <section className="flex flex-col items-center gap-6 rounded-[10px] border border-line bg-surface px-6 py-8 shadow-sm">
          <div className="flex flex-col items-center gap-3">
            <Seal size="dispatch" stamp />
            <bdi className="font-display text-lg text-ink">{t('brand.name')}</bdi>
          </div>
          <h1 className="font-display text-xl text-ink">{title}</h1>
          {children}
        </section>
      </div>
    </main>
  );
}
