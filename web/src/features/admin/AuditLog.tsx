import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../../components/Button';
import { formatDate } from '../dashboard/format';
import { useAudit } from './queries';
import { AUDIT_PAGE_SIZE, USER_TARGET_ACTIONS } from './api';
import type { AuditRowDto } from './types';

/*
 * AuditLog (§3.1) — the read-only audit register, paginated.
 *
 * Rows: timestamp (Damascus, mono/bidi), actor (id, or the system label for a
 * null actor), a friendly Arabic action label (falling back to the raw machine
 * action for anything unmapped), and the target (a DB id or an already-redacted
 * secret — the server redacts token-valued targets before they leave the box).
 * Read-only: no row actions. Prev/Next page through `['admin','audit', page]`.
 */
export default function AuditLog() {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const { data, isPending, isError, isPlaceholderData } = useAudit(page);
  const rows = Array.isArray(data) ? data : [];
  // A full page implies there may be more; a short page is the last one.
  const hasNext = rows.length === AUDIT_PAGE_SIZE;

  function actionLabel(action: string): string {
    const key = `admin.audit.action.${action}`;
    const translated = t(key);
    // i18next returns the key itself when unmapped — fall back to the raw action.
    return translated === key ? action : translated;
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-display text-lg text-ink">{t('admin.audit.title')}</h2>

      {isPending && <p className="font-body text-sm text-ink-2">{t('admin.audit.loading')}</p>}
      {isError && (
        <p role="alert" className="font-body text-sm text-clay">
          {t('admin.audit.error')}
        </p>
      )}
      {!isPending && !isError && rows.length === 0 && (
        <p className="font-body text-sm text-ink-2">{t('admin.audit.empty')}</p>
      )}

      {!isPending && !isError && rows.length > 0 && (
        <div className="overflow-x-auto rounded-[10px] border border-line bg-surface">
          <table className="w-full border-collapse font-body text-sm">
            <thead>
              <tr className="border-b border-line text-ink-2">
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.audit.col.time')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.audit.col.actor')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.audit.col.action')}</th>
                <th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.audit.col.target')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry: AuditRowDto) => (
                <tr key={entry.id} className="border-b border-line last:border-b-0">
                  <td className="ps-3 pe-3 py-2">
                    <bdi dir="ltr" className="font-mono text-ink-2">
                      {formatDate(entry.created_at)}
                    </bdi>
                  </td>
                  <td className="ps-3 pe-3 py-2">
                    {entry.actor_id === null ? (
                      <span className="text-ink-2">{t('admin.audit.system')}</span>
                    ) : entry.actor_display_name || entry.actor_username ? (
                      <span className="font-body text-ink">
                        {entry.actor_display_name || entry.actor_username}
                      </span>
                    ) : (
                      <bdi dir="ltr" className="font-mono text-ink">
                        {`#${entry.actor_id}`}
                      </bdi>
                    )}
                  </td>
                  <td className="ps-3 pe-3 py-2 text-ink">{actionLabel(entry.action)}</td>
                  <td className="ps-3 pe-3 py-2">
                    {entry.target === null ? (
                      <span className="text-ink-2">—</span>
                    ) : entry.target_display_name || entry.target_username ? (
                      <span className="font-body text-ink-2">
                        {entry.target_display_name || entry.target_username}
                      </span>
                    ) : USER_TARGET_ACTIONS.has(entry.action) ? (
                      <bdi dir="ltr" className="font-mono text-ink-2 break-all">
                        {`#${entry.target} ${t('admin.audit.deleted')}`}
                      </bdi>
                    ) : (
                      <bdi dir="ltr" className="font-mono text-ink-2 break-all">
                        {entry.target}
                      </bdi>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isError && (page > 0 || hasNext) && (
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="secondary"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || isPlaceholderData}
          >
            {t('admin.audit.prev')}
          </Button>
          <span className="font-body text-sm text-ink-2">
            {t('admin.audit.page', { page: page + 1 })}
          </span>
          <Button
            variant="secondary"
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasNext || isPlaceholderData}
          >
            {t('admin.audit.next')}
          </Button>
        </div>
      )}
    </div>
  );
}
