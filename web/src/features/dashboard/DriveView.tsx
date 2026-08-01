import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal';
import Button from '../../components/Button';
import StatusChip from '../../components/StatusChip';
import { useToast } from '../../components/Toast';
import {
  FolderDossier,
  FileSheet,
  Lock,
  DownloadArrow,
  CalendarStamp,
  Copy,
  ChevronEnter,
} from '../../components/icons';
import { ApiError } from '../../lib/api';
import DashboardShell from './DashboardShell';
import UploadDrop from './UploadDrop';
import { downloadUrl } from './api';
import { formatBytes, formatDate } from './format';
import { sortNodes, type SortKey, type SortState } from './sort';
import { useNodes, useCreateFolder, useRenameNode, useMoveNode, useTrashNode } from './queries';
import { useAuth } from '../auth/auth-context';
import { useShares } from './share/queries';
import ShareModal from './share/ShareModal';
import AutoDeleteMenu from './share/AutoDeleteMenu';
import type { ShareDto } from './share/types';
import type { Crumb, NodeDto } from './types';

/*
 * DriveView — the dispatch register (§4.6 / §3.2).
 *
 * A full-RTL, Google-Drive-like file manager rendered as a dispatch register:
 * a Kufic section header, monospace ledger columns for size + date (each bidi-
 * isolated LTR, §4.3/§4.5), and a status/stamp column. Folder navigation is
 * URL-addressable via `?parent=<id>` (ref-shareable + back-button safe); the
 * breadcrumb path is carried in router history state as the user drills down.
 *
 * Reads/writes go through TanStack Query; folder create / rename / move are
 * 409-aware (name conflict → the user picks another name).
 */

/** Reads the breadcrumb trail stashed in router history state (empty on cold deep-link). */
function useTrail(): Crumb[] {
  const location = useLocation();
  const state = location.state as { trail?: Crumb[] } | null;
  return Array.isArray(state?.trail) ? state!.trail! : [];
}

export default function DriveView() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const trail = useTrail();

  const parentParam = searchParams.get('parent');
  const parentId = parentParam !== null && Number.isInteger(Number(parentParam)) ? Number(parentParam) : null;

  const { data, isPending, isError } = useNodes(parentId);
  const children = Array.isArray(data) ? data : [];

  // Live share state feeds the register's status/stamp column: a node is
  // matched to its share by node_id (first/newest wins).
  const { data: sharesData } = useShares();
  const shareByNode = new Map<number, ShareDto>();
  if (Array.isArray(sharesData)) {
    for (const s of sharesData) {
      if (!shareByNode.has(s.node_id)) shareByNode.set(s.node_id, s);
    }
  }

  // The synthetic root node id, so "move to root" has a concrete destination id
  // (the root listing itself is `parent=null`). The auth-context user carries
  // the authoritative value — known even when the root is EMPTY (a brand-new
  // account), where there is no child's parent_id to derive it from. The
  // legacy child-derived path is kept only as a fallback for the (transient)
  // window before the auth user has loaded.
  const { user } = useAuth();
  const rootIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (user && typeof user.rootNodeId === 'number') {
      rootIdRef.current = user.rootNodeId;
    } else if (parentId === null && children.length > 0 && children[0].parent_id !== null) {
      rootIdRef.current = children[0].parent_id;
    }
  }, [user, parentId, children]);

  const trashMutation = useTrashNode();
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<NodeDto | null>(null);
  const [moveTarget, setMoveTarget] = useState<NodeDto | null>(null);
  const [shareTarget, setShareTarget] = useState<NodeDto | null>(null);
  const [autoDeleteTarget, setAutoDeleteTarget] = useState<NodeDto | null>(null);

  function openFolder(node: NodeDto) {
    navigate(`/?parent=${node.id}`, { state: { trail: [...trail, { id: node.id, name: node.name }] } });
  }
  function goRoot() {
    navigate('/', { state: { trail: [] } });
  }
  function goCrumb(index: number) {
    navigate(`/?parent=${trail[index].id}`, { state: { trail: trail.slice(0, index + 1) } });
  }
  function onTrash(node: NodeDto) {
    trashMutation.mutate(node.id, {
      onSuccess: () => toast({ kind: 'success', message: t('dashboard.toast.trashed') }),
      onError: () => toast({ kind: 'error', message: t('dashboard.toast.trashFailed') }),
    });
  }

  return (
    <DashboardShell>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-lg text-ink">{t('dashboard.title')}</h1>
          <Button variant="secondary" onClick={() => setNewFolderOpen(true)}>
            {t('dashboard.newFolder')}
          </Button>
        </div>

        <Breadcrumb trail={trail} onRoot={goRoot} onCrumb={goCrumb} />

        <UploadDrop parentId={parentId} />

        <Register
          isPending={isPending}
          isError={isError}
          nodes={children}
          shareByNode={shareByNode}
          onOpen={openFolder}
          onRename={setRenameTarget}
          onMove={setMoveTarget}
          onShare={setShareTarget}
          onAutoDelete={setAutoDeleteTarget}
          onTrash={onTrash}
        />
      </div>

      <NewFolderModal
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        parentId={parentId}
      />
      {renameTarget && (
        <RenameModal node={renameTarget} onClose={() => setRenameTarget(null)} />
      )}
      {moveTarget && (
        <MoveModal
          node={moveTarget}
          onClose={() => setMoveTarget(null)}
          currentFolderId={parentId}
          rootId={rootIdRef.current}
          trail={trail}
          siblings={children}
        />
      )}
      {shareTarget && (
        <ShareModal node={shareTarget} onClose={() => setShareTarget(null)} />
      )}
      {autoDeleteTarget && (
        <AutoDeleteMenu node={autoDeleteTarget} onClose={() => setAutoDeleteTarget(null)} />
      )}
    </DashboardShell>
  );
}

