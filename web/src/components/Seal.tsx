import { useTranslation } from 'react-i18next';

/*
 * The brass seal (ختم) — Mirsal's brand signature (§4.4).
 *
 * A circular wax seal: a 2px `--brass-ring` outline (this is what earns the
 * seal its ≥3:1 non-text contrast — the brass BODY alone is decorative and
 * would not), a `--brass` body, and a Kufic "م" monogram painted in
 * `--brass-ink` so the letter stays legible on brass (≈5.5:1). Rendered as
 * `role="img"` with an i18n accessible name.
 *
 * Motion (the app's ONLY orchestrated motion): when `stamp` is set AND the
 * user has not asked for reduced motion, one 110ms scale(0.9→1) settle plays
 * via the `.mirsal-seal--stamp` class (keyframes in styles/index.css). Under
 * `prefers-reduced-motion: reduce` the class is simply not attached — the seal
 * appears with no animation (§4.8 fallback).
 */

const SIZE_PX = { badge: 18, dispatch: 72 } as const;

export type SealSize = keyof typeof SIZE_PX;

export interface SealProps {
  /** `'badge'` (18px, list rows) or `'dispatch'` (72px, public page / moment). */
  size?: SealSize;
  /** Play the one-shot stamp settle (honours prefers-reduced-motion). */
  stamp?: boolean;
  className?: string;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export default function Seal({ size = 'badge', stamp = false, className }: SealProps) {
  const { t } = useTranslation();
  const px = SIZE_PX[size];
  const animate = stamp && !prefersReducedMotion();

  const classes = [
    'inline-flex items-center justify-center rounded-full border-2',
    'border-brass-ring bg-brass text-brass-ink font-display font-bold select-none leading-none',
    animate ? 'mirsal-seal--stamp' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      role="img"
      aria-label={t('seal.label')}
      className={classes}
      style={{ inlineSize: px, blockSize: px, fontSize: Math.round(px * 0.55) }}
    >
      <span aria-hidden="true">م</span>
    </span>
  );
}
