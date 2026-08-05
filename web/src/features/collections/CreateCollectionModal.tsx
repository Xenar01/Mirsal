import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal';
import Button from '../../components/Button';
import Seal from '../../components/Seal';
import { useToast } from '../../components/Toast';
import { Copy } from '../../components/icons';
import { uploadFile } from '../dashboard/api';
import { damascusInputToUtcMs } from '../dashboard/share/datetime';
import { MAX_FILE_BYTES } from '../dashboard/format';
import { useCreateCollection } from './queries';
import type { CollectionDetailDto } from './types';

/*
 * CreateCollectionModal — the create-collection wizard (Collections Phase 3 /
 * Task 4).
 *
 * Mirrors ShareModal's two-visual-steps-in-one-Modal shape: Step 1 collects
 * the title + departments (both required) plus an optional template file /
 * password / deadline; on success Step 2 shows the created /c/<token> link to
 * copy (a brass Seal stamp, like the share wizard's dispatch moment). A chosen
 * template file is uploaded to the owner's Drive root FIRST — its returned
 * node id becomes `template_node_id` — so the create POST always carries a
 * concrete id, never a pending upload.
 */

/** Splits the departments textarea into a trimmed, de-duplicated, ordered list. */
export function parseDepartments(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const name = line.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export default function CreateCollectionModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<CollectionDetailDto | null>(null);

  return (
    <Modal open onClose={onClose} title={t('collections.create.title')}>
      {result ? (
        <LinkStep result={result} onDone={onClose} />
      ) : (
        <ConfigureStep onCreated={setResult} />
      )}
    </Modal>
  );
}

/* ── Step 1 — title, departments, optional template/password/deadline ──── */

function ConfigureStep({ onCreated }: { onCreated: (result: CollectionDetailDto) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const create = useCreateCollection();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const titleId = useId();
  const departmentsId = useId();
  const passwordId = useId();
  const deadlineId = useId();

  const [title, setTitle] = useState('');
  const [departmentsRaw, setDepartmentsRaw] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [deadline, setDeadline] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const departmentCount = parseDepartments(departmentsRaw).length;
  const busy = create.isPending || uploading;

  function pickFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    event.target.value = ''; // allow re-selecting the same file after clearing
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const depts = parseDepartments(departmentsRaw);
    if (!title.trim()) {
      setError(t('collections.create.titleRequired'));
      return;
    }
    if (depts.length === 0) {
      setError(t('collections.create.departmentsRequired'));
      return;
    }
    let deadlineAt: number | null | undefined;
    if (deadline) {
      const ms = damascusInputToUtcMs(deadline);
      if (ms === null) {
        setError(t('collections.create.deadlineInvalid'));
        return;
      }
      if (ms <= Date.now()) {
        setError(t('collections.create.deadlinePast'));
        return;
      }
      deadlineAt = ms;
    }
    setError(null);
    try {
      let templateNodeId: number | undefined;
      if (file) {
        if (file.size > MAX_FILE_BYTES) {
          setError(t('upload.tooLarge'));
          return;
        }
        setUploading(true);
        const node = await uploadFile({ file, parentId: null });
        setUploading(false);
        templateNodeId = node.id;
      }
      const created = await create.mutateAsync({
        title: title.trim(),
        departments: depts,
        templateNodeId,
        password: password.trim() || undefined,
        deadlineAt,
      });
      toast({ kind: 'success', message: t('collections.toast.created') });
      onCreated(created);
    } catch {
      setUploading(false);
      toast({ kind: 'error', message: t('collections.create.error') });
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label htmlFor={titleId} className="font-body text-sm text-ink-2">
          {t('collections.create.titleLabel')}
        </label>
        <input
          id={titleId}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={departmentsId} className="font-body text-sm text-ink-2">
          {t('collections.create.departmentsLabel')}
        </label>
        <textarea
          id={departmentsId}
          rows={5}
          value={departmentsRaw}
          onChange={(e) => setDepartmentsRaw(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
        />
        <p className="font-body text-xs text-ink-2">{t('collections.create.departmentsHint')}</p>
        {departmentCount > 0 && (
          <p className="font-body text-xs text-ink-2">
            {t('collections.create.departmentsCount', { count: departmentCount })}
          </p>
        )}
      </div>

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="font-display text-sm text-ink">{t('collections.create.templateLabel')}</h3>
        <p className="font-body text-xs text-ink-2">{t('collections.create.templateHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
            {t('collections.create.templatePick')}
          </Button>
          {file && (
            <>
              <span className="min-w-0 truncate font-body text-sm text-ink">{file.name}</span>
              <Button variant="ghost" onClick={() => setFile(null)}>
                {t('collections.create.templateClear')}
              </Button>
            </>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          data-testid="collection-template-input"
          aria-label={t('collections.create.templatePick')}
          className="sr-only"
          onChange={pickFile}
        />
      </section>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <label htmlFor={passwordId} className="font-body text-sm text-ink-2">
          {t('collections.create.passwordLabel')}
        </label>
        <input
          id={passwordId}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <label htmlFor={deadlineId} className="font-body text-sm text-ink-2">
          {t('collections.create.deadlineLabel')}
        </label>
        <input
          id={deadlineId}
          type="datetime-local"
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-mono text-sm text-ink"
        />
      </div>

      {error !== null && (
        <p role="alert" className="font-body text-sm text-clay">
          {error}
        </p>
      )}

      {/* Sticky action bar — mirrors ShareModal's pinned publish button. */}
      <div className="sticky bottom-0 -mx-6 -mb-5 mt-1 border-t border-line bg-surface px-6 pb-5 pt-3">
        <Button variant="primary" type="submit" disabled={busy} className="w-full">
          {busy ? t('collections.create.creating') : t('collections.create.submit')}
        </Button>
      </div>
    </form>
  );
}

/* ── Step 2 — the created /c/<token> link, copyable ──────────────────────── */

function LinkStep({ result, onDone }: { result: CollectionDetailDto; onDone: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(result.url);
      toast({ kind: 'success', message: t('collections.toast.copied') });
    } catch {
      toast({ kind: 'error', message: t('collections.toast.copyFailed') });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <Seal size="dispatch" stamp />
        <p className="font-body text-sm text-ink-2">{t('collections.create.linkIntro')}</p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-body text-sm text-ink-2">{t('collections.create.linkLabel')}</span>
        <div className="flex flex-wrap items-center gap-2">
          <bdi
            dir="ltr"
            className="min-w-0 grow overflow-x-auto rounded-lg border border-line bg-paper ps-2 pe-2 py-1 font-mono text-sm text-ink"
          >
            {result.url}
          </bdi>
          <Button variant="primary" onClick={copyLink}>
            <Copy size={16} />
            {t('collections.copyLink')}
          </Button>
        </div>
      </div>

      <Button variant="secondary" onClick={onDone} className="w-full">
        {t('collections.create.done')}
      </Button>
    </div>
  );
}
