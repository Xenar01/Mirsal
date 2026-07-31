import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../components/Modal';
import Button from '../../../components/Button';
import Seal from '../../../components/Seal';
import StatusChip from '../../../components/StatusChip';
import { useToast } from '../../../components/Toast';
import { Copy } from '../../../components/icons';
import { formatDate } from '../format';
import { useShares, useCreateShare, usePatchShare, useRevokeShare } from './queries';
import { damascusInputToUtcMs, utcMsToDamascusInput } from './datetime';
import type { NodeDto } from '../types';
import type { ShareDto } from './types';

/*
 * ShareModal — the owner's per-node share console (§3.3 / §4.4).
 *
 * Opened for a selected file/folder. Before a share exists it offers one
 * "create share" action; on success the brass Seal plays its single stamp press
 * (the app's only orchestrated motion, honouring reduced-motion via J1 Seal)
 * and the public link is revealed. Once shared, the owner can copy the link,
 * start/stop it (StatusChip reflects active/stopped/expired — never colour
 * alone), set or clear a password (presence only — the stored value is NEVER
 * shown), schedule or clear a Damascus expiry (converted to UTC epoch-ms at the
 * boundary; a past instant is rejected client-side), and revoke it for good.
 * An expired link is guided back to life by setting a new future expiry (or
 * clearing it) — merely restarting won't un-expire it (§3.3).
 */
