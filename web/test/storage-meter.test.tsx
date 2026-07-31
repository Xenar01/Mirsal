import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n';

// StorageMeter still shows a Trash sub-line derived from the trash listing.
vi.mock('../src/features/dashboard/queries', () => ({
  useTrash: () => ({ data: [] }),
  sumSizes: () => 0,
}));

let mockUser: unknown = null;
vi.mock('../src/features/auth/auth-context', () => ({
  useAuth: () => ({ user: mockUser }),
}));

import StorageMeter from '../src/features/dashboard/StorageMeter';

function renderMeter() {
  return render(
    <I18nextProvider i18n={i18n}>
      <StorageMeter />
    </I18nextProvider>
  );
}

afterEach(() => {
  mockUser = null;
});

describe('StorageMeter', () => {
  test('a user WITH a quota shows a progress bar (25%) and NOT the no-quota note', () => {
    mockUser = { id: 1, username: 'u', role: 'user', mustChangePassword: false, rootNodeId: 2, quotaBytes: 1000, usedBytes: 250 };
    renderMeter();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(screen.queryByText(i18n.t('storage.noQuota'))).not.toBeInTheDocument();
  });

  test('a user with NO quota shows the no-quota note and no progress bar', () => {
    mockUser = { id: 1, username: 'u', role: 'user', mustChangePassword: false, rootNodeId: 2, quotaBytes: null, usedBytes: 250 };
    renderMeter();
    expect(screen.getByText(i18n.t('storage.noQuota'))).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
