import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal';
import Button from '../../components/Button';
import { useToast } from '../../components/Toast';
import { FolderDossier, FileSheet } from '../../components/icons';
import DashboardShell from './DashboardShell';
import { formatBytes, formatDate } from './format';
import { useTrash, useRestoreNode, useDeleteNode, useEmptyTrash } from './queries';
import type { NodeDto } from './types';

/*
 * TrashView (§3.2 / §4.9).
 *
 * Lists `/api/nodes/trash` (newest first). Each item can be restored (auto-
 * suffixes on the server if the live name is taken) or permanently deleted —
 * the latter behind a destructive confirm Modal (irreversible, cascades). The
 * empty state uses the authored §4.9 Trash copy, verbatim. Sizes + dates are
 * mono ledger data, bidi-isolated LTR (§4.3/§4.5).
 */
export default function TrashView() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { data, isPending, isError } = useTrash();
  const items = Array.isArray(data) ? data : [];

  const restore = useRestoreNode();
  const [deleteTarget, setDeleteTarget] = useState<NodeDto | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);

  function onRestore(node: NodeDto) {
    restore.mutate(node.id, {
      onSuccess: () => toast({ kind: 'success', message: t('trash.toast.restored') }),
      onError: () => toast({ kind: 'error', message: t('trash.toast.restoreFailed') }),
    });
  }

  return (
    <DashboardShell>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-lg text-ink">{t('trash.title')}</h1>
          {!isPending && !isError && items.length > 0 && (
            <Button variant="danger" onClick={() => setEmptyOpen(true)}>
              {t('trash.emptyAll')}
            </Button>
          )}
        </div>

        {isPending && <p className="font-body text-sm text-ink-2">{t('trash.loading')}</p>}
        {isError && (
          <p role="alert" className="font-body text-sm text-clay">
            {t('trash.error')}
          </p>
        )}
        {!isPending && !isError && items.length === 0 && (
          // §4.9 empty-Trash copy, verbatim.
          <p className="font-body text-sm text-ink-2">{t('trash.empty')}</p>
        )}

        {!isPending && !isError && items.length > 0 && (
          <TrashList items={items} onRestore={onRestore} onDelete={setDeleteTarget} />
        )}
      </div>

      {deleteTarget && (
        <ConfirmDeleteModal node={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
      {emptyOpen && <ConfirmEmptyModal onClose={() => setEmptyOpen(false)} />}
    </DashboardShell>
  );
}

/* ── List (desktop table ≥ md / mobile cards < md) ────────────────────── */

/**
 * The two-layout pattern (§M2a/§M2b): the desktop table (wrapper gains
 * `hidden md:block`, the table itself byte-identical to before this refactor)
 * and a sibling `md:hidden` stacked card list — same items, same handlers,
 * both rendered by the shared `TrashRow` below so there is exactly one place
 * each row's markup/logic is written.
 */
function TrashList({
  items,
  onRestore,
  onDelete,
}: {
  items: NodeDto[];
  onRestore: (node: NodeDto) => void;
  onDelete: (node: NodeDto) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="hidden overflow-x-auto rounded-[10px] border border-line bg-surface md:block">
        <table className="w-full border-collapse font-body text-sm">
          <thead>
            <tr className="border-b border-line text-ink-2">
              <th className="ps-3 pe-3 py-2 text-start font-medium">{t('dashboard.col.name')}</th>
              <th className="ps-3 pe-3 py-2 text-start font-medium">{t('dashboard.col.size')}</th>
              <th className="ps-3 pe-3 py-2 text-start font-medium">{t('dashboard.col.date')}</th>
              <th className="ps-3 pe-3 py-2 text-start font-medium">
                <span className="sr-only">{t('dashboard.col.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((node) => (
              <TrashRow key={node.id} variant="row" node={node} onRestore={onRestore} onDelete={onDelete} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3 md:hidden">
        {items.map((node) => (
          <TrashRow key={node.id} variant="card" node={node} onRestore={onRestore} onDelete={onDelete} />
        ))}
      </div>
    </>
  );
}

/**
 * The row's two actions (restore / delete-permanently). Shared verbatim
 * between the desktop actions cell and the mobile card's action row — the
 * ONLY place these buttons (labels/handlers/classes) are written.
 */
function TrashActionButtons({
  node,
  onRestore,
  onDelete,
}: {
  node: NodeDto;
  onRestore: (node: NodeDto) => void;
  onDelete: (node: NodeDto) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button type="button" onClick={() => onRestore(node)} className="text-teal">
        {t('trash.restore')}
      </button>
      <button type="button" onClick={() => onDelete(node)} className="text-clay">
        {t('trash.deletePermanent')}
      </button>
    </>
  );
}

/**
 * A single trashed node's BOTH presentations. `variant` switches only the
 * returned JSX layout — `'row'` is the desktop `<tr>` byte-identical to
 * before this refactor, `'card'` is the mobile card — while the icon/name,
 * the meta line, and `TrashActionButtons` above are the single code path
 * both variants call.
 */
function TrashRow({
  node,
  variant = 'row',
  onRestore,
  onDelete,
}: {
  node: NodeDto;
  variant?: 'row' | 'card';
  onRestore: (node: NodeDto) => void;
  onDelete: (node: NodeDto) => void;
}) {
  const icon = node.kind === 'folder' ? <FolderDossier size={20} /> : <FileSheet size={20} />;
  const testId = node.kind === 'folder' ? 'icon-folder' : 'icon-file';

  if (variant === 'card') {
    return (
      <div
        data-testid={`trash-card-${node.id}`}
        className="rounded-[10px] border border-line bg-surface p-3"
      >
        <div className="flex items-center gap-2">
          <span data-testid={testId} className="inline-flex shrink-0 text-ink-2">
            {icon}
          </span>
          <span className="min-w-0 flex-1 truncate text-ink">{node.name}</span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink-2">
          <bdi dir="ltr" className="font-mono">
            {formatBytes(node.size_bytes)}
          </bdi>
          <span aria-hidden="true">·</span>
          <bdi dir="ltr" className="font-mono">
            {formatDate(node.updated_at)}
          </bdi>
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          <TrashActionButtons node={node} onRestore={onRestore} onDelete={onDelete} />
        </div>
      </div>
    );
  }

  return (
    <tr className="border-b border-line last:border-b-0 hover:bg-paper">
      <td className="ps-3 pe-3 py-2">
        <div className="flex items-center gap-2">
          <span data-testid={testId} className="inline-flex shrink-0 text-ink-2">
            {icon}
          </span>
          <span className="text-ink">{node.name}</span>
        </div>
      </td>
      <td className="ps-3 pe-3 py-2">
        <bdi dir="ltr" className="font-mono text-ink-2">
          {formatBytes(node.size_bytes)}
        </bdi>
      </td>
      <td className="ps-3 pe-3 py-2">
        <bdi dir="ltr" className="font-mono text-ink-2">
          {formatDate(node.updated_at)}
        </bdi>
      </td>
      <td className="ps-3 pe-3 py-2">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <TrashActionButtons node={node} onRestore={onRestore} onDelete={onDelete} />
        </div>
      </td>
    </tr>
  );
}

function ConfirmDeleteModal({ node, onClose }: { node: NodeDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const remove = useDeleteNode();

  function confirm() {
    remove.mutate(node.id, {
      onSuccess: () => {
        toast({ kind: 'success', message: t('trash.toast.deleted') });
        onClose();
      },
      onError: () => {
        toast({ kind: 'error', message: t('trash.toast.deleteFailed') });
        onClose();
      },
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('trash.confirm.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('trash.confirm.cancel')}
          </Button>
          <Button variant="danger" onClick={confirm} disabled={remove.isPending}>
            {t('trash.confirm.confirm')}
          </Button>
        </>
      }
    >
      <p className="font-body text-sm text-ink">{t('trash.confirm.body', { name: node.name })}</p>
    </Modal>
  );
}

function ConfirmEmptyModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const empty = useEmptyTrash();

  function confirm() {
    empty.mutate(undefined, {
      onSuccess: () => {
        toast({ kind: 'success', message: t('trash.toast.emptied') });
        onClose();
      },
      onError: () => {
        toast({ kind: 'error', message: t('trash.toast.emptyFailed') });
        onClose();
      },
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('trash.confirmEmpty.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('trash.confirmEmpty.cancel')}
          </Button>
          <Button variant="danger" onClick={confirm} disabled={empty.isPending}>
            {t('trash.confirmEmpty.confirm')}
          </Button>
        </>
      }
    >
      <p className="font-body text-sm text-ink">{t('trash.confirmEmpty.body')}</p>
    </Modal>
  );
}
