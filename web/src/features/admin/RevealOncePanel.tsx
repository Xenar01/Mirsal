import { useTranslation } from 'react-i18next';
import Button from '../../components/Button';
import Seal from '../../components/Seal';
import { Copy } from '../../components/icons';
import { useToast } from '../../components/Toast';

/*
 * RevealOncePanel — the sealed-dispatch "credential handed over" moment (§4.4).
 *
 * Shows a freshly generated initial/reset password EXACTLY once: the server
 * never echoes it back (spec §3.1), so this panel is the only place it appears.
 * The value is ASCII, rendered in IBM Plex Mono inside a `<bdi dir="ltr">` so
 * it never scrambles in the RTL layout (§4.3/§4.5). The brass `dispatch` seal
 * marks the moment and plays the one-shot stamp press (honouring
 * prefers-reduced-motion inside the Seal). "Copy" writes it to the clipboard;
 * "Done" dismisses. It is never persisted or logged in the client.
 */
export default function RevealOncePanel({
  password,
  onDone,
}: {
  password: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      toast({ kind: 'success', message: t('admin.reveal.copied') });
    } catch {
      toast({ kind: 'error', message: t('admin.reveal.copyFailed') });
    }
  }

  return (
    <div data-testid="admin-reveal" className="flex flex-col items-center gap-3 text-center">
      <Seal size="dispatch" stamp />
      <h3 className="font-display text-lg text-ink">{t('admin.reveal.title')}</h3>
      <p className="font-body text-sm text-ink-2">{t('admin.reveal.intro')}</p>

      <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-paper ps-3 pe-2 py-2">
        <bdi dir="ltr" className="select-all break-all font-mono text-sm text-ink">
          {password}
        </bdi>
        <Button variant="secondary" onClick={copy} className="shrink-0">
          <Copy size={16} />
          {t('admin.reveal.copy')}
        </Button>
      </div>

      <p className="font-body text-xs text-ink-2">{t('admin.reveal.mustChange')}</p>

      <Button variant="primary" onClick={onDone} className="self-stretch">
        {t('admin.reveal.done')}
      </Button>
    </div>
  );
}
