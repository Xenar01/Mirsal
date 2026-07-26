import { useTranslation } from 'react-i18next';
import { useNodes, useTrash, sumSizes } from './queries';
import { formatBytes } from './format';

/*
 * Storage meter (§3.2).
 *
 * The server exposes NO per-user quota to a non-admin (`GET /api/auth/me` is
 * id/username/role/mustChangePassword only; `quota_bytes`/`used_bytes` live
 * behind the admin routes). Per the J2 brief we therefore DERIVE "used" from
 * the root rollup — the root listing's folder sizes are already server-side
 * subtree rollups, so summing the root children's `size_bytes` is the whole
 * live tree — and show the Trash size separately (trashed bytes still count
 * until permanent delete, §3.2). The quota fraction is omitted rather than
 * invented. If a user-facing quota endpoint is added later, wire a labelled
 * bar here.
 *
 * Numbers are mono ledger data, bidi-isolated LTR (§4.3/§4.5).
 */
export default function StorageMeter() {
  const { t } = useTranslation();
  const rootQuery = useNodes(null);
  const trashQuery = useTrash();

  const usedBytes = sumSizes(rootQuery.data);
  const trashBytes = sumSizes(trashQuery.data);

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
        <div className="flex items-center justify-between gap-3">
          <dt className="text-ink-2">{t('storage.trash')}</dt>
          <dd className="text-ink-2">
            <bdi dir="ltr" className="font-mono">
              {formatBytes(trashBytes)}
            </bdi>
          </dd>
        </div>
      </dl>
      <p className="mt-2 font-body text-xs text-ink-2">{t('storage.noQuota')}</p>
    </section>
  );
}
