import { type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/auth-context';
import Button from '../../components/Button';
import StorageMeter from './StorageMeter';

/*
 * Dashboard chrome shared by the register (DriveView) and Trash (TrashView).
 *
 * Layout is logical-properties only (§4.3): the nav rail is the FIRST child of
 * the flex row so it lands on the inline-start edge (visually right in RTL),
 * opposite where a details drawer (J3) would open. `border-inline-end` on the
 * rail, `text-align:start`, `inset`-free. The storage meter lives at the foot
 * of the rail (§4.8). The top bar keeps the Kufic brand mark and a logout
 * control.
 */

const NAV_ITEMS: ReadonlyArray<{ to: string; end?: boolean; key: string }> = [
  { to: '/', end: true, key: 'dashboard.nav.myFiles' },
  { to: '/shared', key: 'dashboard.nav.shared' },
  { to: '/trash', key: 'dashboard.nav.trash' },
];

export default function DashboardShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function onLogout() {
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  }

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <header className="flex items-center justify-between gap-4 border-b border-line bg-surface ps-4 pe-4 py-3">
        <span className="font-display text-lg text-ink">{t('brand.name')}</span>
        <div className="flex items-center gap-3">
          {user && <span className="font-body text-sm text-ink-2">{user.username}</span>}
          <Button variant="ghost" onClick={onLogout}>
            {t('account.logout')}
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-4 p-4 md:flex-row">
        <aside className="flex shrink-0 flex-col gap-4 md:w-60 md:border-e md:border-line md:pe-4">
          <nav aria-label={t('dashboard.nav.label')}>
            <ul className="flex flex-col gap-1">
              {NAV_ITEMS.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      [
                        'block rounded-lg ps-3 pe-3 py-2 font-body text-sm',
                        isActive ? 'bg-paper text-teal' : 'text-ink hover:bg-paper',
                      ].join(' ')
                    }
                  >
                    {t(item.key)}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <StorageMeter />
        </aside>

        <main className="min-w-0 grow">{children}</main>
      </div>
    </div>
  );
}
