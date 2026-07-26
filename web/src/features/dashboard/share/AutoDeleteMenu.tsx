import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../components/Modal';
import Button from '../../../components/Button';
import { useToast } from '../../../components/Toast';
import { Hourglass } from '../../../components/icons';
import { formatDate } from '../format';
import { useAutoDeleteNode } from '../queries';
import { damascusInputToUtcMs, utcMsToDamascusInput } from './datetime';
import type { NodeDto } from '../types';

/*
 * AutoDeleteMenu — schedule (or clear) a node's self-destruct (§3.4).
 *
 * Rendered as a Modal on a selected node. Before enabling, it states the exact
 * consequence in active voice — the item is trashed, its shares stop, and it is
 * permanently removed after a 7-day grace during which it can be restored (the
 * §3.4 promise: recoverable self-destruct). The owner picks a Damascus wall-
 * clock datetime; it is converted to a UTC epoch-ms at the boundary and a past
 * instant is rejected client-side before the API is ever called. An existing
 * schedule can be cleared.
 */
export default function AutoDeleteMenu({ node, onClose }: { node: NodeDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const mutation = useAutoDeleteNode();
  const inputId = useId();
  const scheduled = node.auto_delete_at != null;
  const [value, setValue] = useState(scheduled ? utcMsToDamascusInput(node.auto_delete_at!) : '');
  const [error, setError] = useState<string | null>(null);

  function set(event?: FormEvent) {
    event?.preventDefault();
    const utcMs = damascusInputToUtcMs(value);
    if (utcMs === null) {
      setError(t('autoDelete.invalid'));
      return;
    }
    if (utcMs <= Date.now()) {
      setError(t('autoDelete.past'));
      return;
    }
    setError(null);
    mutation.mutate(
      { id: node.id, autoDeleteAt: utcMs },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('autoDelete.toast.set') });
          onClose();
        },
        onError: () => toast({ kind: 'error', message: t('autoDelete.toast.error') }),
      }
    );
  }

  function clear() {
    setError(null);
    mutation.mutate(
      { id: node.id, autoDeleteAt: null },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('autoDelete.toast.cleared') });
          onClose();
        },
        onError: () => toast({ kind: 'error', message: t('autoDelete.toast.error') }),
      }
    );
  }

  return (
    <Modal open onClose={onClose} title={t('autoDelete.title')}>
      <div className="flex flex-col gap-4">
        <p className="font-body text-sm text-ink">{node.name}</p>

        <p className="font-body text-sm text-ink-2">
          {scheduled ? (
            <>
              <span>{t('autoDelete.current')} </span>
              <bdi dir="ltr" className="font-mono">
                {formatDate(node.auto_delete_at!)}
              </bdi>
            </>
          ) : (
            t('autoDelete.none')
          )}
        </p>

        {/* The consequence warning — always visible before scheduling (§3.4). */}
        <div className="flex items-start gap-2 rounded-[10px] border border-line bg-paper p-3">
          <span className="mt-0.5 inline-flex shrink-0 text-clay">
            <Hourglass size={18} />
          </span>
          <p className="font-body text-sm text-ink">{t('autoDelete.warning')}</p>
        </div>

        <form onSubmit={set} className="flex flex-col gap-2">
          <label htmlFor={inputId} className="font-body text-sm text-ink-2">
            {t('autoDelete.label')}
          </label>
          <input
            id={inputId}
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-mono text-sm text-ink"
          />
          {error !== null && (
            <p role="alert" className="font-body text-sm text-clay">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {scheduled && (
              <Button variant="ghost" onClick={clear} disabled={mutation.isPending}>
                {t('autoDelete.clear')}
              </Button>
            )}
            <Button variant="primary" type="submit" disabled={mutation.isPending}>
              {t('autoDelete.set')}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