export default function ShareModal({ node, onClose }: { node: NodeDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useShares();
  const share = Array.isArray(data) ? data.find((s) => s.node_id === node.id) ?? null : null;
  // The stamp is the dispatch MOMENT — it fires only when a link is PUBLISHED in
  // this session, never on every reopen of an already-shared node (§4.4).
  const [justPublished, setJustPublished] = useState(false);

  let body;
  if (share) {
    // Step 2 — the published link.
    body = <PublishedStep share={share} stamp={justPublished} nodeKind={node.kind} />;
  } else if (justPublished || isPending) {
    // Just published (awaiting the shares refetch) or the first load — hold a
    // neutral state so the configure form doesn't flash back and reset.
    body = <p className="font-body text-sm text-ink-2">{t('share.loading')}</p>;
  } else if (isError) {
    // A failed GET /api/shares is NOT proof the node is unshared — surface the
    // error rather than offering "publish" and risking a duplicate.
    body = (
      <p role="alert" className="font-body text-sm text-clay">
        {t('share.error')}
      </p>
    );
  } else {
    // Step 1 — configure the link before it exists.
    body = (
      <ConfigureStep
        nodeId={node.id}
        nodeKind={node.kind}
        onPublished={() => setJustPublished(true)}
      />
    );
  }

  return (
    <Modal open onClose={onClose} title={t('share.title')}>
      <div className="flex flex-col gap-4">
        <p className="font-body text-sm text-ink">{node.name}</p>
        {body}
      </div>
    </Modal>
  );
}

/* ── Step 1 — configure the link, THEN publish it ──────────────────────── */

function ConfigureStep({
  nodeId,
  nodeKind,
  onPublished,
}: {
  nodeId: number;
  nodeKind: NodeDto['kind'];
  onPublished: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const create = useCreateShare();
  const patch = usePatchShare();
  const isFile = nodeKind === 'file';
  const pwId = useId();
  const expId = useId();
  const limId = useId();
  const [password, setPassword] = useState('');
  const [expiry, setExpiry] = useState('');
  const [limit, setLimit] = useState('');
  const [mode, setMode] = useState<'delete' | 'stop'>('delete');
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || patch.isPending;

  // Publish = create the link, then apply the collected config in one PATCH.
  async function publish(event?: FormEvent) {
    event?.preventDefault();
    const cfg: {
      password?: string;
      expiresAt?: number;
      downloadLimit?: number;
      onExhaust?: 'delete' | 'stop';
    } = {};
    if (password.trim()) cfg.password = password.trim();
    if (expiry) {
      const utcMs = damascusInputToUtcMs(expiry);
      if (utcMs === null) {
        setError(t('share.expiry.invalid'));
        return;
      }
      if (utcMs <= Date.now()) {
        setError(t('share.expiry.past'));
        return;
      }
      cfg.expiresAt = utcMs;
    }
    if (isFile && limit.trim()) {
      const n = Number(limit);
      if (!Number.isInteger(n) || n < 1) {
        setError(t('share.downloadLimit.invalid'));
        return;
      }
      cfg.downloadLimit = n;
      cfg.onExhaust = mode;
    }
    setError(null);
    try {
      const created = await create.mutateAsync({ nodeId });
      if (Object.keys(cfg).length > 0) {
        await patch.mutateAsync({ id: created.id, ...cfg });
      }
      toast({ kind: 'success', message: t('share.toast.created') });
      onPublished();
    } catch {
      toast({ kind: 'error', message: t('share.toast.error') });
    }
  }

  return (
    <form onSubmit={publish} className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <Seal size="dispatch" />
        <p className="font-body text-sm text-ink-2">{t('share.wizard.configureIntro')}</p>
      </div>

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="font-display text-sm text-ink">{t('share.password.heading')}</h3>
        <label htmlFor={pwId} className="font-body text-sm text-ink-2">
          {t('share.password.label')}
        </label>
        <input
          id={pwId}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
        />
        <p className="font-body text-xs text-ink-2">{t('share.wizard.optional')}</p>
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="font-display text-sm text-ink">{t('share.expiry.heading')}</h3>
        <label htmlFor={expId} className="font-body text-sm text-ink-2">
          {t('share.expiry.label')}
        </label>
        <input
          id={expId}
          type="datetime-local"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-mono text-sm text-ink"
        />
        <p className="font-body text-xs text-ink-2">{t('share.wizard.optional')}</p>
      </section>

      {isFile && (
        <section className="flex flex-col gap-2 border-t border-line pt-4">
          <h3 className="font-display text-sm text-ink">{t('share.downloadLimit.heading')}</h3>
          <label htmlFor={limId} className="font-body text-sm text-ink-2">
            {t('share.downloadLimit.label')}
          </label>
          <input
            id={limId}
            type="number"
            min={1}
            inputMode="numeric"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-mono text-sm text-ink"
          />
          <fieldset className="flex flex-col gap-1">
            <legend className="font-body text-sm text-ink-2">
              {t('share.downloadLimit.onExhaust')}
            </legend>
            <label className="flex items-center gap-2 font-body text-sm text-ink">
              <input
                type="radio"
                name="onExhaust"
                checked={mode === 'delete'}
                onChange={() => setMode('delete')}
              />
              {t('share.downloadLimit.modeDelete')}
            </label>
            <label className="flex items-center gap-2 font-body text-sm text-ink">
              <input
                type="radio"
                name="onExhaust"
                checked={mode === 'stop'}
                onChange={() => setMode('stop')}
              />
              {t('share.downloadLimit.modeStop')}
            </label>
            {mode === 'delete' && (
              <p role="note" className="font-body text-xs text-clay">
                {t('share.downloadLimit.deleteWarning')}
              </p>
            )}
          </fieldset>
          <p className="font-body text-xs text-ink-2">{t('share.wizard.optional')}</p>
        </section>
      )}

      {error !== null && (
        <p role="alert" className="font-body text-sm text-clay">
          {error}
        </p>
      )}

      <Button variant="primary" type="submit" disabled={busy}>
        {t('share.wizard.publish')}
      </Button>
    </form>
  );
}

/* ── Step 2 — the published link: copy, manage, edit, revoke ────────────── */

function PublishedStep({
  share,
  stamp,
  nodeKind,
}: {
  share: ShareDto;
  stamp: boolean;
  nodeKind: NodeDto['kind'];
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchShare();
  const [editing, setEditing] = useState(false);

  function toggleActive() {
    const next = !share.is_active;
    patch.mutate(
      { id: share.id, isActive: next },
      {
        // Report the SERVER's derived status, not the flag we sent: starting a
        // share whose expiry has already passed leaves it 'expired', not
        // 'active' (§3.3 restart rule) — so we must not claim it "started".
        onSuccess: (updated) => {
          if (!next) {
            toast({ kind: 'success', message: t('share.toast.stopped') });
          } else if (updated.status === 'active') {
            toast({ kind: 'success', message: t('share.toast.started') });
          } else {
            toast({ kind: 'error', message: t('share.toast.startedExpired') });
          }
        },
        onError: () => toast({ kind: 'error', message: t('share.toast.error') }),
      }
    );
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(share.url);
      toast({ kind: 'success', message: t('share.toast.copied') });
    } catch {
      toast({ kind: 'error', message: t('share.toast.copyFailed') });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-2">
        <Seal size="dispatch" stamp={stamp} />
        <StatusChip status={share.status} />
      </div>

      {/* Public link — mono, LTR bidi-isolated so it never scrambles (§4.3).
          Copy is the primary action on the published step. */}
      <div className="flex flex-col gap-1">
        <span className="font-body text-sm text-ink-2">{t('share.linkLabel')}</span>
        <div className="flex flex-wrap items-center gap-2">
          <bdi
            dir="ltr"
            className="min-w-0 grow overflow-x-auto rounded-lg border border-line bg-paper ps-2 pe-2 py-1 font-mono text-sm text-ink"
          >
            {share.url}
          </bdi>
          <Button variant="primary" onClick={copyLink}>
            <Copy size={16} />
            {t('share.copy')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={toggleActive} disabled={patch.isPending}>
          {share.is_active ? t('share.stop') : t('share.start')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setEditing((v) => !v)}
          aria-expanded={editing}
        >
          {t('share.wizard.editSettings')}
        </Button>
      </div>

      {/* Settings live behind an explicit toggle so the published step stays
          focused on the link + copy (the two-page wizard's second page). */}
      {editing && (
        <>
          <PasswordSection share={share} />
          <ExpirySection share={share} />
          <DownloadLimitSection share={share} nodeKind={nodeKind} />
        </>
      )}

      <RevokeSection share={share} />
    </div>
  );
}

/* ── Password: set (non-empty) / clear (null) — never shows the value ───── */

function PasswordSection({ share }: { share: ShareDto }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchShare();
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
      { id: share.id, password: next },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('share.toast.passwordSet') });
          setValue('');
        },
        onError: () => toast({ kind: 'error', message: t('share.toast.error') }),
      }
    );
  }

  function clear() {
    patch.mutate(
      { id: share.id, password: null },
      {
        onSuccess: () => toast({ kind: 'success', message: t('share.toast.passwordCleared') }),
        onError: () => toast({ kind: 'error', message: t('share.toast.error') }),
      }
    );
  }

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="font-display text-sm text-ink">{t('share.password.heading')}</h3>
      <p className="font-body text-sm text-ink-2">
        {share.has_password ? t('share.password.protected') : t('share.password.unprotected')}
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
        <p className="font-body text-xs text-ink-2">{t('share.password.hint')}</p>
        {error !== null && (
          <p role="alert" className="font-body text-sm text-clay">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" type="submit" disabled={patch.isPending}>
            {share.has_password ? t('share.password.change') : t('share.password.set')}
          </Button>
          {share.has_password && (
            <Button variant="ghost" onClick={clear} disabled={patch.isPending}>
              {t('share.password.clear')}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

/* ── Expiry: future Damascus datetime → UTC epoch-ms / clear / restart ──── */

function ExpirySection({ share }: { share: ShareDto }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchShare();
  const inputId = useId();
  const [value, setValue] = useState(
    share.expires_at != null ? utcMsToDamascusInput(share.expires_at) : ''
  );
  const [error, setError] = useState<string | null>(null);

  function apply(event?: FormEvent) {
    event?.preventDefault();
    const utcMs = damascusInputToUtcMs(value);
    if (utcMs === null) {
      setError(t('share.expiry.invalid'));
      return;
    }
    if (utcMs <= Date.now()) {
      setError(t('share.expiry.past'));
      return;
    }
    setError(null);
    patch.mutate(
      { id: share.id, expiresAt: utcMs },
      {
        onSuccess: () => toast({ kind: 'success', message: t('share.toast.expirySet') }),
        onError: () => toast({ kind: 'error', message: t('share.toast.error') }),
      }
    );
  }

  function clear() {
    setError(null);
    patch.mutate(
      { id: share.id, expiresAt: null },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('share.toast.expiryCleared') });
          setValue('');
        },
        onError: () => toast({ kind: 'error', message: t('share.toast.error') }),
      }
    );
  }

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="font-display text-sm text-ink">{t('share.expiry.heading')}</h3>
      <p className="font-body text-sm text-ink-2">
        {share.expires_at != null ? (
          <>
            <span>{t('share.expiry.current')} </span>
            <bdi dir="ltr" className="font-mono">
              {formatDate(share.expires_at)}
            </bdi>
          </>
        ) : (
          t('share.expiry.never')
        )}
      </p>
      {share.status === 'expired' && (
        <p role="note" className="font-body text-sm text-clay">
          {t('share.expiredNote')}
        </p>
      )}
      <form onSubmit={apply} className="flex flex-col gap-2">
        <label htmlFor={inputId} className="font-body text-sm text-ink-2">
          {t('share.expiry.label')}
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
            {t('share.expiry.apply')}
          </Button>
          {share.expires_at != null && (
            <Button variant="ghost" onClick={clear} disabled={patch.isPending}>
              {t('share.expiry.clear')}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

/* ── Download limit: burn-after-N downloads → stop the link or delete the file ─ */

function DownloadLimitSection({
  share,
  nodeKind,
}: {
  share: ShareDto;
  nodeKind: NodeDto['kind'];
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchShare();
  const inputId = useId();
  const [value, setValue] = useState(
    share.download_limit != null ? String(share.download_limit) : ''
  );
  const [mode, setMode] = useState<'delete' | 'stop'>(share.on_exhaust);
  const [error, setError] = useState<string | null>(null);
  // v1: a per-file download cap has no meaning for a whole-folder share.
  if (nodeKind !== 'file') return null;

  function apply(event?: FormEvent) {
    event?.preventDefault();
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      setError(t('share.downloadLimit.invalid'));
      return;
    }
    setError(null);
    patch.mutate(
      { id: share.id, downloadLimit: n, onExhaust: mode },
      {
        onSuccess: () => toast({ kind: 'success', message: t('share.downloadLimit.toast.set') }),
        onError: () => toast({ kind: 'error', message: t('share.toast.error') }),
      }
    );
  }

  function clear() {
    setError(null);
    patch.mutate(
      { id: share.id, downloadLimit: null },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('share.downloadLimit.toast.cleared') });
          setValue('');
        },
        onError: () => toast({ kind: 'error', message: t('share.toast.error') }),
      }
    );
  }

  const isLimited = share.download_limit != null;
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="font-display text-sm text-ink">{t('share.downloadLimit.heading')}</h3>
      <p className="font-body text-sm text-ink-2">
        {isLimited
          ? t('share.downloadLimit.used', {
              used: share.download_count,
              limit: share.download_limit,
            })
          : t('share.downloadLimit.unlimited')}
      </p>
      <form onSubmit={apply} className="flex flex-col gap-2">
        <label htmlFor={inputId} className="font-body text-sm text-ink-2">
          {t('share.downloadLimit.label')}
        </label>
        <input
          id={inputId}
          type="number"
          min={1}
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-mono text-sm text-ink"
        />
        <fieldset className="flex flex-col gap-1">
          <legend className="font-body text-sm text-ink-2">
            {t('share.downloadLimit.onExhaust')}
          </legend>
          <label className="flex items-center gap-2 font-body text-sm text-ink">
            <input
              type="radio"
              name="onExhaust"
              checked={mode === 'delete'}
              onChange={() => setMode('delete')}
            />
            {t('share.downloadLimit.modeDelete')}
          </label>
          <label className="flex items-center gap-2 font-body text-sm text-ink">
            <input
              type="radio"
              name="onExhaust"
              checked={mode === 'stop'}
              onChange={() => setMode('stop')}
            />
            {t('share.downloadLimit.modeStop')}
          </label>
          {mode === 'delete' && (
            <p role="note" className="font-body text-xs text-clay">
              {t('share.downloadLimit.deleteWarning')}
            </p>
          )}
        </fieldset>
        {error !== null && (
          <p role="alert" className="font-body text-sm text-clay">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" type="submit" disabled={patch.isPending}>
            {t('share.downloadLimit.apply')}
          </Button>
          {isLimited && (
            <Button variant="ghost" onClick={clear} disabled={patch.isPending}>
              {t('share.downloadLimit.clear')}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

/* ── Revoke (destructive, confirmed) ───────────────────────────────────── */

function RevokeSection({ share }: { share: ShareDto }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const revoke = useRevokeShare();
  const [confirming, setConfirming] = useState(false);

  function confirm() {
    revoke.mutate(share.id, {
      onSuccess: () => {
        toast({ kind: 'success', message: t('share.toast.revoked') });
        setConfirming(false);
      },
      onError: () => {
        toast({ kind: 'error', message: t('share.toast.error') });
        setConfirming(false);
      },
    });
  }

  return (
    <section className="border-t border-line pt-4">
      <Button variant="danger" onClick={() => setConfirming(true)}>
        {t('share.revoke')}
      </Button>
      {confirming && (
        <Modal
          open
          onClose={() => setConfirming(false)}
          title={t('share.confirm.title')}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                {t('share.confirm.cancel')}
              </Button>
              <Button variant="danger" onClick={confirm} disabled={revoke.isPending}>
                {t('share.confirm.confirm')}
              </Button>
            </>
          }
        >
          <p className="font-body text-sm text-ink">{t('share.confirm.body')}</p>
        </Modal>
      )}
    </section>
  );
}
