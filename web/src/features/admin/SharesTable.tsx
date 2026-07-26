import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal';
import Button from '../../components/Button';
import StatusChip from '../../components/StatusChip';
import { useToast } from '../../components/Toast';
import { formatDate } from '../dashboard/format';
import { useAdminShares, useRevokeShare } from './queries';
import type { AdminShareDto } from './types';

/*
 * SharesTable (§3.1) — every share across all users, as a dispatch register.
 *
 * Columns: owner (mono handle, bidi LTR + an "inactive owner" note), the shared
 * item's name, a StatusChip (colour + label + glyph, never colour alone),
 * password presence, expiry + created dates (Damascus, mono/bidi). There is NO
 * token — an admin has no content path; a share is identified and force-revoked
 * by its row `id` (destructive → confirm Modal).
 */
export default function SharesTable() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useAdminShares();
  const shares = Array.isArray(data) ? data : [];
  const [revokeTarget, setRevokeTarget] = useState<AdminShareDto | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-display text-lg text-ink">{t('admin.shares.title')}</h2>

      {isPending && <p className="font-body text-sm text-ink-2">{t('admin.shares.loading')}</p>}
      {isError && (
        <p role="alert" className="font-body text-sm text-clay">
          {t('admin.shares.error')}
        </p>
      )}
      {!isPending && !isError && shares.length === 0 && (
        <p className="font-body text-sm text-ink-2">{t('admin.shares.empty')}</p>
      )}

      {!isPending && !isError && shares.length > 0 && (
        <div className="overflow-x-auto rounded-[10px] border border-line bg-surface">
          <table className="w-full border-collapse font-body text-sm">
            <thead>
              <tr className="border-b border-line text-ink-2">
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.shares.col.owner')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.shares.col.item')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.shares.col.status')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.shares.col.password')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.shares.col.expiry')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.shares.col.created')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">
                  <span className="sr-only">{t('admin.shares.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shares.map((share) => (
                <tr key={share.id} className="border-b border-line last:border-b-0 hover:bg-paper">
                  <td className="ps-3 pe-3 py-2">
                    <div className="flex flex-col gap-1">
                      <bdi dir="ltr" className="font-mono text-ink">
                        {share.owner_username}
                      </bdi>
                      {!share.owner_active && (
                        <span className="font-body text-xs text-ink-2">
                          {t('admin.shares.ownerInactive')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="ps-3 pe-3 py-2 text-ink">{share.node_name ?? '—'}</td>
                  <td className="ps-3 pe-3 py-2">
                    <StatusChip status={share.status} />
                  </td>
                  <td className="ps-3 pe-3 py-2 text-ink-2">
                    {share.has_password ? t('admin.shares.hasPassword') : t('admin.shares.noPassword')}
                  </td>
                  <td className="ps-3 pe-3 py-2">
                    {share.expires_at === null ? (
                      <span className="text-ink-2">{t('admin.shares.noExpiry')}</span>
                    ) : (
                      <bdi dir="ltr" className="font-mono text-ink-2">
                        {formatDate(share.expires_at)}
                      </bdi>
                    )}
                  </td>
                  <td className="ps-3 pe-3 py-2">
                    <bdi dir="ltr" className="font-mono text-ink-2">
                      {formatDate(share.created_at)}
                    </bdi>
                  </td>
                  <td className="ps-3 pe-3 py-2">
                    <div className="flex items-center justify-end">
                      <button type="button" onClick={() => setRevokeTarget(share)} className="text-clay">
                        {t('admin.shares.revoke')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revokeTarget && <RevokeConfirm share={revokeTarget} onClose={() => setRevokeTarget(null)} />}
    </div>
  );
}

function RevokeConfirm({ share, onClose }: { share: AdminShareDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const revoke = useRevokeShare();

  function confirm() {
    revoke.mutate(share.id, {
      onSuccess: () => {
        toast({ kind: 'success', message: t('admin.shares.toast.revoked') });
        onClose();
      },
      onError: () => {
        toast({ kind: 'error', message: t('admin.shares.toast.error') });
        onClose();
      },
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('admin.shares.confirm.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={confirm} disabled={revoke.isPending}>
            {t('admin.shares.confirm.confirm')}
          </Button>
        </>
      }
    >
      <p className="font-body text-sm text-ink">{t('admin.shares.confirm.body')}</p>
    </Modal>
  );
}
