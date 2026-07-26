import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n';
import StatusChip, { type ShareStatus } from '../src/components/StatusChip';

const STATUSES: ShareStatus[] = ['active', 'stopped', 'expired', 'shared'];

describe('StatusChip — status is never color-only (§4.4/§3.3)', () => {
  test.each(STATUSES)(
    '%s pairs its i18n label with a distinguishing icon/seal (not color alone)',
    (status) => {
      const { container } = render(
        <I18nextProvider i18n={i18n}>
          <StatusChip status={status} />
        </I18nextProvider>
      );

      // 1. The authored text label is present (so it reads without colour).
      const label = i18n.t(`status.${status}`);
      expect(screen.getByText(label)).toBeInTheDocument();

      // 2. A distinguishing graphic is present too: either a line-icon <svg>
      //    (active/stopped/expired) or the seal (role="img"), for `shared`.
      const graphic = container.querySelector('svg, [role="img"]');
      expect(graphic).not.toBeNull();
    }
  );

  test('the `shared` chip uses the brass Seal as its graphic, not brass text', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StatusChip status="shared" />
      </I18nextProvider>
    );
    // The seal exposes role="img" with the seal aria-label.
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', i18n.t('seal.label'));
  });
});
