import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import type { ReactNode } from 'react';
import i18n from '../src/i18n';
import Drawer from '../src/components/Drawer';

function renderDrawer(
  props: Partial<Parameters<typeof Drawer>[0]> = {},
  children: ReactNode = <p>محتوى</p>
) {
  const onClose = props.onClose ?? vi.fn();
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <Drawer open onClose={onClose} title="تفاصيل" {...props}>
        {children}
      </Drawer>
    </I18nextProvider>
  );
  return { onClose, ...utils };
}

describe('Drawer', () => {
  test('is an accessible dialog labelled by its title', () => {
    renderDrawer();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('تفاصيل');
  });

  test('Esc triggers onClose', () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('clicking the scrim triggers onClose', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByTestId('drawer-scrim'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('renders nothing when closed', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <Drawer open={false} onClose={vi.fn()} title="تفاصيل">
          <p>محتوى</p>
        </Drawer>
      </I18nextProvider>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('moves focus into the panel on open and traps Tab within it', () => {
    renderDrawer(
      {},
      <>
        <button>الأول</button>
        <button>الأخير</button>
      </>
    );
    const close = screen.getByRole('button', { name: i18n.t('common.close') });
    // The close control is the first focusable, so focus lands there on open.
    expect(document.activeElement).toBe(close);

    const last = screen.getByRole('button', { name: 'الأخير' });
    last.focus();
    // Tab from the last focusable wraps to the first (trapped inside the panel).
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    // Shift+Tab from the first wraps back to the last.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  test('returns focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const onClose = vi.fn();
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <Drawer open onClose={onClose} title="تفاصيل">
          <p>محتوى</p>
        </Drawer>
      </I18nextProvider>
    );
    // Focus moved into the drawer.
    expect(document.activeElement).not.toBe(opener);

    rerender(
      <I18nextProvider i18n={i18n}>
        <Drawer open={false} onClose={onClose} title="تفاصيل">
          <p>محتوى</p>
        </Drawer>
      </I18nextProvider>
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
