import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal';
import Button from '../../components/Button';
import { useToast } from '../../components/Toast';
import { useCreateUser } from './queries';
import { USERNAME_RE, MIN_PASSWORD_LEN, adminErrorCode } from './api';
import { generatePassword } from './password';
import RevealOncePanel from './RevealOncePanel';

/*
 * CreateUserModal (§3.1) — provisions a new account.
 *
 * The initial password is GENERATED client-side with a CSPRNG (regenerable,
 * and editable if the admin prefers their own — still ≥8). On a successful
 * create the server returns the user DTO but NEVER the password, so the modal
 * flips to a reveal-once panel that shows the submitted password exactly once
 * (copy + done). New users are `must_change_password=1` (server-set), surfaced
 * in the reveal copy. Username is validated against the same regex the server
 * enforces; a 409 `username_taken` keeps the form with an inline error.
 */
export default function CreateUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const create = useCreateUser();

  const usernameId = useId();
  const roleId = useId();
  const quotaId = useId();
  const passwordId = useId();

  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [quotaMb, setQuotaMb] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The password revealed once after a successful create (null = still on form).
  const [revealed, setRevealed] = useState<string | null>(null);

  // Reset + freshly generate on every open so a reused modal never leaks the
  // previous account's state or password.
  useEffect(() => {
    if (open) {
      setUsername('');
      setRole('user');
      setQuotaMb('');
      setPassword(generatePassword());
      setError(null);
      setRevealed(null);
    }
  }, [open]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const trimmedUser = username.trim();
    if (!USERNAME_RE.test(trimmedUser)) {
      setError(t('admin.create.usernameInvalid'));
      return;
    }
    if (password.length < MIN_PASSWORD_LEN) {
      setError(t('admin.create.passwordTooShort'));
      return;
    }
    let quotaBytes: number | null = null;
    const rawQuota = quotaMb.trim();
    if (rawQuota !== '') {
      const mb = Number(rawQuota);
      if (!Number.isFinite(mb) || !Number.isInteger(mb) || mb <= 0) {
        setError(t('admin.create.quotaInvalid'));
        return;
      }
      quotaBytes = mb * 1024 * 1024;
    }
    setError(null);

    create.mutate(
      { username: trimmedUser, password, role, quotaBytes },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('admin.users.toast.created') });
          setRevealed(password);
        },
        onError: (err) => {
          setError(
            adminErrorCode(err) === 'username_taken'
              ? t('admin.create.usernameTaken')
              : t('admin.create.error')
          );
        },
      }
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('admin.create.title')}
      footer={
        revealed === null ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => submit()} disabled={create.isPending}>
              {t('admin.create.submit')}
            </Button>
          </>
        ) : undefined
      }
    >
      {revealed !== null ? (
        <RevealOncePanel password={revealed} onDone={onClose} />
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <label htmlFor={usernameId} className="block font-body text-sm text-ink-2">
              {t('admin.create.usernameLabel')}
            </label>
            <input
              id={usernameId}
              type="text"
              dir="ltr"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-mono text-sm text-ink"
            />
            <p className="mt-1 font-body text-xs text-ink-2">{t('admin.create.usernameHint')}</p>
          </div>

          <div>
            <label htmlFor={roleId} className="block font-body text-sm text-ink-2">
              {t('admin.create.roleLabel')}
            </label>
            <select
              id={roleId}
              value={role}
              onChange={(e) => setRole(e.target.value as 'admin' | 'user')}
              className="mt-1 w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
            >
              <option value="user">{t('admin.users.role.user')}</option>
              <option value="admin">{t('admin.users.role.admin')}</option>
            </select>
          </div>

          <div>
            <label htmlFor={quotaId} className="block font-body text-sm text-ink-2">
              {t('admin.create.quotaLabel')}
            </label>
            <input
              id={quotaId}
              type="number"
              inputMode="numeric"
              min={1}
              dir="ltr"
              value={quotaMb}
              onChange={(e) => setQuotaMb(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-mono text-sm text-ink"
            />
            <p className="mt-1 font-body text-xs text-ink-2">{t('admin.create.quotaHint')}</p>
          </div>

          <div>
            <label htmlFor={passwordId} className="block font-body text-sm text-ink-2">
              {t('admin.create.passwordLabel')}
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id={passwordId}
                type="text"
                dir="ltr"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-mono text-sm text-ink"
              />
              <Button
                variant="secondary"
                onClick={() => setPassword(generatePassword())}
                className="shrink-0"
              >
                {t('admin.create.regenerate')}
              </Button>
            </div>
            <p className="mt-1 font-body text-xs text-ink-2">{t('admin.create.passwordHint')}</p>
          </div>

          {error !== null && (
            <p role="alert" className="font-body text-sm text-clay">
              {error}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}
