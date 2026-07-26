import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Close } from './icons';

/*
 * Drawer — details panel anchored to the INLINE-END edge (§4.3).
 *
 * `inset-inline-end: 0` (via `inset-e-0`) so it sits on the inline-end edge —
 * visually LEFT in RTL, opposite the inline-start nav rail (never the same
 * edge). Esc closes, the scrim closes, it is labelled by its title and has a
 * focusable close control (focused on open for keyboard users). On narrow
 * screens it spans the full inline size (a lightweight responsive nicety — the
 * full bottom-sheet variant is deferred, §4.8, YAGNI).
 */

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export default function Drawer({ open, onClose, title, children }: DrawerProps) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      <div
        data-testid="drawer-scrim"
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 bg-ink/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed inset-e-0 inset-y-0 z-10 flex w-full max-w-sm flex-col bg-surface text-ink shadow-lg border-s border-line p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="font-display text-lg">
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="inline-flex text-ink-2"
          >
            <Close size={20} />
          </button>
        </div>
        <div className="mt-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
