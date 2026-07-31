import { useTranslation } from 'react-i18next';
import { SealHeader } from './DispatchFrame';
import { PrimaryLink, DownloadGlyph } from './controls';
import { zipUrl, type PublicMeta } from './api';

/*
 * PublicFolder — the live folder dispatch (§3.5). Per the round-3 decision the
 * recipient sees ONLY the folder name + "Download all as ZIP"; the contents are
 * never listed (the server also blocks /list and per-file /download for a folder
 * share). When download is forbidden, only the framing line is shown.
 */
export default function PublicFolder({ token, meta }: { token: string; meta: PublicMeta }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <SealHeader stamp />
      <p className="font-body text-base text-ink-2">{t('public.framingFolder')}</p>
      <p className="font-display text-lg text-ink">
        <bdi>{meta.name}</bdi>
      </p>
      {meta.allow_download && (
        <PrimaryLink href={zipUrl(token)}>
          <DownloadGlyph />
          {t('public.downloadAll')}
        </PrimaryLink>
      )}
    </div>
  );
}
