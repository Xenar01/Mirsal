import { useId, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../../components/Button';
import { SealHeader } from '../public/DispatchFrame';
import { PrimaryLink, DownloadGlyph } from '../public/controls';
import { MAX_FILE_BYTES } from '../dashboard/format';
import { COLLECTION_MAX_FILES_PER_RESPONSE, submitResponse, templateUrl, type CollectMeta } from './api';

/*
 * CollectForm — the live "open" collection screen (§ Collections Phase 3 /
 * Task 7). The department's ONE task: pick a department, attach 1..N
 * response files (+ an optional note), and submit — mirrors the public
 * share page's live-content screens (`PublicFile`/`PublicFolder`) in
 * structure (SealHeader → framing → the one primary action) but is itself a
 * form rather than a passive download.
 *
 * File-count and per-file-size guards run client-side at SELECTION time (not
 * just at submit) so an oversized/over-count pick is rejected before any
 * network request is ever made — the server enforces the same caps, but the
 * UI should never even try.
 */
export default function CollectForm({ token, meta }: { token: string; meta: CollectMeta }) {
  const { t } = useTranslation();
  const departmentInputId = useId();
  const filesInputId = useId();
  const noteInputId = useId();

  const [departmentId, setDepartmentId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function pickFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files ? Array.from(event.target.files) : [];
    // Reset the native input so re-selecting (e.g. after a rejection) fires
    // a fresh change event even if the same files are chosen again.
    event.target.value = '';
    if (selected.length === 0) return;

    if (selected.length > COLLECTION_MAX_FILES_PER_RESPONSE) {
      setFiles([]);
      setError(t('collect.tooManyFiles', { max: COLLECTION_MAX_FILES_PER_RESPONSE }));
      return;
    }
    const oversized = selected.find((file) => file.size > MAX_FILE_BYTES);
    if (oversized) {
      setFiles([]);
      setError(t('collect.tooLarge', { name: oversized.name }));
      return;
    }
    setError(null);
    setFiles(selected);
  }

  function resetForSendAnother() {
    setDepartmentId('');
    setFiles([]);
    setNote('');
    setError(null);
    setSubmitted(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (departmentId === '') {
      setError(t('collect.departmentRequired'));
      return;
    }
    if (files.length === 0) {
      setError(t('collect.filesRequired'));
      return;
    }

    setError(null);
    setSubmitting(true);
    const result = await submitResponse(token, {
      departmentId: Number(departmentId),
      files,
      note: note.trim() || undefined,
    });
    setSubmitting(false);

    switch (result.kind) {
      case 'ok':
        setSubmitted(true);
        return;
      case 'quota':
        setError(t('collect.quotaExceeded'));
        return;
      case 'tooManyFiles':
        setError(t('collect.tooManyFiles', { max: COLLECTION_MAX_FILES_PER_RESPONSE }));
        return;
      case 'tooLarge':
        // The client already blocks any oversized file at selection time, so
        // this server-side branch is only reachable if the server's own cap
        // ever differs from the client's — no per-file name is available
        // from the submit result in that case.
        setError(t('collect.tooLarge', { name: '' }));
        return;
      case 'closed':
      case 'locked':
      case 'error':
      default:
        setError(t('collect.submitError'));
    }
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center gap-5 text-center">
        <SealHeader stamp />
        <p className="font-body text-base text-ink">{t('collect.success')}</p>
        <p className="font-body text-sm text-ink-2">{t('collect.successAgain')}</p>
        <Button variant="secondary" type="button" onClick={resetForSendAnother}>
          {t('collect.sendAnother')}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col items-center gap-5 text-center">
      <SealHeader />

      <p className="font-body text-base text-ink-2">{t('collect.heading')}</p>
      <div className="flex flex-col items-center gap-1">
        <p className="font-body text-sm text-ink-2">{t('collect.titleLabel')}</p>
        <p className="font-display text-lg text-ink">
          <bdi>{meta.title}</bdi>
        </p>
      </div>

      {meta.hasTemplate && (
        <PrimaryLink href={templateUrl(token)}>
          <DownloadGlyph />
          {t('collect.downloadTemplate')}
        </PrimaryLink>
      )}

      <div className="flex w-full max-w-sm flex-col gap-1 text-start">
        <label htmlFor={departmentInputId} className="font-body text-sm text-ink-2">
          {t('collect.departmentLabel')}
        </label>
        <select
          id={departmentInputId}
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
          required
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
        >
          <option value="">{t('collect.departmentPlaceholder')}</option>
          {meta.departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex w-full max-w-sm flex-col gap-1 text-start">
        <label htmlFor={filesInputId} className="font-body text-sm text-ink-2">
          {t('collect.filesLabel')}
        </label>
        <input
          id={filesInputId}
          type="file"
          multiple
          onChange={pickFiles}
          className="w-full font-body text-sm text-ink"
        />
        <p className="font-body text-xs text-ink-2">
          {t('collect.filesHint', { max: COLLECTION_MAX_FILES_PER_RESPONSE })}
        </p>
        {files.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`} className="font-body text-sm text-ink">
                <bdi>{file.name}</bdi>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex w-full max-w-sm flex-col gap-1 text-start">
        <label htmlFor={noteInputId} className="font-body text-sm text-ink-2">
          {t('collect.noteLabel')}
        </label>
        <textarea
          id={noteInputId}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
        />
      </div>

      {error !== null && (
        <p role="alert" className="font-body text-sm text-clay">
          {error}
        </p>
      )}

      <Button variant="primary" type="submit" disabled={submitting}>
        {submitting ? t('collect.submitting') : t('collect.submit')}
      </Button>
    </form>
  );
}
