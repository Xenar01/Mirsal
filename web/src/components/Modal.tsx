import { useId, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Close } from './icons';
import { useDialog } from './dialog';

/*
 * Modal — accessible dialog (§4.3/§4.8).
 *
 * role="dialog" + aria-modal + labelled by its title. Focus trap, Esc-to-close
 * (topmost dialog only — see `useDialog`), scrim-click close, and focus return
 * to the opener are all provided by the shared `useDialog` hook, so a Modal and
 * a Drawer can be stacked and Escape only dismisses the top one. Surface panel,
 * 10px radius, one soft shadow, centred with logical spacing. Scroll is not
 * locked (would flake tests / add nothing here).
 */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Optional action row rendered at the inline-end of the footer. */
  footer?: ReactNode;
}

export default function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useDialog(open, onClose, panelRef);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        data-testid="modal-scrim"
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 bg-ink/50"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative z-10 flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-[10px] bg-surface text-ink shadow-lg"
      >
        {/* Fixed header — stays put while the body scrolls. */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-6 py-4">
          <h2 id={titleId} className="font-display text-lg">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="inline-flex rounded-md p-1 text-ink-2 transition-colors hover:bg-paper hover:text-ink"
          >
            <Close size={20} />
          </button>
        </div>
        {/* Scrollable body — the only part that overflows a tall modal. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer ? (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-6 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
