import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n';
import Modal from '../src/components/Modal';

function renderModal(props: Partial<Parameters<typeof Modal>[0]> = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <Modal open onClose={onClose} title="عنوان الحوار" {...props}>
        <p>محتوى</p>
      </Modal>
    </I18nextProvider>
  );
  return { onClose };
}

describe('Modal', () => {
  test('is an accessible dialog labelled by its title', () => {
    renderModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // labelled by the title text
    expect(dialog).toHaveAccessibleName('عنوان الحوار');
  });

  test('Esc triggers onClose', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('clicking the scrim triggers onClose', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByTestId('modal-scrim'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('renders nothing when closed', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <Modal open={false} onClose={vi.fn()} title="عنوان">
          <p>محتوى</p>
        </Modal>
      </I18nextProvider>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
