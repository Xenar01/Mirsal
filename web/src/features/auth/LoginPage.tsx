import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth-context';
import { ApiError } from '../../lib/api';
import AuthCard from './AuthCard';
import Button from '../../components/Button';

/**
 * Sign-in form. Client-validates that both fields are non-empty (no network
 * call otherwise), then delegates to `useAuth().login`. Presented in the
 * sealed-dispatch AuthCard; labels are tied to inputs and the focus ring comes
 * from the global :focus-visible base style.
 */
export default function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError(t('login.validation.required'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError(t('login.error.rateLimited'));
      } else if (err instanceof ApiError && err.status === 401) {
        setError(t('login.error.invalidCredentials'));
      } else if (err instanceof ApiError && err.status === 403) {
        setError(t('login.error.deactivated'));
      } else {
        setError(t('login.error.generic'));
      }
      setSubmitting(false);
    }
  }

  return (
    <AuthCard title={t('login.title')}>
      <form onSubmit={onSubmit} noValidate className="flex w-full flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-username" className="font-body text-sm text-ink-2">
            {t('login.username')}
          </label>
          <input
            id="login-username"
            name="username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-line bg-paper px-3 py-2 font-body text-sm text-ink"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-password" className="font-body text-sm text-ink-2">
            {t('login.password')}
          </label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-line bg-paper px-3 py-2 font-body text-sm text-ink"
          />
        </div>

        {error !== null && (
          <p role="alert" className="font-body text-sm text-clay">
            {error}
          </p>
        )}

        <Button type="submit" disabled={submitting} className="mt-1 w-full">
          {t('login.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
