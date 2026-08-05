import type { ButtonHTMLAttributes } from 'react';

/*
 * Button (§4.1 contrast contract).
 *
 *   primary    brass FILL + `--brass-ink` label  (never white-on-brass)
 *   secondary  surface + hairline + ink label
 *   ghost      transparent + ink label
 *   danger     clay outline + clay label (clay is a legal foreground/border on
 *              paper at ≥4.5:1 / ≥3:1 — and it flips correctly in dark, unlike
 *              inventing a light-on-clay token the palette does not define)
 *
 * 8px control radius (`rounded-lg`), `font-body`, comfortable hit area. The
 * visible focus ring is the global `:focus-visible` outline (styles/index.css).
 * `disabled` dims the control, marks `aria-disabled`, and — via the native
 * attribute — removes it from the tab order and blocks activation.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-brass text-brass-ink',
  secondary: 'bg-surface border border-line text-ink',
  ghost: 'bg-transparent text-ink',
  danger: 'bg-surface border border-clay text-clay',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export default function Button({
  variant = 'primary',
  type = 'button',
  className,
  disabled = false,
  ...rest
}: ButtonProps) {
  const classes = [
    'inline-flex items-center justify-center gap-2 rounded-lg font-body text-sm',
    'ps-4 pe-4 py-2 min-h-11',
    VARIANT[variant],
    disabled ? 'opacity-50 cursor-not-allowed' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return <button type={type} disabled={disabled} aria-disabled={disabled || undefined} className={classes} {...rest} />;
}
