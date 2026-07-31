import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth-context';
import { apiPost, ApiError } from '../../lib/api';
import AuthCard from './AuthCard';
import Button from '../../components/Button';

/** Server enforces the same minimum (auth.ts: `new` MUST be ≥ 8 chars). */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Forced password change (`mustChangePassword`). Client-validates that all
 * fields are filled, the new password is ≥ 8 chars, and new === confirm, then
 * POSTs `/api/auth/password`. On success it `refresh()`es the user (which
 * clears `mustChangePassword`) and returns to the dashboard.
 */
export default function ChangePasswordPage() {
  const { t } = useTranslation();
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current || !next || !confirm) {
      setError(t('changePassword.validation.required'));
      return;
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(t('changePassword.validation.tooShort'));
      return;
    }
    if (next !== confirm) {
      setError(t('changePassword.validation.mismatch'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await apiPost('/auth/password', { current, new: next });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError(t('changePassword.error.invalidCurrent'));
      } else {
        setError(t('changePassword.error.generic'));
      }
      setSubmitting(false);
    }
  }

  return (
    <AuthCard title={t('changePassword.title')}>
      <form onSubmit={onSubmit} noValidate className="flex w-full flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cp-current" className="font-body text-sm text-ink-2">
            {t('changePassword.current')}
          </label>
          <input
            id="cp-current"
            name="current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="w-full rounded-lg border border-line bg-paper px-3 py-2 font-body text-sm text-ink"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="cp-new" className="font-body text-sm text-ink-2">
            {t('changePassword.new')}
          </label>
          <input
            id="cp-new"
            name="new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="w-full rounded-lg border border-line bg-paper px-3 py-2 font-body text-sm text-ink"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="cp-confirm" className="font-body text-sm text-ink-2">
            {t('changePassword.confirm')}
          </label>
          <input
            id="cp-confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded-lg border border-line bg-paper px-3 py-2 font-body text-sm text-ink"
          />
        </div>

        <p className="font-body text-xs text-ink-2">{t('changePassword.hint')}</p>

        {error !== null && (
          <p role="alert" className="font-body text-sm text-clay">
            {error}
          </p>
        )}

        <Button type="submit" disabled={submitting} className="mt-1 w-full">
          {t('changePassword.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
