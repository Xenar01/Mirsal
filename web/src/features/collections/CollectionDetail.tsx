import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import DashboardShell from '../dashboard/DashboardShell';
import Modal from '../../components/Modal';
import Button from '../../components/Button';
import StatusChip, { type ShareStatus } from '../../components/StatusChip';
import { useToast } from '../../components/Toast';
import { Copy, DownloadArrow } from '../../components/icons';
import { listNodes, downloadUrl } from '../dashboard/api';
import { formatDate, formatBytes } from '../dashboard/format';
import { damascusInputToUtcMs, utcMsToDamascusInput } from '../dashboard/share/datetime';
import { ApiError } from '../../lib/api';
import {
  useCollection,
  usePatchCollection,
  useDeleteCollection,
  useAddDepartment,
  useRemoveDepartment,
} from './queries';
import type { CollectionDetailDto, RosterDeptDto } from './types';

/*
 * CollectionDetail — the owner roster + lifecycle console for ONE collection
 * (Collections Phase 3 / Task 5). Route element for `/collections/:id`.
 *
 * DashboardShell-framed: a back-link to the register, the title + StatusChip
 * (same `open→active / closed→stopped / expired→expired` mapping as
 * CollectionsView) + the X/N responded headline, and the public `/c/<token>`
 * link with copy. Below that, an open/close toggle plus a small "edit" toggle
 * that reveals title/password/deadline sections mirroring ShareModal's
 * published-step sections (each its own `usePatchCollection` tri-state PATCH).
 * Then two rosters — Responded (name, file count, submitted time, note, and a
 * lazy per-department file list) and Missing (name + remove, guarded against
 * a 409 `has_response` that can slip in between the roster load and the
 * click) — and an inline add-department form. A confirmed delete ends the
 * console and navigates back to the register.
 */

/** Maps the collection's derived status to the shared StatusChip vocabulary. */
function mapStatus(status: CollectionDetailDto['status']): ShareStatus {
  switch (status) {
    case 'open':
      return 'active';
    case 'closed':
      return 'stopped';
    case 'expired':
      return 'expired';
  }
}

/**
 * Extracts the server's machine-readable `{code}` 409 body (`duplicate` on
 * add-department, `has_response` on remove-department). `ApiError.code` only
 * mirrors a `{error:"..."}` body, so it stays undefined for these — mirrors
 * `nodeErrorCode` in `../dashboard/api`.
 */
function collectionErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const body = err.body as { code?: unknown } | undefined;
  return body && typeof body.code === 'string' ? body.code : undefined;
}

export default function CollectionDetail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { data, isPending, isError } = useCollection(id);

  return (
    <DashboardShell>
      <div className="flex flex-col gap-5">
        <Link to="/collections" className="font-body text-sm text-teal">
          {t('collections.detail.back')}
        </Link>
        {isPending && <p className="font-body text-sm text-ink-2">{t('collections.detail.loading')}</p>}
        {isError && (
          <p role="alert" className="font-body text-sm text-clay">
            {t('collections.detail.error')}
          </p>
        )}
        {data && <Detail collection={data} onDeleted={() => navigate('/collections')} />}
      </div>
    </DashboardShell>
  );
}

/* ── The loaded console: header, controls, edit, rosters, delete ────────── */

