import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../../components/Button';
import { SealHeader } from '../public/DispatchFrame';
import { unlockCollection } from './api';

/*
 * CollectPasswordGate — the pre-unlock screen for a password-protected
 * collection request (mirrors `features/public/PasswordGate.tsx` exactly,
 * swapped onto the collect-intake endpoints).
 *
 * Reveals ONLY branding + the "password-protected" line — never the title,
 * departments, or template (the server enforces this; the UI must not even
 * request metadata pre-unlock — `CollectPage` only calls `useCollectMeta` with
 * `reveal:false` until this gate succeeds). Submitting posts the password via
 * the direct-fetch `unlockCollection` so the wrong-password copy can show the
 * header-derived attempts remaining; on success it calls `onUnlocked`, and the
 * page re-fetches metadata (the unlock cookie now unlocks it). Rate-limit
 * (429) and header-absent cases degrade to their own authored copy.
 */
export default function CollectPasswordGate({ token, onUnlocked }: { token: string; onUnlocked: () => void }) {
  const { t } = useTranslation();
  const inputId = useId();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await unlockCollection(token, password);
    setSubmitting(false);

    switch (result.kind) {
      case 'ok':
        onUnlocked();
        return;
      case 'wrong':
        setError(
          result.remaining !== null
            ? t('collect.wrongPassword', { count: result.remaining })
            : t('collect.wrongPasswordNoCount'),
        );
        return;
      case 'rateLimited':
        setError(t('collect.tooManyAttempts'));
        return;
      default:
        setError(t('collect.error'));
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col items-center gap-5 text-center">
      <SealHeader />

      <p className="font-body text-base text-ink-2">{t('collect.passwordGate')}</p>

      <div className="flex w-full max-w-xs flex-col gap-1 text-start">
        <label htmlFor={inputId} className="font-body text-sm text-ink-2">
          {t('collect.passwordLabel')}
        </label>
        <input
          id={inputId}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
        />
        {error !== null && (
          <p role="alert" className="mt-1 font-body text-sm text-clay">
            {error}
          </p>
        )}
      </div>

      <Button variant="primary" type="submit" disabled={submitting || password.length === 0}>
        {t('collect.unlock')}
      </Button>
    </form>
  );
}
