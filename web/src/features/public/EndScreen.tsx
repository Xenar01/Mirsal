import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, CalendarStamp, Close } from '../../components/icons';
import { SealHeader } from './DispatchFrame';
import { formatExpiry, isolateLtr } from './format';

/*
 * EndScreen — the terminal dispatch states (§3.5 / §4.9), each with its OWN
 * authored copy so a recipient always knows what happened and why:
 *   notFound → "This link doesn't exist."          (unknown OR gone — ambiguous)
 *   stopped  → "The sender turned this link off."
 *   expired  → "This link expired on <date>."      (Damascus date; §4.5)
 *   error    → generic retry-later copy for a network failure
 *
 * Status is never colour-only (§4.4/§4.8): the message text is the signal, and
 * each state pairs it with a subject-grounded glyph. The expiry date is
 * bidi-isolated so the Latin/number run can't scramble the RTL sentence.
 */
export type EndVariant = 'notFound' | 'stopped' | 'expired' | 'error';

export default function EndScreen({
  variant,
  expiresAt,
  lang,
}: {
  variant: EndVariant;
  expiresAt?: number | null;
  lang: 'ar' | 'en';
}) {
  const { t } = useTranslation();

  let icon: ReactNode;
  let message: string;
  switch (variant) {
    case 'stopped':
      icon = <Pause size={22} />;
      message = t('public.stopped');
      break;
    case 'expired':
      icon = <CalendarStamp size={22} />;
      message = t('public.expired', { date: isolateLtr(formatExpiry(expiresAt ?? null, lang)) });
      break;
    case 'error':
      icon = <Close size={22} />;
      message = t('public.error');
      break;
    case 'notFound':
    default:
      icon = <Close size={22} />;
      message = t('public.notFound');
  }

  // Expiry pairs with clay (§4.7 expiry cue); the others stay neutral ink-2.
  // Colour is never the sole signal — the message text carries the meaning.
  const tone = variant === 'expired' ? 'text-clay' : 'text-ink-2';

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <SealHeader />
      <span className={`inline-flex ${tone}`} aria-hidden="true">
        {icon}
      </span>
      <p role="status" className={`font-body text-base ${tone}`}>
        {message}
      </p>
    </div>
  );
}
