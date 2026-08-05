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
 * Rows: timestamp (Damascus, mono/bidi), actor (resolved display-name or
 * username, falling back to `#id` when unresolved, or the system label for a
 * null actor), a friendly Arabic action label (falling back to the raw machine
 * action for anything unmapped), and the target — for user-target actions this
 * resolves to the target user's display-name/username (with a "(محذوف)" hint
 * appended to `#id` when the user no longer resolves), otherwise the raw
 * target as returned by the server (already redacted if it was a secret).
 * Read-only: no row actions. Prev/Next page through `['admin','audit', page]`.
 */
export default function AuditLog() {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const { data, isPending, isError, isPlaceholderData } = useAudit(page);
  const rows = Array.isArray(data) ? data : [];
  // A full page implies there may be more; a short page is the last one.
  const hasNext = rows.length === AUDIT_PAGE_SIZE;

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
        <>
          {/* Desktop (≥ md): the audit register table, unchanged — only the
              wrapper gained `hidden md:block` so it yields to the mobile card
              list below md. */}
          <div className="hidden overflow-x-auto rounded-[10px] border border-line bg-surface md:block">
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
                  <AuditRow key={entry.id} variant="row" entry={entry} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile (< md): the same rows as a stacked card list — same data,
              same resolution logic (see AuditRow's `variant` prop). Read-only,
              so no action row. */}
          <div className="flex flex-col gap-3 md:hidden">
            {rows.map((entry: AuditRowDto) => (
              <AuditRow key={entry.id} variant="card" entry={entry} />
            ))}
          </div>
        </>
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
          <span className="font-body text-sm text-ink-2">{t('admin.audit.page', { page: page + 1 })}</span>
          <Button variant="secondary" onClick={() => setPage((p) => p + 1)} disabled={!hasNext || isPlaceholderData}>
            {t('admin.audit.next')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The friendly Arabic action label, falling back to the raw machine action for
 * anything unmapped. Shared verbatim between the desktop cell and the mobile
 * card — the ONLY place this resolution is written.
 */
function AuditActionLabel({ action }: { action: string }) {
  const { t } = useTranslation();
  const key = `admin.audit.action.${action}`;
  const translated = t(key);
  // i18next returns the key itself when unmapped — fall back to the raw action.
  return <>{translated === key ? action : translated}</>;
}

/**
 * The actor cell: a resolved display-name/username, falling back to `#id` when
 * unresolved, or the system label for a null actor. Shared verbatim between
 * the desktop cell and the mobile card — the ONLY place this resolution logic
 * is written.
 */
function AuditActor({ entry }: { entry: AuditRowDto }) {
  const { t } = useTranslation();
  if (entry.actor_id === null) {
    return <span className="text-ink-2">{t('admin.audit.system')}</span>;
  }
  if (entry.actor_display_name || entry.actor_username) {
    return <span className="font-body text-ink">{entry.actor_display_name || entry.actor_username}</span>;
  }
  return (
    <bdi dir="ltr" className="font-mono text-ink">
      {`#${entry.actor_id}`}
    </bdi>
  );
}

/**
 * The target cell: for user-target actions this resolves to the target user's
 * display-name/username (with a "(محذوف)" hint appended to `#id` when the user
 * no longer resolves), otherwise the raw (already server-redacted) target.
 * Shared verbatim between the desktop cell and the mobile card — the ONLY
 * place this resolution logic is written.
 */
function AuditTarget({ entry }: { entry: AuditRowDto }) {
  const { t } = useTranslation();
  if (entry.target === null) {
    return <span className="text-ink-2">—</span>;
  }
  if (entry.target_display_name || entry.target_username) {
    return <span className="font-body text-ink-2">{entry.target_display_name || entry.target_username}</span>;
  }
  if (USER_TARGET_ACTIONS.has(entry.action)) {
    return (
      <bdi dir="ltr" className="font-mono text-ink-2 break-all">
        {`#${entry.target} ${t('admin.audit.deleted')}`}
      </bdi>
    );
  }
  return (
    <bdi dir="ltr" className="font-mono text-ink-2 break-all">
      {entry.target}
    </bdi>
  );
}

/**
 * A single audit entry's BOTH presentations. `variant` switches only the
 * returned JSX layout — `'row'` is the desktop `<tr>` byte-identical to before
 * this refactor, `'card'` is the mobile card — while `AuditActor`,
 * `AuditActionLabel`, and `AuditTarget` above are the single code path both
 * variants call. Read-only: no actions in either layout.
 */
function AuditRow({ entry, variant = 'row' }: { entry: AuditRowDto; variant?: 'row' | 'card' }) {
  const { t } = useTranslation();

  if (variant === 'card') {
    return (
      <div data-testid={`audit-card-${entry.id}`} className="rounded-[10px] border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <bdi dir="ltr" className="font-mono text-xs text-ink-2">
            {formatDate(entry.created_at)}
          </bdi>
          <span className="font-body text-xs text-ink">
            <AuditActionLabel action={entry.action} />
          </span>
        </div>

        <div className="mt-1.5 font-body text-xs text-ink-2">
          <span className="me-1">{t('admin.audit.col.actor')}:</span>
          <AuditActor entry={entry} />
        </div>

        <div className="mt-1 font-body text-xs text-ink-2">
          <span className="me-1">{t('admin.audit.col.target')}:</span>
          <AuditTarget entry={entry} />
        </div>
      </div>
    );
  }

  return (
    <tr className="border-b border-line last:border-b-0">
      <td className="ps-3 pe-3 py-2">
        <bdi dir="ltr" className="font-mono text-ink-2">
          {formatDate(entry.created_at)}
        </bdi>
      </td>
      <td className="ps-3 pe-3 py-2">
        <AuditActor entry={entry} />
      </td>
      <td className="ps-3 pe-3 py-2 text-ink">
        <AuditActionLabel action={entry.action} />
      </td>
      <td className="ps-3 pe-3 py-2">
        <AuditTarget entry={entry} />
      </td>
    </tr>
  );
}
