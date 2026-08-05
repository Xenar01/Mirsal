import { useEffect, useId, useRef, type RefObject } from 'react';

/*
 * Shared modal-dialog behaviour for Modal and Drawer (§4.3/§4.8).
 *
 * Both are `role="dialog" aria-modal="true"` surfaces, so both need the same
 * three things: a focus trap while open, focus returned to the opener on close,
 * and Escape-to-close. The catch is composition — J3 opens a ShareModal from a
 * Drawer action, so a Modal and a Drawer are mounted at once. Each installs a
 * document-level `keydown` listener; `stopPropagation()` does NOT stop sibling
 * listeners on the same target, so a naïve implementation would fire both and
 * close BOTH dialogs on a single Escape. A shared LIFO stack fixes that: only
 * the topmost dialog reacts to Escape, so stacked dialogs dismiss one at a time.
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getAttribute('aria-hidden') !== 'true',
  );
}

// LIFO stack of the ids of currently-open dialogs. The last entry is the
// topmost dialog and the only one that Escape should dismiss.
const dialogStack: string[] = [];

function isTopDialog(id: string): boolean {
  return dialogStack.length > 0 && dialogStack[dialogStack.length - 1] === id;
}

/**
 * useDialog — shared behaviour for an open `role="dialog"` panel.
 *
 * While `open`: pushes this dialog onto the shared stack, remembers the opener
 * and moves focus into the panel, traps Tab within the panel, and closes on
 * Escape — but only when this dialog is the topmost open one. On close it pops
 * the stack and returns focus to the opener.
 *
 * @param panelRef ref to the dialog panel element (needs `tabIndex={-1}` so it
 *   can hold focus when it contains no focusable children).
 */
export function useDialog<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<T | null>,
): void {
  const id = useId();
  const openerRef = useRef<Element | null>(null);

  // Stack membership + focus management. Depends only on `open` so that a
  // changing `onClose` identity can never reorder the stack (which would let a
  // background dialog steal "topmost" from the one actually on top).
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    dialogStack.push(id);
    const panel = panelRef.current;
    if (panel) {
      const focusables = focusableWithin(panel);
      (focusables[0] ?? panel).focus();
    }
    return () => {
      const i = dialogStack.indexOf(id);
      if (i !== -1) dialogStack.splice(i, 1);
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Esc closes (topmost dialog only); Tab is trapped within the panel.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (!isTopDialog(id)) return;
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusables = focusableWithin(panelRef.current);
      if (focusables.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);
}
