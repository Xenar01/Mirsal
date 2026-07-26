import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth-context';
import { ApiError } from '../../lib/api';

/**
 * Sign-in form. Client-validates that both fields are non-empty (no network
 * call otherwise), then delegates to `useAuth().login`. Minimal markup —
 * Phase J styles it; labels are tied to inputs and the focus ring comes from
 * I1's base styles.
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
      } else {
        setError(t('login.error.generic'));
      }
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-dvh bg-paper text-ink">
      <h1 className="font-display">{t('login.title')}</h1>
      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="login-username">{t('login.username')}</label>
        <input
          id="login-username"
          name="username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <label htmlFor="login-password">{t('login.password')}</label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error !== null && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {t('login.submit')}
        </button>
      </form>
    </main>
  );
}
