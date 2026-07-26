import { useTranslation } from 'react-i18next';
import { formatBytes } from '../dashboard/format';
import { SealHeader } from './DispatchFrame';
import { PrimaryLink, DownloadGlyph } from './controls';
import { downloadUrl, type PublicMeta } from './api';
import { fileTypeLabel } from './format';

/*
 * PublicFile — the live single-file dispatch (§3.5). The 72px seal stamps on
 * arrival, then the recipient framing (§4.9), the file name, its size + derived
 * type as bidi-isolated mono ledger data (§4.3/§4.5), and Download as the one
 * unambiguous primary action (a brass PrimaryLink anchor). When the share
 * forbids download, the page shows the framing only — no Download control.
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

      {meta.allow_download && (
        <PrimaryLink href={downloadUrl(token)}>
          <DownloadGlyph />
          {t('public.download')}
        </PrimaryLink>
      )}
    </div>
  );
}
