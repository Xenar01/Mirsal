import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/auth-context';

/*
 * AppNav (§M4) — the app-level primary navigation, shared verbatim by the
 * dashboard rail (DashboardShell) and the admin control panel (AdminPanel) so
 * the two never drift.
 *
 * Responsive by layout, not by duplicated markup: below `md` the list is a
 * horizontal, scrollable pill STRIP (`flex` + `overflow-x-auto`, each pill
 * `shrink-0` + `whitespace-nowrap` so it scrolls rather than wrapping/compressing);
 * at `md` and up it becomes the vertical rail list (`md:flex-col`). Each pill is
 * ≥40px tall for a comfortable touch target and uses logical padding
 * (`ps-*`/`pe-*`) + `text-start` so it is RTL-correct.
 *
 * The admin control panel is admin-only, so its pill is appended only for an
 * admin — surfacing it in the strip is the one way a super-admin reaches it.
 */

const NAV_ITEMS: ReadonlyArray<{ to: string; end?: boolean; key: string }> = [
  { to: '/', end: true, key: 'dashboard.nav.myFiles' },
  { to: '/shared', key: 'dashboard.nav.shared' },
  { to: '/collections', key: 'dashboard.nav.collections' },
  { to: '/trash', key: 'dashboard.nav.trash' },
];

export default function AppNav() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const items =
    user?.role === 'admin'
      ? [...NAV_ITEMS, { to: '/admin', key: 'dashboard.nav.admin' }]
      : NAV_ITEMS;

  return (
    <nav aria-label={t('dashboard.nav.label')}>
      <ul className="flex gap-1 overflow-x-auto md:flex-col">
        {items.map((item) => (
          <li key={item.to} className="shrink-0">
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [
                  'flex min-h-10 items-center whitespace-nowrap rounded-lg ps-3 pe-3 py-2 font-body text-sm',
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
  );
}
