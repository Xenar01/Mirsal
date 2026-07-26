import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal';
import Button from '../../components/Button';
import { useToast } from '../../components/Toast';
import { FolderDossier, FileSheet } from '../../components/icons';
import { ApiError } from '../../lib/api';
import DashboardShell from './DashboardShell';
import UploadDrop from './UploadDrop';
import { downloadUrl } from './api';
import { formatBytes, formatDate } from './format';
import { useNodes, useCreateFolder, useRenameNode, useMoveNode, useTrashNode } from './queries';
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

  // Learn the synthetic root node id from a root child's parent_id, so "move to
  // root" has a concrete destination id (the root listing is `parent=null`).
  const rootIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (parentId === null && children.length > 0 && children[0].parent_id !== null) {
      rootIdRef.current = children[0].parent_id;
    }
  }, [parentId, children]);

  const trashMutation = useTrashNode();
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<NodeDto | null>(null);
  const [moveTarget, setMoveTarget] = useState<NodeDto | null>(null);

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
          onOpen={openFolder}
          onRename={setRenameTarget}
          onMove={setMoveTarget}
          onTrash={onTrash}
        />
      </div>

      <NewFolderModal
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        parentId={parentId}
        rootId={rootIdRef.current}
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
  onOpen,
  onRename,
  onMove,
  onTrash,
}: {
  isPending: boolean;
  isError: boolean;
  nodes: NodeDto[];
  onOpen: (node: NodeDto) => void;
  onRename: (node: NodeDto) => void;
  onMove: (node: NodeDto) => void;
  onTrash: (node: NodeDto) => void;
}) {
  const { t } = useTranslation();

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
    <div className="overflow-x-auto rounded-[10px] border border-line bg-surface">
      <table className="w-full border-collapse font-body text-sm">
        <thead>
          <tr className="border-b border-line text-ink-2">
            <th className="ps-3 pe-3 py-2 text-start font-medium">{t('dashboard.col.name')}</th>
            <th className="ps-3 pe-3 py-2 text-start font-medium">{t('dashboard.col.size')}</th>
            <th className="ps-3 pe-3 py-2 text-start font-medium">{t('dashboard.col.date')}</th>
            <th className="ps-3 pe-3 py-2 text-start font-medium">{t('dashboard.col.status')}</th>
            <th className="ps-3 pe-3 py-2 text-start font-medium">
              <span className="sr-only">{t('dashboard.col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <NodeRow
              key={node.id}
              node={node}
              onOpen={onOpen}
              onRename={onRename}
              onMove={onMove}
              onTrash={onTrash}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NodeRow({
  node,
  onOpen,
  onRename,
  onMove,
  onTrash,
}: {
  node: NodeDto;
  onOpen: (node: NodeDto) => void;
  onRename: (node: NodeDto) => void;
  onMove: (node: NodeDto) => void;
  onTrash: (node: NodeDto) => void;
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
              {node.name}
            </button>
          ) : (
            <span className="text-ink">{node.name}</span>
          )}
        </div>
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
        {/* J3 share-wiring seam: this column shows the brass Seal / StatusChip
            status="shared" once per-row share state is fetched. J2 renders the
            column only (fetching share state per row is J3's concern). */}
        <span aria-hidden="true" className="text-ink-2">
          —
        </span>
      </td>
      <td className="ps-3 pe-3 py-2">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!isFolder && (
            <a href={downloadUrl(node.id)} className="text-teal">
              {t('dashboard.action.download')}
            </a>
          )}
          <button type="button" onClick={() => onRename(node)} className="text-teal">
            {t('dashboard.action.rename')}
          </button>
          <button type="button" onClick={() => onMove(node)} className="text-teal">
            {t('dashboard.action.move')}
          </button>
          <button type="button" onClick={() => onTrash(node)} className="text-clay">
            {t('dashboard.action.trash')}
          </button>
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
  rootId,
}: {
  open: boolean;
  onClose: () => void;
  parentId: number | null;
  rootId: number | null;
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

  // Root listing is `parent=null`, but the create endpoint needs the concrete
  // root node id; fall back to it when at root.
  const targetParent = parentId ?? rootId;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('dashboard.folder.required'));
      return;
    }
    if (targetParent === null) {
      setError(t('dashboard.folder.error'));
      return;
    }
    setError(null);
    create.mutate(
      { parentId: targetParent, name: trimmed },
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
