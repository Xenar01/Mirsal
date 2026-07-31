import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal';
import Button from '../../components/Button';
import { Stamp, Pause } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/auth-context';
import { formatBytes, formatDate } from '../dashboard/format';
import { useAdminUsers, usePatchUser, useResetPassword, useDeleteUser } from './queries';
import { loweringGuard } from './guards';
import { adminErrorCode } from './api';
import CreateUserModal from './CreateUserModal';
import RevealOncePanel from './RevealOncePanel';
import type { AdminUserDto } from './types';

/*
 * UsersTable (§3.1) — the users "dispatch register".
 *
 * Columns: username (an ASCII handle → mono, bidi-isolated LTR), role, active
 * state (label + glyph, never colour alone), a usage bar (used / quota; a null
 * quota reads "unlimited"), and the created date (Damascus). Row actions —
 * activate/deactivate, promote/demote, reset password (reveal-once), change
 * quota, delete — carry the last-admin / self guards: the only-active-admin and
 * the logged-in admin can't deactivate/demote/delete (disabled + a tooltip
 * reason). The server 409s are still handled gracefully (the guard is UX only).
 */
// Compact chip-button styling for the user-row actions (matches the drive
// register), so a row of actions reads as a toolbar of buttons, not bare text.
const ADMIN_ACTION =
  'inline-flex items-center rounded-md border border-line px-2.5 py-1 font-body text-xs text-teal transition-colors hover:bg-paper focus-visible:bg-paper';
const ADMIN_ACTION_DANGER =
  'inline-flex items-center rounded-md border border-line px-2.5 py-1 font-body text-xs text-clay transition-colors hover:bg-paper focus-visible:bg-paper';

export default function UsersTable() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { data, isPending, isError } = useAdminUsers();
  const users = Array.isArray(data) ? data : [];

  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUserDto | null>(null);
  const [quotaTarget, setQuotaTarget] = useState<AdminUserDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUserDto | null>(null);
  const [labelTarget, setLabelTarget] = useState<AdminUserDto | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg text-ink">{t('admin.users.title')}</h2>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          {t('admin.users.create')}
        </Button>
      </div>

      {isPending && <p className="font-body text-sm text-ink-2">{t('admin.users.loading')}</p>}
      {isError && (
        <p role="alert" className="font-body text-sm text-clay">
          {t('admin.users.error')}
        </p>
      )}
      {!isPending && !isError && users.length === 0 && (
        <p className="font-body text-sm text-ink-2">{t('admin.users.empty')}</p>
      )}

      {!isPending && !isError && users.length > 0 && (
        <div className="overflow-x-auto rounded-[10px] border border-line bg-surface">
          <table className="w-full border-collapse font-body text-sm">
            <thead>
              <tr className="border-b border-line text-ink-2">
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.users.col.username')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.users.col.name')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.users.col.role')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.users.col.state')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.users.col.usage')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.users.col.created')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">
                  <span className="sr-only">{t('admin.users.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((row) => (
                <UserRow
                  key={row.id}
                  row={row}
                  users={users}
                  currentUserId={user?.id}
                  onReset={() => setResetTarget(row)}
                  onQuota={() => setQuotaTarget(row)}
                  onDelete={() => setDeleteTarget(row)}
                  onLabel={() => setLabelTarget(row)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} />
      {resetTarget && <ResetPasswordModal user={resetTarget} onClose={() => setResetTarget(null)} />}
      {quotaTarget && <QuotaModal user={quotaTarget} onClose={() => setQuotaTarget(null)} />}
      {deleteTarget && <DeleteUserModal user={deleteTarget} onClose={() => setDeleteTarget(null)} />}
      {labelTarget && <LabelModal user={labelTarget} onClose={() => setLabelTarget(null)} />}
    </div>
  );
}

/* ── State badge (label + glyph, never colour-only) ───────────────────── */

