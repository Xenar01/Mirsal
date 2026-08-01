import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Button from '../../components/Button';
import { useAuth } from '../auth/auth-context';
import UsersTable from './UsersTable';
import SharesTable from './SharesTable';
import AuditLog from './AuditLog';

/*
 * AdminPanel (§3.1) — the admin control panel, replacing the route placeholder.
 *
 * Ink & Brass "dispatch register" governance surface: a top bar with the Kufic
 * brand mark, a link back to the admin's own files, and logout; a Kufic page
 * title; and three register tabs — Users, Shares, Audit. Owner/operator-facing
 * ⇒ Arabic only (§ brief). METADATA ONLY: no content/download path anywhere.
 * The non-admin gate is preserved (was on AdminPlaceholder). Layout is logical-
 * properties only (§4.3); light + dark via the token cascade.
 */

type Tab = 'users' | 'shares' | 'audit';

const TABS: ReadonlyArray<{ id: Tab; key: string }> = [
  { id: 'users', key: 'admin.tabs.users' },
  { id: 'shares', key: 'admin.tabs.shares' },
  { id: 'audit', key: 'admin.tabs.audit' },
];

export default function AdminPanel() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('users');
  const tablistId = useId();

  if (user?.role !== 'admin') {
    return (
      <main className="min-h-dvh bg-paper text-ink">
        <p role="alert" className="p-4 font-body text-sm">
          {t('admin.adminsOnly')}
        </p>
      </main>
    );
  }

  async function onLogout() {
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  }

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface ps-4 pe-4 py-3">
        <span className="font-display text-lg text-ink">{t('brand.name')}</span>
        <div className="flex items-center gap-3">
          <Link to="/" className="font-body text-sm text-teal">
            {t('admin.backToFiles')}
          </Link>
          {user && (
            <span className="min-w-0 max-w-[45vw] truncate font-body text-sm text-ink-2">
              {user.username}
            </span>
          )}
          <Button variant="ghost" onClick={onLogout}>
            {t('account.logout')}
          </Button>
        </div>
      </header>

      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-lg text-ink">{t('admin.title')}</h1>
          <p className="font-body text-sm text-ink-2">{t('admin.subtitle')}</p>
        </div>

        <div role="tablist" aria-label={t('admin.title')} id={tablistId} className="flex gap-2 border-b border-line">
          {TABS.map((item) => {
            const selected = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${tablistId}-${item.id}`}
                onClick={() => setTab(item.id)}
                className={[
                  'ps-3 pe-3 py-2 font-body text-sm',
                  // Selected tab: a decorative brass underline (legal fill use,
                  // §4.1) + ink label; unselected: ink-2. Brass is never the
                  // text foreground.
                  selected
                    ? 'border-b-2 border-brass font-medium text-ink'
                    : 'border-b-2 border-transparent text-ink-2',
                ].join(' ')}
              >
                {t(item.key)}
              </button>
            );
          })}
        </div>

        <div role="tabpanel" id={`${tablistId}-${tab}`}>
          {tab === 'users' && <UsersTable />}
          {tab === 'shares' && <SharesTable />}
          {tab === 'audit' && <AuditLog />}
        </div>
      </div>
    </div>
  );
}
