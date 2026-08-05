import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import DashboardShell from '../dashboard/DashboardShell';
import Button from '../../components/Button';
import StatusChip, { type ShareStatus } from '../../components/StatusChip';
import { useToast } from '../../components/Toast';
import { Copy } from '../../components/icons';
import { formatDate } from '../dashboard/format';
import { useCollections } from './queries';
import CreateCollectionModal from './CreateCollectionModal';
import type { CollectionSummaryDto } from './types';

/*
 * CollectionsView — the owner "Collections" register (طلبات التجميع).
 *
 * Lists the owner's collection requests (GET /api/collections) the same way
 * SharedView lists shares: a DashboardShell-framed register with a desktop
 * table (`hidden md:block`) + mobile card list (`md:hidden`), both driven by
 * one shared `CollectionRow` so there is exactly one place each row's
 * markup/logic is written. Per row: the title links to the detail view
 * (Task 5), a StatusChip carries the derived status (never colour alone), an
 * X/N responded count, and a copy-link button. The "new collection" button
 * mounts `CreateCollectionModal` (Task 4) gated on local `open` state.
 */

/** Maps the collection's derived status to the shared StatusChip vocabulary. */
function mapStatus(status: CollectionSummaryDto['status']): ShareStatus {
  switch (status) {
    case 'open':
      return 'active';
    case 'closed':
      return 'stopped';
    case 'expired':
      return 'expired';
  }
}

export default function CollectionsView() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useCollections();
  const collections = Array.isArray(data) ? data : [];
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <DashboardShell>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-lg text-ink">{t('collections.title')}</h1>
            <p className="font-body text-sm text-ink-2">{t('collections.subtitle')}</p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>{t('collections.new')}</Button>
        </div>

        {isPending && <p className="font-body text-sm text-ink-2">{t('collections.loading')}</p>}
        {isError && (
          <p role="alert" className="font-body text-sm text-clay">
            {t('collections.error')}
          </p>
        )}
        {!isPending && !isError && collections.length === 0 && (
          <p className="font-body text-sm text-ink-2">{t('collections.empty')}</p>
        )}

        {!isPending && !isError && collections.length > 0 && (
          <CollectionList collections={collections} />
        )}
      </div>

      {createOpen && <CreateCollectionModal onClose={() => setCreateOpen(false)} />}
    </DashboardShell>
  );
}

/* ── List (desktop table ≥ md / mobile cards < md) ────────────────────── */

function CollectionList({ collections }: { collections: CollectionSummaryDto[] }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="hidden overflow-x-auto rounded-[10px] border border-line bg-surface md:block">
        <table className="w-full border-collapse font-body text-sm">
          <thead>
            <tr className="border-b border-line text-ink-2">
              <th className="ps-3 pe-3 py-2 text-start font-medium">{t('collections.col.title')}</th>
              <th className="ps-3 pe-3 py-2 text-start font-medium">
                {t('collections.col.responses')}
              </th>
              <th className="ps-3 pe-3 py-2 text-start font-medium">
                {t('collections.col.status')}
              </th>
              <th className="ps-3 pe-3 py-2 text-start font-medium">
                <span className="sr-only">{t('collections.col.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {collections.map((collection) => (
              <CollectionRow key={collection.id} variant="row" collection={collection} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3 md:hidden">
        {collections.map((collection) => (
          <CollectionRow key={collection.id} variant="card" collection={collection} />
        ))}
      </div>
    </>
  );
}

/**
 * A single collection's per-row copy-link behavior plus BOTH of its
 * presentations. `variant` switches ONLY the returned JSX layout — `'row'`
 * renders the desktop `<tr>`, `'card'` renders the mobile card — while every
 * derived value and handler is the single code path both variants call.
 */
function CollectionRow({
  collection,
  variant = 'row',
}: {
  collection: CollectionSummaryDto;
  variant?: 'row' | 'card';
}) {
  const { t } = useTranslation();
  const { toast } = useToast();

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(collection.url);
      toast({ kind: 'success', message: t('collections.toast.copied') });
    } catch {
      toast({ kind: 'error', message: t('collections.toast.copyFailed') });
    }
  }

  const titleLink = (
    <Link to={`/collections/${collection.id}`} className="font-body text-ink hover:text-teal">
      {collection.title}
    </Link>
  );
  const created = (
    <bdi dir="ltr" className="font-mono">
      {formatDate(collection.created_at)}
    </bdi>
  );
  const count = t('collections.count', {
    responded: collection.responded_count,
    total: collection.department_count,
  });
  const copyButton = (
    <button type="button" onClick={copyLink} className="inline-flex items-center gap-1 text-teal">
      <Copy size={16} />
      {t('collections.copyLink')}
    </button>
  );

  if (variant === 'card') {
    return (
      <div
        data-testid={`collection-card-${collection.id}`}
        className="rounded-[10px] border border-line bg-surface p-3"
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 break-words">{titleLink}</span>
          <span className="shrink-0">
            <StatusChip status={mapStatus(collection.status)} />
          </span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-2">
          {created}
          <span>{count}</span>
        </div>

        <div className="mt-2 flex flex-wrap gap-2">{copyButton}</div>
      </div>
    );
  }

  return (
    <tr className="border-b border-line last:border-b-0 hover:bg-paper">
      <td className="ps-3 pe-3 py-2">
        <div className="flex flex-col gap-0.5">
          {titleLink}
          <span className="text-xs text-ink-2">{created}</span>
        </div>
      </td>
      <td className="ps-3 pe-3 py-2 text-ink-2">{count}</td>
      <td className="ps-3 pe-3 py-2">
        <StatusChip status={mapStatus(collection.status)} />
      </td>
      <td className="ps-3 pe-3 py-2">
        <div className="flex flex-wrap items-center justify-end gap-2">{copyButton}</div>
      </td>
    </tr>
  );
}
