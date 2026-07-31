import { useTranslation } from 'react-i18next';
import { formatBytes } from '../dashboard/format';
import { SealHeader } from './DispatchFrame';
import { PrimaryButton, DownloadGlyph } from './controls';
import { downloadUrl, type PublicMeta } from './api';
import { fileTypeLabel } from './format';

/*
 * PublicFile — the live single-file dispatch (§3.5). The 72px seal stamps on
 * arrival, then the recipient framing (§4.9), the file name, its size + derived
 * type as bidi-isolated mono ledger data (§4.3/§4.5), and Download as the one
 * unambiguous primary action — a brass PrimaryButton submitting a POST <form>
 * (§6: the counted download is a POST so passive GETs can't burn a capped share).
 * A capped share also shows a static "one-time / up to N" label above it. When
 * the share forbids download, the page shows the framing only — no Download.
 */
export default function PublicFile({ token, meta }: { token: string; meta: PublicMeta }) {
  const { t } = useTranslation();
  const type = fileTypeLabel(meta.name);

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <SealHeader stamp />

      <p className="font-body text-base text-ink-2">{t('public.framingFile')}</p>

      {/* User-supplied name: <bdi> (auto direction) isolates a Latin/RTL name
          so it can't scramble against the surrounding UI. */}
      <bdi className="max-w-full break-words font-display text-lg text-ink">{meta.name}</bdi>

      <p className="flex items-center justify-center gap-2 font-mono text-sm text-ink-2">
        <bdi dir="ltr">{formatBytes(meta.size_bytes)}</bdi>
        {type !== null && (
          <>
            <span aria-hidden="true">·</span>
            <bdi dir="ltr">{type}</bdi>
          </>
        )}
      </p>

      {/* Static config label (never a live remaining count — no download oracle):
          "one-time" for a cap of 1, otherwise "up to N". Absent when unlimited. */}
      {meta.download_limit != null && (
        <p className="font-body text-sm text-brass-ring">
          {meta.download_limit === 1
            ? t('public.limitOnce')
            : t('public.limitN', { count: meta.download_limit })}
        </p>
      )}

      {meta.allow_download && (
        // POST so a passive GET (unfurler / scanner / prefetch) can't trigger a
        // burn; the browser still downloads natively from the attachment response,
        // and the path-scoped mirsal_unlock cookie (SameSite=Lax, same-origin)
        // rides along on this same-site form POST.
        <form method="post" action={downloadUrl(token)}>
          <PrimaryButton type="submit">
            <DownloadGlyph />
            {t('public.download')}
          </PrimaryButton>
        </form>
      )}
    </div>
  );
}
