import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Close } from './icons';

/*
 * Toast — lean transient notifications.
 *
 * `useToast().toast({ kind, message })` pushes a toast. They render in a
 * bottom, inline-centred stack. Announcements go through two live regions:
 * `info`/`success` in an `aria-live="polite"` region, `error` in an
 * `aria-live="assertive"` region (role="alert") so failures interrupt. Each
 * toast auto-dismisses after `duration` ms and can be dismissed by hand.
 *
 * Colour carries a redundant cue only — the message text is always present, so
 * this is never colour-only. Colours: success=emerald, error=clay, info=ink,
 * applied as an inline-start accent border (a legal non-text use of the tone).
 */

export type ToastKind = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  toast: (input: { kind: ToastKind; message: string }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Inline-start accent per kind (non-text use of the tone — §4.1 ok). */
const ACCENT: Record<ToastKind, string> = {
  success: 'border-s-emerald',
  error: 'border-s-clay',
  info: 'border-s-ink',
};

export function ToastProvider({
  children,
  duration = 4000,
}: {
  children: ReactNode;
  duration?: number;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    ({ kind, message }: { kind: ToastKind; message: string }) => {
      const id = (nextId.current += 1);
      setItems((prev) => [...prev, { id, kind, message }]);
      const handle = setTimeout(() => {
        setItems((prev) => prev.filter((item) => item.id !== id));
        timers.current = timers.current.filter((h) => h !== handle);
      }, duration);
      timers.current.push(handle);
    },
    [duration]
  );

  // Clear any pending auto-dismiss timers on unmount (no setState-after-unmount).
  useEffect(() => {
    const handles = timers.current;
    return () => {
      handles.forEach(clearTimeout);
    };
  }, []);

  const polite = items.filter((item) => item.kind !== 'error');
  const assertive = items.filter((item) => item.kind === 'error');

  function renderItem(item: ToastItem) {
    return (
      <div
        key={item.id}
        className={`pointer-events-auto flex items-start gap-3 rounded-[10px] border border-line ${ACCENT[item.kind]} border-s-4 bg-surface text-ink shadow-lg ps-4 pe-3 py-3 min-w-64 max-w-sm`}
      >
        <span className="grow font-body text-sm">{item.message}</span>
        <button
          type="button"
          onClick={() => dismiss(item.id)}
          aria-label={t('common.close')}
          className="inline-flex min-h-10 min-w-10 items-center justify-center text-ink-2"
        >
          <Close size={18} />
        </button>
      </div>
    );
  }

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        <div aria-live="polite" className="flex w-full flex-col items-center gap-2">
          {polite.map(renderItem)}
        </div>
        <div
          aria-live="assertive"
          role="alert"
          className="flex w-full flex-col items-center gap-2"
        >
          {assertive.map(renderItem)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a <ToastProvider>');
  }
  return ctx;
}
