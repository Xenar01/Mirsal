import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderDossier, FileSheet } from '../../components/icons';
import { formatBytes } from '../dashboard/format';
import { SealHeader } from './DispatchFrame';
import { PrimaryLink, DownloadGlyph } from './controls';
import { usePublicList } from './queries';
import { downloadUrl, zipUrl, type PublicMeta, type PublicNodeDto } from './api';

/*
 * PublicFolder — the live folder dispatch (§3.5): a read-only subtree browser
 * styled as a dispatch register (§4.6). Breadcrumb within the shared subtree
 * (never above it — the server's canonical resolver enforces that too), folders
 * are navigable, each file has a per-file Download, and "Download all as ZIP" is
 * the primary action. All layout uses logical properties; sizes are bidi-
 * isolated mono. When the share forbids download, only browsing is offered.
 */
interface Crumb {
  /** null addresses the share root (the server's list default). */
  id: number | null;
  name: string;
}

export default function PublicFolder({ token, meta }: { token: string; meta: PublicMeta }) {
  const { t } = useTranslation();
  const [trail, setTrail] = useState<Crumb[]>([{ id: null, name: meta.name }]);
  const current = trail[trail.length - 1];
  const { data, isPending, isError, refetch } = usePublicList(token, current.id);
  const nodes = Array.isArray(data) ? data : [];

  function openFolder(node: PublicNodeDto) {
    setTrail((prev) => [...prev, { id: node.id, name: node.name }]);
  }
  function goCrumb(index: number) {
    setTrail((prev) => prev.slice(0, index + 1));
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-5 text-center">
        <SealHeader stamp />
        <p className="font-body text-base text-ink-2">{t('public.framingFolder')}</p>
        {meta.allow_download && (
          <PrimaryLink href={zipUrl(token)}>
            <DownloadGlyph />
            {t('public.downloadAll')}
          </PrimaryLink>
        )}
      </div>

      <Breadcrumb trail={trail} onCrumb={goCrumb} />

      {isPending && <p className="font-body text-sm text-ink-2">{t('public.loading')}</p>}
      {isError && (
        <div className="flex flex-col items-start gap-2" role="alert">
          <p className="font-body text-sm text-clay">{t('public.error')}</p>
          <button type="button" onClick={() => void refetch()} className="font-body text-sm text-teal">
            {t('public.retry')}
          </button>
        </div>
      )}
      {!isPending && !isError && nodes.length === 0 && (
        <p className="font-body text-sm text-ink-2">{t('public.folderEmpty')}</p>
      )}

      {!isPending && !isError && nodes.length > 0 && (
        <div className="overflow-x-auto rounded-[10px] border border-line bg-surface">
          <table className="w-full border-collapse font-body text-sm">
            <tbody>
              {nodes.map((node) => (
                <NodeRow
                  key={node.id}
                  token={token}
                  node={node}
                  allowDownload={meta.allow_download}
                  onOpen={openFolder}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Breadcrumb({ trail, onCrumb }: { trail: Crumb[]; onCrumb: (index: number) => void }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('public.title')} className="font-body text-sm">
      <ol className="flex flex-wrap items-center gap-1">
        {trail.map((crumb, index) => {
          const isLast = index === trail.length - 1;
          return (
            <li key={`${crumb.id ?? 'root'}-${index}`} className="flex items-center gap-1">
              {index > 0 && (
                <span aria-hidden="true" className="text-ink-2">
                  /
                </span>
              )}
              {isLast ? (
                <bdi aria-current="page" className="text-ink">
                  {crumb.name}
                </bdi>
              ) : (
                <button type="button" onClick={() => onCrumb(index)} className="text-teal">
                  <bdi>{crumb.name}</bdi>
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function NodeRow({
  token,
  node,
  allowDownload,
  onOpen,
}: {
  token: string;
  node: PublicNodeDto;
  allowDownload: boolean;
  onOpen: (node: PublicNodeDto) => void;
}) {
  const { t } = useTranslation();
  const isFolder = node.kind === 'folder';

  return (
    <tr className="border-b border-line last:border-b-0 hover:bg-paper">
      <td className="ps-3 pe-3 py-2">
        <div className="flex items-center gap-2">
          <span
            data-testid={isFolder ? 'icon-folder' : 'icon-file'}
            className="inline-flex shrink-0 text-ink-2"
          >
            {isFolder ? <FolderDossier size={20} /> : <FileSheet size={20} />}
          </span>
          {isFolder ? (
            <button type="button" onClick={() => onOpen(node)} className="text-start text-teal">
              <bdi>{node.name}</bdi>
            </button>
          ) : (
            <bdi className="text-ink">{node.name}</bdi>
          )}
        </div>
      </td>
      <td className="ps-3 pe-3 py-2">
        {!isFolder && (
          <bdi dir="ltr" className="font-mono text-ink-2">
            {formatBytes(node.size_bytes)}
          </bdi>
        )}
      </td>
      <td className="ps-3 pe-3 py-2 text-end">
        {!isFolder && allowDownload && (
          <a href={downloadUrl(token, node.id)} className="text-teal">
            {t('public.download')}
          </a>
        )}
      </td>
    </tr>
  );
}