/* ── Breadcrumb ───────────────────────────────────────────────────────── */

function Breadcrumb({
  trail,
  onRoot,
  onCrumb,
}: {
  trail: Crumb[];
  onRoot: () => void;
  onCrumb: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('dashboard.breadcrumb.label')} className="font-body text-sm">
      <ol className="flex flex-wrap items-center gap-1">
        <li>
          {trail.length === 0 ? (
            <span aria-current="page" className="text-ink">
              {t('dashboard.breadcrumb.root')}
            </span>
          ) : (
            <button type="button" onClick={onRoot} className="text-teal">
              {t('dashboard.breadcrumb.root')}
            </button>
          )}
        </li>
        {trail.map((crumb, index) => {
          const isLast = index === trail.length - 1;
          return (
            <li key={crumb.id} className="flex items-center gap-1">
              <span aria-hidden="true" className="text-ink-2">
                /
              </span>
              {isLast ? (
                <span aria-current="page" className="text-ink">
                  {crumb.name}
                </span>
              ) : (
                <button type="button" onClick={() => onCrumb(index)} className="text-teal">
                  {crumb.name}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* ── Register (the ledger list) ───────────────────────────────────────── */

function Register({
  isPending,
  isError,
  nodes,
  shareByNode,
  onOpen,
  onRename,
  onMove,
  onShare,
  onAutoDelete,
  onTrash,
}: {
  isPending: boolean;
  isError: boolean;
  nodes: NodeDto[];
  shareByNode: Map<number, ShareDto>;
  onOpen: (node: NodeDto) => void;
  onRename: (node: NodeDto) => void;
  onMove: (node: NodeDto) => void;
  onShare: (node: NodeDto) => void;
  onAutoDelete: (node: NodeDto) => void;
  onTrash: (node: NodeDto) => void;
}) {
  const { t } = useTranslation();

  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const sorted = useMemo(() => sortNodes(nodes, sort), [nodes, sort]);

  function onSortKey(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }
  const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' =>
    sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';

  if (isPending) {
    return <p className="font-body text-sm text-ink-2">{t('dashboard.loading')}</p>;
  }
  if (isError) {
    return (
      <p role="alert" className="font-body text-sm text-clay">
        {t('dashboard.error')}
      </p>
    );
  }
  if (nodes.length === 0) {
    // §4.9 empty-root copy, verbatim.
    return <p className="font-body text-sm text-ink-2">{t('dashboard.empty')}</p>;
  }

  return (
    <>
      {/* Desktop (≥ md): the register table, unchanged — only the wrapper
          gained `hidden md:block` so it yields to the mobile card list below md. */}
      <div className="hidden overflow-x-auto rounded-[10px] border border-line bg-surface md:block">
        <table className="w-full border-collapse font-body text-sm">
          <thead>
            <tr className="border-b border-line text-ink-2">
              <th aria-sort={ariaSort('name')} className="ps-3 pe-3 py-2 text-start font-medium">
                <button type="button" onClick={() => onSortKey('name')} className="inline-flex items-center gap-1 hover:text-ink">
                  {t('dashboard.col.name')}
                  {sort.key === 'name' && <span aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </button>
              </th>
              <th aria-sort={ariaSort('size')} className="ps-3 pe-3 py-2 text-start font-medium">
                <button type="button" onClick={() => onSortKey('size')} className="inline-flex items-center gap-1 hover:text-ink">
                  {t('dashboard.col.size')}
                  {sort.key === 'size' && <span aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </button>
              </th>
              <th aria-sort={ariaSort('date')} className="ps-3 pe-3 py-2 text-start font-medium">
                <button type="button" onClick={() => onSortKey('date')} className="inline-flex items-center gap-1 hover:text-ink">
                  {t('dashboard.col.date')}
                  {sort.key === 'date' && <span aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </button>
              </th>
              <th className="ps-3 pe-3 py-2 text-start font-medium">{t('dashboard.col.status')}</th>
              <th className="ps-3 pe-3 py-2 text-start font-medium">
                <span className="sr-only">{t('dashboard.col.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((node) => (
              <NodeRow
                key={node.id}
                variant="row"
                node={node}
                share={shareByNode.get(node.id) ?? null}
                onOpen={onOpen}
                onRename={onRename}
                onMove={onMove}
                onShare={onShare}
                onAutoDelete={onAutoDelete}
                onTrash={onTrash}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile (< md): a compact sort control (no table header to click), then
          the same nodes as a stacked card list — same data, same handlers,
          same modals (see NodeRow's `variant` prop). */}
      <div className="flex items-center gap-2 md:hidden">
        <label htmlFor="mobile-sort-key" className="font-body text-xs text-ink-2">
          {t('dashboard.sort.label')}
        </label>
        <select
          id="mobile-sort-key"
          value={sort.key}
          onChange={(e) => setSort((s) => ({ key: e.target.value as SortKey, dir: s.dir }))}
          className="rounded-md border border-line bg-surface ps-2 pe-2 py-1 font-body text-xs text-ink"
        >
          <option value="name">{t('dashboard.sort.byName')}</option>
          <option value="size">{t('dashboard.sort.bySize')}</option>
          <option value="date">{t('dashboard.sort.byDate')}</option>
        </select>
        <button
          type="button"
          aria-label={t('dashboard.sort.toggleDir')}
          onClick={() => setSort((s) => ({ key: s.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }))}
          className="inline-flex min-h-10 items-center rounded-md border border-line px-2 py-1 font-body text-xs text-ink"
        >
          {sort.dir === 'asc' ? '↑' : '↓'}
        </button>
      </div>
      <div className="flex flex-col gap-3 md:hidden">
        {sorted.map((node) => (
          <NodeRow
            key={node.id}
            variant="card"
            node={node}
            share={shareByNode.get(node.id) ?? null}
            onOpen={onOpen}
            onRename={onRename}
            onMove={onMove}
            onShare={onShare}
            onAutoDelete={onAutoDelete}
            onTrash={onTrash}
          />
        ))}
      </div>
    </>
  );
}

/**
 * File-row action controls. Compact bordered chips (not bare coloured text) so
 * a row of actions reads as a toolbar of buttons — teal accent for the normal
 * actions, clay text for the destructive Trash. A hairline border makes each
 * read as a button at rest; hover tints to paper.
 */
const ROW_ACTION =
  'inline-flex min-h-10 items-center rounded-md border border-line px-2.5 py-1 font-body text-xs text-teal transition-colors hover:bg-paper focus-visible:bg-paper';
const ROW_ACTION_DANGER =
  'inline-flex min-h-10 items-center rounded-md border border-line px-2.5 py-1 font-body text-xs text-clay transition-colors hover:bg-paper focus-visible:bg-paper';

/** A subtle status pill for a share's active lifecycle controls (password /
 *  remaining downloads / expiry), shown under the status chip in the register. */
function SharePill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-paper px-2 py-0.5 font-body text-[11px] text-ink-2">
      <span className="inline-flex shrink-0">{icon}</span>
      <bdi>{label}</bdi>
    </span>
  );
}

/**
 * Live share state at a glance (§4.6 / §4.4): the GRANULAR status
 * (active/stopped/expired/exhausted) + a quick copy-link, then pills for the
 * lifecycle controls in force — password, remaining downloads, expiry.
 * Shared verbatim between the desktop status cell and the mobile card's
 * status row — the ONLY place this markup/logic is written.
 */
function ShareStatus({
  share,
  downloadsLeft,
  onCopy,
}: {
  share: ShareDto;
  downloadsLeft: number | null;
  onCopy: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip status={share.status} />
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 font-body text-xs text-teal transition-colors hover:bg-paper focus-visible:bg-paper"
        >
          <Copy size={13} />
          {t('share.copy')}
        </button>
      </div>
      {(share.has_password || share.expires_at != null || share.download_limit != null) && (
        <div className="flex flex-wrap items-center gap-1">
          {share.has_password && (
            <SharePill icon={<Lock size={12} />} label={t('dashboard.share.password')} />
          )}
          {share.download_limit != null && (
            <SharePill
              icon={<DownloadArrow size={12} />}
              label={t('dashboard.share.downloadsLeft', { n: downloadsLeft })}
            />
          )}
          {share.expires_at != null && (
            <SharePill icon={<CalendarStamp size={12} />} label={formatDate(share.expires_at)} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The row's action chips (download/share/auto-delete/rename/move/trash — a
 * subset applies per node kind). Shared verbatim between the desktop actions
 * cell and the mobile card's action row — the ONLY place these six buttons
 * (labels/handlers/hrefs) are written; the two callers differ only in the
 * wrapping container's layout classes.
 */
function NodeActionButtons({
  node,
  isFolder,
  onShare,
  onAutoDelete,
  onRename,
  onMove,
  onTrash,
}: {
  node: NodeDto;
  isFolder: boolean;
  onShare: (node: NodeDto) => void;
  onAutoDelete: (node: NodeDto) => void;
  onRename: (node: NodeDto) => void;
  onMove: (node: NodeDto) => void;
  onTrash: (node: NodeDto) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {!isFolder && (
        <a href={downloadUrl(node.id)} className={ROW_ACTION}>
          {t('dashboard.action.download')}
        </a>
      )}
      <button type="button" onClick={() => onShare(node)} className={ROW_ACTION}>
        {t('dashboard.action.share')}
      </button>
      <button type="button" onClick={() => onAutoDelete(node)} className={ROW_ACTION}>
        {t('dashboard.action.autoDelete')}
      </button>
      <button type="button" onClick={() => onRename(node)} className={ROW_ACTION}>
        {t('dashboard.action.rename')}
      </button>
      <button type="button" onClick={() => onMove(node)} className={ROW_ACTION}>
        {t('dashboard.action.move')}
      </button>
      <button type="button" onClick={() => onTrash(node)} className={ROW_ACTION_DANGER}>
        {t('dashboard.action.trash')}
      </button>
    </>
  );
}

/**
 * A node's per-node behavior (navigate/copy-link/derived flags) plus BOTH of
 * its presentations. `variant` switches ONLY the returned JSX layout —
 * `'row'` renders the desktop `<tr>` byte-identically to before this refactor,
 * `'card'` renders the mobile card — while every handler, derived value, and
 * the shared `ShareStatus`/`NodeActionButtons` sub-components above are the
 * single code path both variants call. There is no separate hook because
 * this component owns no modal state itself — every modal (rename/move/share/
 * auto-delete) is opened by the callback props and rendered once by the
 * `DriveView` parent, already shared by construction.
 */
function NodeRow({
  node,
  share,
  variant = 'row',
  onOpen,
  onRename,
  onMove,
  onShare,
  onAutoDelete,
  onTrash,
}: {
  node: NodeDto;
  share: ShareDto | null;
  variant?: 'row' | 'card';
  onOpen: (node: NodeDto) => void;
  onRename: (node: NodeDto) => void;
  onMove: (node: NodeDto) => void;
  onShare: (node: NodeDto) => void;
  onAutoDelete: (node: NodeDto) => void;
  onTrash: (node: NodeDto) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const isFolder = node.kind === 'folder';

  async function copyLink() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      toast({ kind: 'success', message: t('share.toast.copied') });
    } catch {
      toast({ kind: 'error', message: t('share.toast.copyFailed') });
    }
  }

  // Remaining downloads for a capped share (never below 0).
  const downloadsLeft =
    share && share.download_limit != null
      ? Math.max(0, share.download_limit - share.download_count)
      : null;

  if (variant === 'card') {
    return (
      <div
        data-testid={`drive-card-${node.id}`}
        className="rounded-[10px] border border-line bg-surface p-3"
      >
        {isFolder ? (
          <button
            type="button"
            onClick={() => onOpen(node)}
            title={t('dashboard.openFolder')}
            className="group flex w-full items-center gap-2 rounded-md text-start"
          >
            <span data-testid="icon-folder" className="inline-flex shrink-0 text-brass">
              <FolderDossier size={20} />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-ink group-hover:text-teal">
              {node.name}
            </span>
            <span className="inline-flex shrink-0 text-ink-2 group-hover:text-teal">
              <ChevronEnter size={16} />
            </span>
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span data-testid="icon-file" className="inline-flex shrink-0 text-ink-2">
              <FileSheet size={20} />
            </span>
            <span className="min-w-0 flex-1 truncate text-ink">{node.name}</span>
          </div>
        )}

        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink-2">
          <bdi dir="ltr" className="font-mono">
            {formatBytes(node.size_bytes)}
          </bdi>
          <span aria-hidden="true">·</span>
          <bdi dir="ltr" className="font-mono">
            {formatDate(node.updated_at)}
          </bdi>
        </div>

        {share && (
          <div className="mt-2">
            <ShareStatus share={share} downloadsLeft={downloadsLeft} onCopy={copyLink} />
          </div>
        )}

        <div className="mt-2 flex flex-wrap gap-2">
          <NodeActionButtons
            node={node}
            isFolder={isFolder}
            onShare={onShare}
            onAutoDelete={onAutoDelete}
            onRename={onRename}
            onMove={onMove}
            onTrash={onTrash}
          />
        </div>
      </div>
    );
  }

  return (
    <tr className="border-b border-line last:border-b-0 hover:bg-paper">
      <td className="ps-3 pe-3 py-2">
        {isFolder ? (
          // A folder is a full-width click target — brass dossier icon, a bold
          // name, and an always-visible "open" chevron so it clearly reads as
          // navigable (not just teal text).
          <button
            type="button"
            onClick={() => onOpen(node)}
            title={t('dashboard.openFolder')}
            className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-start transition-colors hover:bg-paper focus-visible:bg-paper"
          >
            <span data-testid="icon-folder" className="inline-flex shrink-0 text-brass">
              <FolderDossier size={20} />
            </span>
            <span className="font-medium text-ink group-hover:text-teal">{node.name}</span>
            <span className="ms-auto inline-flex shrink-0 text-ink-2 group-hover:text-teal">
              <ChevronEnter size={16} />
            </span>
          </button>
        ) : (
          <div className="flex items-center gap-2 px-1 py-1">
            <span data-testid="icon-file" className="inline-flex shrink-0 text-ink-2">
              <FileSheet size={20} />
            </span>
            <span className="text-ink">{node.name}</span>
          </div>
        )}
      </td>
      <td className="ps-3 pe-3 py-2">
        <bdi dir="ltr" className="font-mono text-ink-2">
          {formatBytes(node.size_bytes)}
        </bdi>
      </td>
      <td className="ps-3 pe-3 py-2">
        <bdi dir="ltr" className="font-mono text-ink-2">
          {formatDate(node.updated_at)}
        </bdi>
      </td>
      <td className="ps-3 pe-3 py-2">
        {share ? (
          <ShareStatus share={share} downloadsLeft={downloadsLeft} onCopy={copyLink} />
        ) : (
          <span aria-hidden="true" className="text-ink-2">
            —
          </span>
        )}
      </td>
      <td className="ps-3 pe-3 py-2">
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <NodeActionButtons
            node={node}
            isFolder={isFolder}
            onShare={onShare}
            onAutoDelete={onAutoDelete}
            onRename={onRename}
            onMove={onMove}
            onTrash={onTrash}
          />
        </div>
      </td>
    </tr>
  );
}

/* ── Modals: new folder / rename / move (all 409-aware) ───────────────── */

function NewFolderModal({
  open,
  onClose,
  parentId,
}: {
  open: boolean;
  onClose: () => void;
  parentId: number | null;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const create = useCreateFolder();
  const inputId = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
    }
  }, [open]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('dashboard.folder.required'));
      return;
    }
    setError(null);
    // At root the URL carries no `parent` (parentId === null); the server
    // resolves the synthetic root itself, so an empty brand-new account can
    // still create its first folder without knowing the concrete root id.
    create.mutate(
      { parentId, name: trimmed },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('dashboard.toast.folderCreated') });
          onClose();
        },
        onError: (err) => {
          setError(
            err instanceof ApiError && err.status === 409
              ? t('dashboard.folder.conflict')
              : t('dashboard.folder.error')
          );
        },
      }
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('dashboard.folder.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => submit()} disabled={create.isPending}>
            {t('dashboard.folder.create')}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <label htmlFor={inputId} className="block font-body text-sm text-ink-2">
          {t('dashboard.folder.nameLabel')}
        </label>
        <input
          id={inputId}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
        />
        {error !== null && (
          <p role="alert" className="mt-2 font-body text-sm text-clay">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function RenameModal({ node, onClose }: { node: NodeDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const rename = useRenameNode();
  const inputId = useId();
  const [name, setName] = useState(node.name);
  const [error, setError] = useState<string | null>(null);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('dashboard.folder.required'));
      return;
    }
    setError(null);
    rename.mutate(
      { id: node.id, name: trimmed },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('dashboard.toast.renamed') });
          onClose();
        },
        onError: (err) => {
          setError(
            err instanceof ApiError && err.status === 409
              ? t('dashboard.folder.conflict')
              : t('dashboard.rename.error')
          );
        },
      }
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('dashboard.rename.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => submit()} disabled={rename.isPending}>
            {t('dashboard.rename.submit')}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <label htmlFor={inputId} className="block font-body text-sm text-ink-2">
          {t('dashboard.rename.label')}
        </label>
        <input
          id={inputId}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
        />
        {error !== null && (
          <p role="alert" className="mt-2 font-body text-sm text-clay">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function MoveModal({
  node,
  onClose,
  currentFolderId,
  rootId,
  trail,
  siblings,
}: {
  node: NodeDto;
  onClose: () => void;
  currentFolderId: number | null;
  rootId: number | null;
  trail: Crumb[];
  siblings: NodeDto[];
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const move = useMoveNode();
  const selectId = useId();

  // Destinations we can address with a concrete node id: root (when known),
  // ancestor folders from the breadcrumb, and child folders in this listing —
  // never the current folder (a no-op) or the node itself.
  const targets: Crumb[] = [];
  const seen = new Set<number>();
  function push(target: Crumb) {
    if (target.id === node.id || target.id === currentFolderId || seen.has(target.id)) return;
    seen.add(target.id);
    targets.push(target);
  }
  if (rootId !== null) push({ id: rootId, name: t('dashboard.breadcrumb.root') });
  trail.forEach((crumb) => push(crumb));
  siblings.filter((s) => s.kind === 'folder').forEach((s) => push({ id: s.id, name: s.name }));

  const [target, setTarget] = useState<string>(targets.length > 0 ? String(targets[0].id) : '');
  const [error, setError] = useState<string | null>(null);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const destId = Number(target);
    if (!Number.isInteger(destId)) {
      setError(t('dashboard.move.error'));
      return;
    }
    setError(null);
    move.mutate(
      { id: node.id, parentId: destId },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('dashboard.toast.moved') });
          onClose();
        },
        onError: (err) => {
          setError(
            err instanceof ApiError && err.status === 409
              ? t('dashboard.folder.conflict')
              : t('dashboard.move.error')
          );
        },
      }
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('dashboard.move.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => submit()}
            disabled={move.isPending || targets.length === 0}
          >
            {t('dashboard.move.submit')}
          </Button>
        </>
      }
    >
      {targets.length === 0 ? (
        <p className="font-body text-sm text-ink-2">{t('dashboard.move.noTargets')}</p>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor={selectId} className="block font-body text-sm text-ink-2">
            {t('dashboard.move.label')}
          </label>
          <select
            id={selectId}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
          >
            {targets.map((option) => (
              <option key={option.id} value={String(option.id)}>
                {option.name}
              </option>
            ))}
          </select>
          {error !== null && (
            <p role="alert" className="mt-2 font-body text-sm text-clay">
              {error}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}
