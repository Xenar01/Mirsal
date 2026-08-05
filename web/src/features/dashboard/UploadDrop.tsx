import { useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import Button from '../../components/Button';
import { Close } from '../../components/icons';
import { uploadFile, nodeErrorCode } from './api';
import { MAX_FILE_BYTES } from './format';
import { trashKey } from './queries';
import { meKey } from '../auth/queries';

/*
 * UploadDrop (§3.2 / §4.9).
 *
 * A drag-and-drop zone plus a file picker (the picker is the mobile path).
 * Multiple files. Each file is size-checked CLIENT-SIDE against the 100 MB cap
 * BEFORE any request — an over-limit file is rejected in place with the
 * authored §4.9 copy and never touches the network. Accepted files upload via
 * `XMLHttpRequest` so we can show per-file progress; on success the node
 * listings + storage meter are invalidated. 413 `quota_exceeded` /
 * `file_too_large` and any other failure map to their authored §4.9 copy.
 *
 * Status is never colour-only: every item shows an authored text status
 * (uploading / done / an error message) alongside its accent.
 */

type ItemStatus = 'uploading' | 'done' | 'error';

interface UploadItem {
  id: number;
  name: string;
  status: ItemStatus;
  progress: number; // 0..1
  message?: string;
}

export interface UploadDropProps {
  parentId: number | null;
}

export default function UploadDrop({ parentId }: UploadDropProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragActive, setDragActive] = useState(false);

  function patchItem(id: number, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function dismiss(id: number) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }

  function messageForError(err: unknown): string {
    const code = nodeErrorCode(err);
    if (code === 'quota_exceeded') return t('upload.quotaExceeded');
    if (code === 'file_too_large') return t('upload.tooLarge');
    return t('upload.failed');
  }

  function startUpload(file: File) {
    const id = (nextId.current += 1);

    // Client-side guard FIRST — an over-limit file never hits the network.
    if (file.size > MAX_FILE_BYTES) {
      setItems((prev) => [
        ...prev,
        { id, name: file.name, status: 'error', progress: 0, message: t('upload.tooLarge') },
      ]);
      return;
    }

    setItems((prev) => [...prev, { id, name: file.name, status: 'uploading', progress: 0 }]);

    uploadFile({
      file,
      parentId,
      onProgress: (fraction) => patchItem(id, { progress: fraction }),
    })
      .then(() => {
        patchItem(id, { status: 'done', progress: 1 });
        void client.invalidateQueries({ queryKey: ['nodes'] });
        void client.invalidateQueries({ queryKey: trashKey });
        // Refresh the storage meter — an upload just grew used_bytes.
        void client.invalidateQueries({ queryKey: meKey });
      })
      .catch((err) => {
        patchItem(id, { status: 'error', message: messageForError(err) });
      });
  }

  function handleFiles(files: FileList | null) {
    if (!files) return;
    Array.from(files).forEach(startUpload);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    handleFiles(event.dataTransfer.files);
  }

  const accent: Record<ItemStatus, string> = {
    uploading: 'border-s-teal',
    done: 'border-s-emerald',
    error: 'border-s-clay',
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
        className={[
          'rounded-[10px] border border-dashed p-4 text-center font-body text-sm',
          dragActive ? 'border-teal bg-paper' : 'border-line bg-surface',
        ].join(' ')}
      >
        <p className="text-ink-2">{t('upload.drop')}</p>
        <div className="mt-2 flex items-center justify-center">
          <Button variant="primary" onClick={() => inputRef.current?.click()}>
            {t('upload.pick')}
          </Button>
        </div>
        <input
          ref={inputRef}
          data-testid="upload-input"
          type="file"
          multiple
          aria-label={t('upload.pickerLabel')}
          className="sr-only"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = ''; // allow re-selecting the same file
          }}
        />
      </div>

      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className={`flex items-center gap-3 rounded-lg border border-line ${accent[item.status]} border-s-4 bg-surface ps-3 pe-2 py-2`}
            >
              <div className="min-w-0 grow">
                <p className="truncate font-body text-sm text-ink">{item.name}</p>
                {item.status === 'uploading' && (
                  <div className="mt-1 flex items-center gap-2">
                    <progress
                      className="h-1.5 grow"
                      max={100}
                      value={Math.round(item.progress * 100)}
                      aria-label={t('upload.uploading')}
                    />
                    <bdi dir="ltr" className="font-mono text-xs text-ink-2">
                      {Math.round(item.progress * 100)}%
                    </bdi>
                  </div>
                )}
                {item.status === 'done' && <p className="mt-0.5 font-body text-xs text-emerald">{t('upload.done')}</p>}
                {item.status === 'error' && (
                  <p role="alert" className="mt-0.5 font-body text-xs text-clay">
                    {item.message}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label={t('upload.dismiss')}
                className="inline-flex min-h-10 min-w-10 items-center justify-center text-ink-2"
              >
                <Close size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