function Detail({
  collection,
  onDeleted,
}: {
  collection: CollectionDetailDto;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchCollection();
  const [editing, setEditing] = useState(false);

  function toggleActive() {
    const next = !collection.is_active;
    patch.mutate(
      { id: collection.id, isActive: next },
      {
        onSuccess: () =>
          toast({
            kind: 'success',
            message: t(next ? 'collections.toast.reopened' : 'collections.toast.closed'),
          }),
        onError: () => toast({ kind: 'error', message: t('collections.toast.error') }),
      }
    );
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(collection.url);
      toast({ kind: 'success', message: t('collections.toast.copied') });
    } catch {
      toast({ kind: 'error', message: t('collections.toast.copyFailed') });
    }
  }

  const responded = collection.departments.filter((d) => d.responded);
  const missing = collection.departments.filter((d) => !d.responded);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-display text-lg text-ink">{collection.title}</h1>
          <StatusChip status={mapStatus(collection.status)} />
        </div>
        <p className="font-body text-sm text-ink-2">
          {t('collections.count', {
            responded: collection.responded_count,
            total: collection.department_count,
          })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-body text-sm text-ink-2">{t('collections.detail.link')}</span>
          <bdi
            dir="ltr"
            className="min-w-0 grow overflow-x-auto rounded-lg border border-line bg-paper ps-2 pe-2 py-1 font-mono text-sm text-ink"
          >
            {collection.url}
          </bdi>
          <Button variant="secondary" onClick={copyLink}>
            <Copy size={16} />
            {t('collections.detail.copyLink')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={toggleActive} disabled={patch.isPending}>
          {collection.is_active ? t('collections.detail.close') : t('collections.detail.reopen')}
        </Button>
        <Button variant="ghost" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
          {t('collections.detail.edit')}
        </Button>
      </div>

      {/* Title/password/deadline live behind an explicit toggle so the console
          stays focused on the roster (mirrors ShareModal's "Edit settings"). */}
      {editing && (
        <>
          <TitleSection collection={collection} />
          <PasswordSection collection={collection} />
          <DeadlineSection collection={collection} />
        </>
      )}

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h2 className="font-display text-sm text-ink">{t('collections.detail.responded')}</h2>
        {responded.length === 0 ? (
          <p className="font-body text-sm text-ink-2">{t('collections.detail.noneResponded')}</p>
        ) : (
          <ul className="flex flex-col">
            {responded.map((d) => (
              <RespondedRow key={d.id} dept={d} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h2 className="font-display text-sm text-ink">{t('collections.detail.missing')}</h2>
        {missing.length === 0 ? (
          <p className="font-body text-sm text-ink-2">{t('collections.detail.noneMissing')}</p>
        ) : (
          <ul className="flex flex-col">
            {missing.map((d) => (
              <MissingRow key={d.id} collectionId={collection.id} dept={d} />
            ))}
          </ul>
        )}
        <AddDepartmentForm collectionId={collection.id} />
      </section>

      <DeleteSection collection={collection} onDeleted={onDeleted} />
    </div>
  );
}

/* ── Responded roster row: name, count, submitted time, note, lazy files ── */

function RespondedRow({ dept }: { dept: RosterDeptDto }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <li
      data-testid={`department-responded-${dept.id}`}
      className="flex flex-col gap-1 border-b border-line py-2 last:border-b-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <bdi className="min-w-0 truncate font-body text-sm text-ink">{dept.name}</bdi>
        <span className="font-body text-xs text-ink-2">
          {t('collections.detail.files', { count: dept.file_count })}
        </span>
      </div>
      {dept.submitted_at != null && (
        <p className="font-body text-xs text-ink-2">
          {t('collections.detail.submittedAt')}{' '}
          <bdi dir="ltr" className="font-mono">
            {formatDate(dept.submitted_at)}
          </bdi>
        </p>
      )}
      {dept.note && (
        <p className="font-body text-sm text-ink-2">
          <span className="text-ink-2">{t('collections.detail.note')}: </span>
          {dept.note}
        </p>
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex min-h-10 items-center self-start font-body text-sm text-teal"
      >
        {expanded ? t('collections.detail.hideFiles') : t('collections.detail.showFiles')}
      </button>
      {expanded && dept.folder_node_id != null && (
        <DepartmentFiles folderNodeId={dept.folder_node_id} />
      )}
    </li>
  );
}

/** Lazily lists a responded department's response subfolder (mounted only while expanded). */
function DepartmentFiles({ folderNodeId }: { folderNodeId: number }) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useQuery({
    queryKey: ['nodes', folderNodeId],
    queryFn: () => listNodes(folderNodeId),
  });
  if (isPending) return <p className="font-body text-xs text-ink-2">{t('collections.detail.filesLoading')}</p>;
  if (isError) return <p role="alert" className="font-body text-xs text-clay">{t('collections.detail.filesError')}</p>;
  return (
    <ul className="mt-1 flex flex-col gap-1">
      {(data ?? []).filter((n) => n.kind === 'file').map((f) => (
        <li key={f.id} className="flex items-center justify-between gap-2">
          <bdi className="min-w-0 truncate font-body text-sm text-ink">{f.name}</bdi>
          <span className="shrink-0 font-mono text-xs text-ink-2">{formatBytes(f.size_bytes)}</span>
          <a href={downloadUrl(f.id)} className="inline-flex shrink-0 items-center gap-1 text-teal">
            <DownloadArrow size={16} />
            {t('collections.detail.download')}
          </a>
        </li>
      ))}
    </ul>
  );
}

/* ── Missing roster row: name + remove (belt-and-braces 409 has_response) ─ */

function MissingRow({ collectionId, dept }: { collectionId: number; dept: RosterDeptDto }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const remove = useRemoveDepartment();

  function onRemove() {
    remove.mutate(
      { id: collectionId, deptId: dept.id },
      {
        onSuccess: () => toast({ kind: 'success', message: t('collections.toast.departmentRemoved') }),
        onError: (err) => {
          const code = collectionErrorCode(err);
          toast({
            kind: 'error',
            message:
              code === 'has_response'
                ? t('collections.detail.removeBlocked')
                : t('collections.toast.error'),
          });
        },
      }
    );
  }

  return (
    <li
      data-testid={`department-missing-${dept.id}`}
      className="flex items-center justify-between gap-2 border-b border-line py-2 last:border-b-0"
    >
      <bdi className="min-w-0 truncate font-body text-sm text-ink">{dept.name}</bdi>
      <Button variant="ghost" onClick={onRemove} disabled={remove.isPending}>
        {t('collections.detail.removeDepartment')}
      </Button>
    </li>
  );
}

/* ── Inline add-department form (under the Missing roster) ──────────────── */

function AddDepartmentForm({ collectionId }: { collectionId: number }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const add = useAddDepartment();
  const inputId = useId();
  const [name, setName] = useState('');

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    add.mutate(
      { id: collectionId, name: trimmed },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('collections.toast.departmentAdded') });
          setName('');
        },
        onError: (err) => {
          const code = collectionErrorCode(err);
          toast({
            kind: 'error',
            message:
              code === 'duplicate'
                ? t('collections.detail.duplicateDepartment')
                : t('collections.toast.error'),
          });
        },
      }
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="font-display text-sm text-ink">{t('collections.detail.addDepartment')}</h3>
      <label htmlFor={inputId} className="font-body text-sm text-ink-2">
        {t('collections.detail.addDepartmentLabel')}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
        />
        <Button variant="secondary" type="submit" disabled={add.isPending}>
          {t('collections.detail.addDepartmentSubmit')}
        </Button>
      </div>
    </form>
  );
}

/* ── Title / password / deadline — behind the "edit" toggle ─────────────── */

function TitleSection({ collection }: { collection: CollectionDetailDto }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchCollection();
  const inputId = useId();
  const [value, setValue] = useState(collection.title);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    patch.mutate(
      { id: collection.id, title: trimmed },
      {
        onSuccess: () => toast({ kind: 'success', message: t('collections.toast.titleUpdated') }),
        onError: () => toast({ kind: 'error', message: t('collections.toast.error') }),
      }
    );
  }

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="font-display text-sm text-ink">{t('collections.create.titleLabel')}</h3>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          {t('collections.create.titleLabel')}
        </label>
        <input
          id={inputId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
        />
        <Button variant="secondary" type="submit" disabled={patch.isPending}>
          {t('collections.detail.titleSave')}
        </Button>
      </form>
    </section>
  );
}

function PasswordSection({ collection }: { collection: CollectionDetailDto }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchCollection();
  const inputId = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const next = value.trim();
    if (!next) {
      setError(t('share.password.required'));
      return;
    }
    setError(null);
    patch.mutate(
      { id: collection.id, password: next },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('collections.toast.passwordUpdated') });
          setValue('');
        },
        onError: () => toast({ kind: 'error', message: t('collections.toast.error') }),
      }
    );
  }

  function clear() {
    patch.mutate(
      { id: collection.id, password: null },
      {
        onSuccess: () => toast({ kind: 'success', message: t('collections.toast.passwordCleared') }),
        onError: () => toast({ kind: 'error', message: t('collections.toast.error') }),
      }
    );
  }

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="font-display text-sm text-ink">{t('collections.detail.passwordHeading')}</h3>
      <p className="font-body text-sm text-ink-2">
        {collection.has_password
          ? t('collections.detail.passwordProtected')
          : t('collections.detail.passwordUnprotected')}
      </p>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor={inputId} className="font-body text-sm text-ink-2">
          {t('share.password.label')}
        </label>
        <input
          id={inputId}
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
        />
        {error !== null && (
          <p role="alert" className="font-body text-sm text-clay">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" type="submit" disabled={patch.isPending}>
            {t('collections.detail.passwordSet')}
          </Button>
          {collection.has_password && (
            <Button variant="ghost" onClick={clear} disabled={patch.isPending}>
              {t('collections.detail.passwordClear')}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

function DeadlineSection({ collection }: { collection: CollectionDetailDto }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchCollection();
  const inputId = useId();
  const [value, setValue] = useState(
    collection.deadline_at != null ? utcMsToDamascusInput(collection.deadline_at) : ''
  );
  const [error, setError] = useState<string | null>(null);

  function apply(event?: FormEvent) {
    event?.preventDefault();
    const utcMs = damascusInputToUtcMs(value);
    if (utcMs === null) {
      setError(t('collections.create.deadlineInvalid'));
      return;
    }
    if (utcMs <= Date.now()) {
      setError(t('collections.create.deadlinePast'));
      return;
    }
    setError(null);
    patch.mutate(
      { id: collection.id, deadlineAt: utcMs },
      {
        onSuccess: () => toast({ kind: 'success', message: t('collections.toast.deadlineUpdated') }),
        onError: () => toast({ kind: 'error', message: t('collections.toast.error') }),
      }
    );
  }

  function clear() {
    setError(null);
    patch.mutate(
      { id: collection.id, deadlineAt: null },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('collections.toast.deadlineCleared') });
          setValue('');
        },
        onError: () => toast({ kind: 'error', message: t('collections.toast.error') }),
      }
    );
  }

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="font-display text-sm text-ink">{t('collections.detail.deadlineHeading')}</h3>
      <p className="font-body text-sm text-ink-2">
        {collection.deadline_at != null ? (
          <>
            <span>{t('collections.detail.deadlineCurrent')} </span>
            <bdi dir="ltr" className="font-mono">
              {formatDate(collection.deadline_at)}
            </bdi>
          </>
        ) : (
          t('collections.detail.deadlineNever')
        )}
      </p>
      <form onSubmit={apply} className="flex flex-col gap-2">
        <label htmlFor={inputId} className="font-body text-sm text-ink-2">
          {t('collections.create.deadlineLabel')}
        </label>
        <input
          id={inputId}
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-mono text-sm text-ink"
        />
        {error !== null && (
          <p role="alert" className="font-body text-sm text-clay">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" type="submit" disabled={patch.isPending}>
            {t('collections.detail.deadlineApply')}
          </Button>
          {collection.deadline_at != null && (
            <Button variant="ghost" onClick={clear} disabled={patch.isPending}>
              {t('collections.detail.deadlineClear')}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

/* ── Delete (destructive, confirmed) → navigate back to the register ────── */

function DeleteSection({
  collection,
  onDeleted,
}: {
  collection: CollectionDetailDto;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const del = useDeleteCollection();
  const [confirming, setConfirming] = useState(false);

  function confirm() {
    del.mutate(collection.id, {
      onSuccess: () => {
        toast({ kind: 'success', message: t('collections.toast.deleted') });
        setConfirming(false);
        onDeleted();
      },
      onError: () => {
        toast({ kind: 'error', message: t('collections.toast.error') });
        setConfirming(false);
      },
    });
  }

  return (
    <section className="border-t border-line pt-4">
      <Button variant="danger" onClick={() => setConfirming(true)}>
        {t('collections.detail.delete')}
      </Button>
      {confirming && (
        <Modal
          open
          onClose={() => setConfirming(false)}
          title={t('collections.detail.deleteTitle')}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                {t('collections.detail.cancel')}
              </Button>
              <Button variant="danger" onClick={confirm} disabled={del.isPending}>
                {t('collections.detail.deleteConfirm')}
              </Button>
            </>
          }
        >
          <p className="font-body text-sm text-ink">{t('collections.detail.deleteBody')}</p>
        </Modal>
      )}
    </section>
  );
}
