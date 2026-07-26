import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Seal from './Seal';
import { Stamp, Pause, Hourglass } from './icons';

/*
 * StatusChip — status is NEVER colour-only (§4.4 / §3.3).
 *
 * Every status pairs THREE redundant cues — colour + an authored text label +
 * a distinct glyph — so it survives grayscale / colour-blindness.
 *
 *   active   emerald   "نشط"     stamp glyph
 *   stopped  ink-2     "موقوف"   pause glyph
 *   expired  clay      "منتهٍ"   hourglass glyph
 *   shared   brass     "مُشارَك"  the brass Seal badge (brass stays a FILL,
 *                                 never a bare text/icon foreground — §4.1)
 *
 * Rendered as a hairline pill (border-line + bg-surface). Logical padding only.
 */

export type ShareStatus = 'active' | 'stopped' | 'expired' | 'shared';

const ICON_PX = 15;

/** Colour class applied to the label+icon for the non-brass statuses. */
const TONE: Record<Exclude<ShareStatus, 'shared'>, string> = {
  active: 'text-emerald',
  stopped: 'text-ink-2',
  expired: 'text-clay',
};

function glyphFor(status: ShareStatus): ReactNode {
  switch (status) {
    case 'active':
      return <Stamp size={ICON_PX} />;
    case 'stopped':
      return <Pause size={ICON_PX} />;
    case 'expired':
      return <Hourglass size={ICON_PX} />;
    case 'shared':
      // The seal IS the icon here — keeps brass a fill, not a text foreground.
      return <Seal size="badge" />;
  }
}

export interface StatusChipProps {
  status: ShareStatus;
  className?: string;
}

export default function StatusChip({ status, className }: StatusChipProps) {
  const { t } = useTranslation();
  // `shared`'s label sits on paper, so it stays ink (brass is never text); the
  // others take their status colour, which all clear ≥4.5:1 on paper (§4.1).
  const tone = status === 'shared' ? 'text-ink' : TONE[status];

  const classes = [
    'inline-flex items-center gap-1.5 rounded-md border border-line bg-surface',
    'ps-2 pe-2.5 py-0.5 font-body text-sm',
    tone,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes}>
      <span className="inline-flex items-center">{glyphFor(status)}</span>
      <span>{t(`status.${status}`)}</span>
    </span>
  );
}
