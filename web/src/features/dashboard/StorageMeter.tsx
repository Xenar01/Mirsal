import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/auth-context';
import { useTrash, sumSizes } from './queries';
import { formatBytes } from './format';

/*
 * Storage meter (§3.2). "Used" + the quota bar come from the authoritative,
 * server-maintained figures on the session user (`GET /api/auth/me` returns
 * quotaBytes/usedBytes). used_bytes already INCLUDES trashed-but-not-purged
 * bytes, so the trash figure is shown as "of which in trash" (a portion of
 * used, never an additive second total) with a hint that emptying the trash
 * frees the space. When quotaBytes is null the user has no quota and the bar is
 * omitted.
 *
 * Numbers are mono ledger data, bidi-isolated LTR (§4.3/§4.5).
 */
export default function StorageMeter() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const trashQuery = useTrash();
  const trashBytes = sumSizes(trashQuery.data);

  const usedBytes = user?.usedBytes ?? 0;
  const quotaBytes = user?.quotaBytes ?? null;
  const hasQuota = quotaBytes !== null;
  const fraction = hasQuota ? (quotaBytes > 0 ? Math.min(1, usedBytes / quotaBytes) : 1) : 0;
  const over = hasQuota && usedBytes > quotaBytes;

  return (
    <section aria-label={t('storage.title')} className="rounded-[10px] border border-line bg-surface p-3">
      <h2 className="font-display text-sm text-ink">{t('storage.title')}</h2>
      <dl className="mt-2 flex flex-col gap-1 font-body text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-ink-2">{t('storage.used')}</dt>
          <dd className="text-ink">
            <bdi dir="ltr" className="font-mono">
              {formatBytes(usedBytes)}
            </bdi>
          </dd>
        </div>
      </dl>
      {hasQuota ? (
        <div className="mt-2">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            className="h-1.5 w-full overflow-hidden rounded-full border border-line bg-paper"
          >
            <div
              className={`h-full ${over ? 'bg-clay' : 'bg-brass'}`}
              style={{ width: `${fraction * 100}%` }}
            />
          </div>
          <p className="mt-1 font-body text-xs text-ink-2">
            <bdi dir="ltr" className="font-mono">
              {formatBytes(usedBytes)} / {formatBytes(quotaBytes)}
            </bdi>
          </p>
        </div>
      ) : (
        <p className="mt-2 font-body text-xs text-ink-2">{t('storage.noQuota')}</p>
      )}
      {trashBytes > 0 && (
        <div className="mt-2 font-body text-xs text-ink-2">
          <div className="flex items-center justify-between gap-3">
            <span>{t('storage.ofWhichTrash')}</span>
            <bdi dir="ltr" className="font-mono">
              {formatBytes(trashBytes)}
            </bdi>
          </div>
          <p className="mt-0.5 text-ink-2/80">{t('storage.emptyToFree')}</p>
        </div>
      )}
    </section>
  );
}
