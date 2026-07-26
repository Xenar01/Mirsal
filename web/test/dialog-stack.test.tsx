import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n';
import Modal from '../src/components/Modal';
import Drawer from '../src/components/Drawer';

/*
 * Regression for the stacked-dialog Escape bug: J3 opens a ShareModal from a
 * Drawer action, so a Modal is mounted on top of an open Drawer. A single
 * Escape must dismiss ONLY the topmost dialog (the Modal), not both. Before the
 * shared dialog stack, each dialog's own document-level keydown listener fired
 * (stopPropagation does not stop sibling listeners), closing both at once.
 */
describe('stacked dialogs — Escape dismisses only the topmost', () => {
  test('a Modal opened over a Drawer: one Escape closes the Modal, not the Drawer', () => {
    const drawerClose = vi.fn();
    const modalClose = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <Drawer open onClose={drawerClose} title="تفاصيل">
          <p>سطح</p>
        </Drawer>
        <Modal open onClose={modalClose} title="مشاركة">
          <p>حوار</p>
        </Modal>
      </I18nextProvider>
    );
    // Both dialogs are mounted.
    expect(screen.getAllByRole('dialog')).toHaveLength(2);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(modalClose).toHaveBeenCalledTimes(1);
    expect(drawerClose).not.toHaveBeenCalled();
  });
});
