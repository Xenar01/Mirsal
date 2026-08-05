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

        {!isPending && !isError && shares.length > 0 && <ShareList shares={shares} onRevoke={setRevokeTarget} />}
      </div>

      {revokeTarget && <RevokeConfirm share={revokeTarget} onClose={() => setRevokeTarget(null)} />}
    </DashboardShell>
  );
}

/* ── List (desktop table ≥ md / mobile cards < md) ────────────────────── */

/**
 * The two-layout pattern (§M2a/§M2b): the desktop table (wrapper gains
 * `hidden md:block`, the table itself byte-identical to before this refactor)
 * and a sibling `md:hidden` stacked card list — same shares, same handlers,
 * both rendered by the shared `ShareRow` below so there is exactly one place
 * each row's markup/logic is written.
 */
function ShareList({ shares, onRevoke }: { shares: ShareDto[]; onRevoke: (share: ShareDto) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="hidden overflow-x-auto rounded-[10px] border border-line bg-surface md:block">
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
              <ShareRow key={share.id} variant="row" share={share} onRevoke={() => onRevoke(share)} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3 md:hidden">
        {shares.map((share) => (
          <ShareRow key={share.id} variant="card" share={share} onRevoke={() => onRevoke(share)} />
        ))}
      </div>
    </>
  );
}

/**
 * The row's three actions (copy-link / start-stop / revoke). Shared verbatim
 * between the desktop actions cell and the mobile card's action row — the
 * ONLY place these buttons (labels/handlers/classes) are written.
 */
function ShareActionButtons({
  share,
  isToggling,
  onCopy,
  onToggle,
  onRevoke,
}: {
  share: ShareDto;
  isToggling: boolean;
  onCopy: () => void;
  onToggle: () => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button type="button" onClick={onCopy} className="inline-flex items-center gap-1 text-teal">
        <Copy size={16} />
        {t('share.copy')}
      </button>
      <button type="button" onClick={onToggle} disabled={isToggling} className="text-teal disabled:opacity-50">
        {share.is_active ? t('share.stop') : t('share.start')}
      </button>
      <button type="button" onClick={onRevoke} className="text-clay">
        {t('share.revoke')}
      </button>
    </>
  );
}

/**
 * A single share's per-row behavior (toggle/copy-link) plus BOTH of its
 * presentations. `variant` switches ONLY the returned JSX layout — `'row'`
 * renders the desktop `<tr>` byte-identically to before this refactor,
 * `'card'` renders the mobile card — while every handler, derived value, and
 * the shared `ShareActionButtons` above are the single code path both
 * variants call.
 */
function ShareRow({
  share,
  variant = 'row',
  onRevoke,
}: {
  share: ShareDto;
  variant?: 'row' | 'card';
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchShare();

  function toggle() {
    const next = !share.is_active;
    patch.mutate(
      { id: share.id, isActive: next },
      {
        // Trust the server's derived status: restarting a share whose expiry
        // has already lapsed yields 'expired', not 'active' — never claim it
        // "started" from the pre-request flag alone (§3.3 restart rule).
        onSuccess: (updated) => {
          if (!next) {
            toast({ kind: 'success', message: t('share.toast.stopped') });
          } else if (updated.status === 'active') {
            toast({ kind: 'success', message: t('share.toast.started') });
          } else {
            toast({ kind: 'error', message: t('share.toast.startedExpired') });
          }
        },
        onError: () => toast({ kind: 'error', message: t('share.toast.error') }),
      },
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

  if (variant === 'card') {
    return (
      <div data-testid={`shared-card-${share.id}`} className="rounded-[10px] border border-line bg-surface p-3">
        <div className="flex items-center gap-2">
          <bdi dir="ltr" className="min-w-0 flex-1 break-all font-mono text-ink">
            {share.token}
          </bdi>
          <span className="shrink-0">
            <StatusChip status={share.status} />
          </span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink-2">
          <bdi dir="ltr" className="font-mono">
            {formatDate(share.created_at)}
          </bdi>
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          <ShareActionButtons
            share={share}
            isToggling={patch.isPending}
            onCopy={copyLink}
            onToggle={toggle}
            onRevoke={onRevoke}
          />
        </div>
      </div>
    );
  }

  return (
    <tr className="border-b border-line last:border-b-0 hover:bg-paper">
      <td className="ps-3 pe-3 py-2">
        <bdi dir="ltr" className="break-all font-mono text-ink">
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
          <ShareActionButtons
            share={share}
            isToggling={patch.isPending}
            onCopy={copyLink}
            onToggle={toggle}
            onRevoke={onRevoke}
          />
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
