import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth-context';
import { apiPost, ApiError } from '../../lib/api';

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
    <main className="min-h-dvh bg-paper text-ink">
      <h1 className="font-display">{t('changePassword.title')}</h1>
      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="cp-current">{t('changePassword.current')}</label>
        <input
          id="cp-current"
          name="current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />

        <label htmlFor="cp-new">{t('changePassword.new')}</label>
        <input
          id="cp-new"
          name="new"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />

        <label htmlFor="cp-confirm">{t('changePassword.confirm')}</label>
        <input
          id="cp-confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />

        <p>{t('changePassword.hint')}</p>

        {error !== null && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {t('changePassword.submit')}
        </button>
      </form>
    </main>
  );
}
