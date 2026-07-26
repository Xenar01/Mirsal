import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal';
import Button from '../../components/Button';
import { useToast } from '../../components/Toast';
import { FolderDossier, FileSheet } from '../../components/icons';
import DashboardShell from './DashboardShell';
import { formatBytes, formatDate } from './format';
import { useTrash, useRestoreNode, useDeleteNode } from './queries';
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

  function onRestore(node: NodeDto) {
    restore.mutate(node.id, {
      onSuccess: () => toast({ kind: 'success', message: t('trash.toast.restored') }),
      onError: () => toast({ kind: 'error', message: t('trash.toast.restoreFailed') }),
    });
  }

  return (
    <DashboardShell>
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-lg text-ink">{t('trash.title')}</h1>

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
          <div className="overflow-x-auto rounded-[10px] border border-line bg-surface">
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
                  <tr key={node.id} className="border-b border-line last:border-b-0 hover:bg-paper">
                    <td className="ps-3 pe-3 py-2">
                      <div className="flex items-center gap-2">
                        <span
                          data-testid={node.kind === 'folder' ? 'icon-folder' : 'icon-file'}
                          className="inline-flex shrink-0 text-ink-2"
                        >
                          {node.kind === 'folder' ? <FolderDossier size={20} /> : <FileSheet size={20} />}
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
                        <button type="button" onClick={() => onRestore(node)} className="text-teal">
                          {t('trash.restore')}
                        </button>
                        <button type="button" onClick={() => setDeleteTarget(node)} className="text-clay">
                          {t('trash.deletePermanent')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {deleteTarget && (
        <ConfirmDeleteModal node={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
    </DashboardShell>
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
