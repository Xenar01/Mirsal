import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Button from '../src/components/Button';

describe('Button', () => {
  test('primary uses the brass fill + brass-ink label (never white-on-brass, §4.1)', () => {
    render(<Button variant="primary">حفظ</Button>);
    const btn = screen.getByRole('button', { name: 'حفظ' });
    expect(btn).toHaveClass('bg-brass');
    expect(btn).toHaveClass('text-brass-ink');
    // must NOT paint the label white on the brass fill
    expect(btn.className).not.toMatch(/\btext-white\b/);
  });

  test('defaults to type="button" so it never submits a surrounding form by accident', () => {
    render(<Button>إلغاء</Button>);
    expect(screen.getByRole('button', { name: 'إلغاء' })).toHaveAttribute('type', 'button');
  });

  test('fires onClick when enabled and not when disabled', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>تم</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'تم' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} disabled>
        تم
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'تم' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1); // unchanged
  });
});
