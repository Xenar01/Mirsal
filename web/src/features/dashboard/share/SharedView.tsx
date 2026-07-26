import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../components/Modal';
import Button from '../../../components/Button';
import StatusChip from '../../../components/StatusChip';
import { useToast } from '../../../components/Toast';
import { Copy } from '../../../components/icons';
import DashboardShell from '../DashboardShell';
import { formatDate } from '../format';
import { useShares, usePatchShare, useRevokeShare } from './queries';
import type { ShareDto } from './types';

/*
 * SharedView — the "Shared" register (§3.3 / §4.6).
 *
 * Lists the owner's shares (GET /api/shares, newest first) as a dispatch
 * register: the token and creation date are mono ledger data, each bidi-
 * isolated LTR (§4.3/§4.5); the status column is a StatusChip that pairs colour
 * with a label + glyph (never colour alone, §3.3). Per row the owner can copy
 * the link, start/stop it, or revoke it (confirmed). The empty state uses the
 * authored §4.9 copy verbatim. Deep per-share editing (password, expiry) lives
 * in the ShareModal reached from the file register.
 */
export default function SharedView() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useShares();
  const shares = Array.isArray(data) ? data : [];
  const [revokeTarget, setRevokeTarget] = useState<ShareDto | null>(null);

  return (
    <DashboardShell>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-lg text-ink">{t('shared.title')}</h1>
          <p className="font-body text-sm text-ink-2">{t('shared.subtitle')}</p>
        </div>

        {isPending && <p className="font-body text-sm text-ink-2">{t('shared.loading')}</p>}
        {isError && (
          <p role="alert" className="font-body text-sm text-clay">
            {t('shared.error')}
          </p>
        )}
        {!isPending && !isError && shares.length === 0 && (
          // §4.9 empty-Shared copy, verbatim.
          <p className="font-body text-sm text-ink-2">{t('shared.empty')}</p>
        )}

        {!isPending && !isError && shares.length > 0 && (
          <div className="overflow-x-auto rounded-[10px] border border-line bg-surface">
            <table className="w-full border-collapse font-body text-sm">
              <thead>
                <tr className="border-b border-line text-ink-2">
                  <th className="ps-3 pe-3 py-2 text-start font-medium">{t('shared.col.token')}</th>
                  <th className="ps-3 pe-3 py-2 text-start font-medium">{t('shared.col.status')}</th>
                  <th className="ps-3 pe-3 py-2 text-start font-medium">{t('shared.col.created')}</th>
                  <th className="ps-3 pe-3 py-2 text-start font-medium">
                    <span className="sr-only">{t('shared.col.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shares.map((share) => (
                  <ShareRow key={share.id} share={share} onRevoke={() => setRevokeTarget(share)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {revokeTarget && (
        <RevokeConfirm share={revokeTarget} onClose={() => setRevokeTarget(null)} />
      )}
    </DashboardShell>
  );
}

function ShareRow({ share, onRevoke }: { share: ShareDto; onRevoke: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchShare();

  function toggle() {
    const next = !share.is_active;
    patch.mutate(
      { id: share.id, isActive: next },
      {
        onSuccess: () =>
          toast({
            kind: 'success',
            message: next ? t('share.toast.started') : t('share.toast.stopped'),
          }),
        onError: () => toast({ kind: 'error', message: t('share.toast.error') }),
      }
    );
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(share.url);
      toast({ kind: 'success', message: t('share.toast.copied') });
    } catch {
      toast({ kind: 'error', message: t('share.toast.copyFailed') });
    }
  }

  return (
    <tr className="border-b border-line last:border-b-0 hover:bg-paper">
      <td className="ps-3 pe-3 py-2">
        <bdi dir="ltr" className="font-mono text-ink">
          {share.token}
        </bdi>
      </td>
      <td className="ps-3 pe-3 py-2">
        <StatusChip status={share.status} />
      </td>
      <td className="ps-3 pe-3 py-2">
        <bdi dir="ltr" className="font-mono text-ink-2">
          {formatDate(share.created_at)}
        </bdi>
      </td>
      <td className="ps-3 pe-3 py-2">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex items-center gap-1 text-teal"
          >
            <Copy size={16} />
            {t('share.copy')}
          </button>
          <button
            type="button"
            onClick={toggle}
            disabled={patch.isPending}
            className="text-teal disabled:opacity-50"
          >
            {share.is_active ? t('share.stop') : t('share.start')}
          </button>
          <button type="button" onClick={onRevoke} className="text-clay">
            {t('share.revoke')}
          </button>
        </div>
      </td>
    </tr>
  );
}

function RevokeConfirm({ share, onClose }: { share: ShareDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const revoke = useRevokeShare();

  function confirm() {
    revoke.mutate(share.id, {
      onSuccess: () => {
        toast({ kind: 'success', message: t('share.toast.revoked') });
        onClose();
      },
      onError: () => {
        toast({ kind: 'error', message: t('share.toast.error') });
        onClose();
      },
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('share.confirm.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('share.confirm.cancel')}
          </Button>
          <Button variant="danger" onClick={confirm} disabled={revoke.isPending}>
            {t('share.confirm.confirm')}
          </Button>
        </>
      }
    >
      <p className="font-body text-sm text-ink">{t('share.confirm.body')}</p>
    </Modal>
  );
}