function StateBadge({ active }: { active: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${active ? 'text-emerald' : 'text-ink-2'}`}
    >
      {active ? <Stamp size={15} /> : <Pause size={15} />}
      <span>{active ? t('admin.users.state.active') : t('admin.users.state.inactive')}</span>
    </span>
  );
}

/* ── Usage bar ─────────────────────────────────────────────────────────── */

function UsageCell({ user }: { user: AdminUserDto }) {
  const { t } = useTranslation();
  const used = formatBytes(user.used_bytes);

  if (user.quota_bytes === null) {
    return (
      <div className="flex flex-col gap-1">
        <span className="font-body text-xs text-ink-2">{t('admin.users.unlimited')}</span>
        <bdi dir="ltr" className="font-mono text-xs text-ink-2">
          {used}
        </bdi>
      </div>
    );
  }

  const quota = user.quota_bytes;
  const fraction = quota > 0 ? Math.min(1, user.used_bytes / quota) : 1;
  const over = user.used_bytes > quota;
  const pct = Math.round(fraction * 100);

  return (
    <div className="flex min-w-32 flex-col gap-1">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={quota}
        aria-valuenow={user.used_bytes}
        aria-label={`${used} / ${formatBytes(quota)}`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-line"
      >
        {/* Brass is a decorative FILL here (§4.1 legal use); clay flags over-quota,
            but the numeric used/quota text below carries the same signal so it is
            never colour-only. */}
        <div
          className={`h-full ${over ? 'bg-clay' : 'bg-brass'}`}
          style={{ inlineSize: `${pct}%` }}
        />
      </div>
      <bdi dir="ltr" className={`font-mono text-xs ${over ? 'text-clay' : 'text-ink-2'}`}>
        {used} / {formatBytes(quota)}
      </bdi>
    </div>
  );
}

/* ── Guarded row action (accessible last-admin / self guard) ──────────── */

/*
 * A row action that may be blocked by the last-admin / self guard. When
 * blocked it must stay DISCOVERABLE: native `disabled` makes a button both
 * unfocusable and (in Chromium/WebKit) an unreliable `title` host, which hides
 * the required guard explanation from keyboard and often mouse users. So the
 * guard uses `aria-disabled` (keeps the control focusable + in the a11y tree)
 * and points `aria-describedby` at the visible reason note rendered alongside;
 * the click is a no-op while blocked. Native `disabled` is reserved for the
 * transient in-flight (`pending`) state only.
 */
function GuardedAction({
  onAct,
  guardBlocked,
  reasonId,
  pending,
  className,
  children,
}: {
  onAct: () => void;
  guardBlocked: boolean;
  reasonId: string;
  pending?: boolean;
  className: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (guardBlocked) return;
        onAct();
      }}
      disabled={pending}
      aria-disabled={guardBlocked || undefined}
      aria-describedby={guardBlocked ? reasonId : undefined}
      className={`${className} aria-disabled:cursor-not-allowed aria-disabled:opacity-50 disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {children}
    </button>
  );
}

/* ── User row ─────────────────────────────────────────────────────────── */

