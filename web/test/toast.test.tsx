import { describe, test, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n';
import { ToastProvider, useToast } from '../src/components/Toast';

function Trigger({ kind, message }: { kind: 'info' | 'success' | 'error'; message: string }) {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast({ kind, message })}>
      go
    </button>
  );
}

function renderWithToasts(ui: React.ReactNode) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ToastProvider>{ui}</ToastProvider>
    </I18nextProvider>
  );
}

describe('Toast', () => {
  test('an error toast renders its message inside an aria-live region', () => {
    renderWithToasts(<Trigger kind="error" message="تعذّر رفع الملف." />);

    fireEvent.click(screen.getByText('go'));

    const message = screen.getByText('تعذّر رفع الملف.');
    expect(message).toBeInTheDocument();
    // it lives inside a container that announces via aria-live
    expect(message.closest('[aria-live]')).not.toBeNull();
  });

  test('a toast can be dismissed', () => {
    renderWithToasts(<Trigger kind="success" message="تم الحفظ." />);
    fireEvent.click(screen.getByText('go'));
    expect(screen.getByText('تم الحفظ.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.close') }));
    expect(screen.queryByText('تم الحفظ.')).toBeNull();
  });
});