function UserRow({
  row,
  users,
  currentUserId,
  onReset,
  onQuota,
  onDelete,
  onLabel,
}: {
  row: AdminUserDto;
  users: AdminUserDto[];
  currentUserId: number | undefined;
  onReset: () => void;
  onQuota: () => void;
  onDelete: () => void;
  onLabel: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchUser();
  const reasonId = useId();

  const active = row.is_active === 1;
  const isAdmin = row.role === 'admin';
  const guard = loweringGuard(row, users, currentUserId);
  const guardReason = guard.reasonKey ? t(guard.reasonKey) : undefined;

  /** Surfaces a server 409 guard code (or a generic error) as a toast. */
  function onMutError(err: unknown) {
    const code = adminErrorCode(err);
    if (code === 'last_admin') toast({ kind: 'error', message: t('admin.guard.lastAdmin') });
    else if (code === 'self') toast({ kind: 'error', message: t('admin.guard.self') });
    else toast({ kind: 'error', message: t('admin.users.toast.error') });
  }

  function toggleActive() {
    const next = !active;
    patch.mutate(
      { id: row.id, isActive: next },
      {
        onSuccess: () =>
          toast({
            kind: 'success',
            message: next ? t('admin.users.toast.activated') : t('admin.users.toast.deactivated'),
          }),
        onError: onMutError,
      }
    );
  }

  function toggleRole() {
    const next = isAdmin ? 'user' : 'admin';
    patch.mutate(
      { id: row.id, role: next },
      {
        onSuccess: () =>
          toast({
            kind: 'success',
            message: next === 'admin' ? t('admin.users.toast.promoted') : t('admin.users.toast.demoted'),
          }),
        onError: onMutError,
      }
    );
  }

  return (
    <tr data-testid={`user-row-${row.id}`} className="border-b border-line last:border-b-0 align-top hover:bg-paper">
      <td className="ps-3 pe-3 py-2">
        <div className="flex flex-col gap-1">
          <bdi dir="ltr" className="font-mono text-ink">
            {row.username}
          </bdi>
          {row.must_change_password === 1 && (
            <span className="font-body text-xs text-ink-2">{t('admin.users.mustChange')}</span>
          )}
        </div>
      </td>
      <td className="ps-3 pe-3 py-2">
        {row.display_name ? (
          <span className="font-body text-ink">{row.display_name}</span>
        ) : (
          <span className="font-body text-ink-2">{t('admin.users.noName')}</span>
        )}
      </td>
      <td className="ps-3 pe-3 py-2 text-ink">
        {isAdmin ? t('admin.users.role.admin') : t('admin.users.role.user')}
      </td>
      <td className="ps-3 pe-3 py-2">
        <StateBadge active={active} />
      </td>
      <td className="ps-3 pe-3 py-2">
        <UsageCell user={row} />
      </td>
      <td className="ps-3 pe-3 py-2">
        <bdi dir="ltr" className="font-mono text-ink-2">
          {formatDate(row.created_at)}
        </bdi>
      </td>
      <td className="ps-3 pe-3 py-2">
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {active ? (
              <GuardedAction
                onAct={toggleActive}
                guardBlocked={guard.blocked}
                reasonId={reasonId}
                pending={patch.isPending}
                className={ADMIN_ACTION}
              >
                {t('admin.users.action.deactivate')}
              </GuardedAction>
            ) : (
              <button
                type="button"
                onClick={toggleActive}
                disabled={patch.isPending}
                className={`${ADMIN_ACTION} disabled:opacity-50`}
              >
                {t('admin.users.action.activate')}
              </button>
            )}

            {isAdmin ? (
              <GuardedAction
                onAct={toggleRole}
                guardBlocked={guard.blocked}
                reasonId={reasonId}
                pending={patch.isPending}
                className={ADMIN_ACTION}
              >
                {t('admin.users.action.demote')}
              </GuardedAction>
            ) : (
              <button
                type="button"
                onClick={toggleRole}
                disabled={patch.isPending}
                className={`${ADMIN_ACTION} disabled:opacity-50`}
              >
                {t('admin.users.action.promote')}
              </button>
            )}

            <button type="button" onClick={onReset} className={ADMIN_ACTION}>
              {t('admin.users.action.resetPassword')}
            </button>
            <button type="button" onClick={onQuota} className={ADMIN_ACTION}>
              {t('admin.users.action.quota')}
            </button>
            <button type="button" onClick={onLabel} className={ADMIN_ACTION}>
              {t('admin.users.action.label')}
            </button>
            <GuardedAction
              onAct={onDelete}
              guardBlocked={guard.blocked}
              reasonId={reasonId}
              className={ADMIN_ACTION_DANGER}
            >
              {t('admin.users.action.delete')}
            </GuardedAction>
          </div>

          {/* The guard reason is shown as VISIBLE text (discoverable to mouse
              users) and linked to every guarded control via aria-describedby —
              the guarded buttons stay focusable (aria-disabled, not native
              `disabled`), so keyboard + AT users reach the explanation too. */}
          {guard.blocked && guardReason && (
            <p id={reasonId} className="max-w-xs text-end font-body text-xs text-ink-2">
              {guardReason}
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}

/* ── Reset password (reveal-once) ─────────────────────────────────────── */

function ResetPasswordModal({ user, onClose }: { user: AdminUserDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const reset = useResetPassword();
  const [revealed, setRevealed] = useState<string | null>(null);

  function confirm() {
    reset.mutate(user.id, {
      onSuccess: (res) => setRevealed(res.password),
      onError: () => toast({ kind: 'error', message: t('admin.reset.error') }),
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('admin.reset.title')}
      footer={
        revealed === null ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={confirm} disabled={reset.isPending}>
              {t('admin.reset.confirm')}
            </Button>
          </>
        ) : undefined
      }
    >
      {revealed !== null ? (
        <RevealOncePanel password={revealed} onDone={onClose} />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="font-body text-sm text-ink">
            <bdi dir="ltr" className="font-mono">
              {user.username}
            </bdi>
          </p>
          <p className="font-body text-sm text-ink-2">{t('admin.reset.warning')}</p>
        </div>
      )}
    </Modal>
  );
}

/* ── Change quota ─────────────────────────────────────────────────────── */

function QuotaModal({ user, onClose }: { user: AdminUserDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchUser();
  const inputId = useId();

  const initialMb = user.quota_bytes === null ? '' : String(Math.round(user.quota_bytes / (1024 * 1024)));
  const [mb, setMb] = useState(initialMb);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    let quotaBytes: number | null = null;
    const raw = mb.trim();
    if (raw !== '') {
      const value = Number(raw);
      if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        setError(t('admin.quota.invalid'));
        return;
      }
      quotaBytes = value * 1024 * 1024;
    }
    setError(null);
    patch.mutate(
      { id: user.id, quotaBytes },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('admin.users.toast.quotaUpdated') });
          onClose();
        },
        onError: () => toast({ kind: 'error', message: t('admin.quota.error') }),
      }
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('admin.quota.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={patch.isPending}>
            {t('admin.quota.submit')}
          </Button>
        </>
      }
    >
      <label htmlFor={inputId} className="block font-body text-sm text-ink-2">
        {t('admin.quota.label')}
      </label>
      <input
        id={inputId}
        type="number"
        inputMode="numeric"
        min={1}
        dir="ltr"
        value={mb}
        onChange={(e) => setMb(e.target.value)}
        className="mt-1 w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-mono text-sm text-ink"
      />
      <p className="mt-1 font-body text-xs text-ink-2">{t('admin.quota.hint')}</p>
      {error !== null && (
        <p role="alert" className="mt-2 font-body text-sm text-clay">
          {error}
        </p>
      )}
    </Modal>
  );
}

/* ── Edit display name ────────────────────────────────────────────────── */

function LabelModal({ user, onClose }: { user: AdminUserDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchUser();
  const inputId = useId();
  const [value, setValue] = useState(user.display_name ?? '');

  function submit() {
    const trimmed = value.trim();
    patch.mutate(
      { id: user.id, displayName: trimmed === '' ? null : trimmed },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('admin.users.toast.nameUpdated') });
          onClose();
        },
        onError: () => toast({ kind: 'error', message: t('admin.label.error') }),
      }
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('admin.label.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={patch.isPending}>
            {t('admin.label.submit')}
          </Button>
        </>
      }
    >
      <label htmlFor={inputId} className="block font-body text-sm text-ink-2">
        {t('admin.label.label')}
      </label>
      <input
        id={inputId}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="mt-1 w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
      />
      <p className="mt-1 font-body text-xs text-ink-2">{t('admin.label.hint')}</p>
    </Modal>
  );
}

/* ── Delete user (destructive confirm) ────────────────────────────────── */

function DeleteUserModal({ user, onClose }: { user: AdminUserDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const remove = useDeleteUser();

  function confirm() {
    remove.mutate(user.id, {
      onSuccess: () => {
        toast({ kind: 'success', message: t('admin.users.toast.deleted') });
        onClose();
      },
      onError: (err) => {
        const code = adminErrorCode(err);
        if (code === 'last_admin') toast({ kind: 'error', message: t('admin.guard.lastAdmin') });
        else if (code === 'self') toast({ kind: 'error', message: t('admin.guard.self') });
        else toast({ kind: 'error', message: t('admin.delete.error') });
        onClose();
      },
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('admin.delete.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={confirm} disabled={remove.isPending}>
            {t('admin.delete.confirm')}
          </Button>
        </>
      }
    >
      <p className="font-body text-sm text-ink">
        {t('admin.delete.body', { username: user.username })}
      </p>
    </Modal>
  );
}
