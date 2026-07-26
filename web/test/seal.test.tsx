import { describe, test, expect, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n';
import Seal from '../src/components/Seal';

/** Builds a matchMedia stub whose `matches` answers the reduced-motion query. */
function matchMediaStub(reduced: boolean) {
  return (query: string) =>
    ({
      matches: query.includes('prefers-reduced-motion') ? reduced : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

function renderSeal(props: Parameters<typeof Seal>[0]) {
  return render(
    <I18nextProvider i18n={i18n}>
      <Seal {...props} />
    </I18nextProvider>
  );
}

describe('Seal', () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  test('is an accessible image labelled from i18n', () => {
    const { getByRole } = renderSeal({});
    const seal = getByRole('img');
    expect(seal).toHaveAttribute('aria-label', i18n.t('seal.label'));
    expect(seal).toHaveTextContent('م');
  });

  test('stamp attaches the stamp animation class when motion is allowed', () => {
    window.matchMedia = matchMediaStub(false) as typeof window.matchMedia;
    const { getByRole } = renderSeal({ stamp: true });
    expect(getByRole('img').className).toMatch(/mirsal-seal--stamp/);
  });

  test('stamp attaches NO animation class when reduced motion is requested', () => {
    window.matchMedia = matchMediaStub(true) as typeof window.matchMedia;
    const { getByRole } = renderSeal({ stamp: true });
    expect(getByRole('img').className).not.toMatch(/mirsal-seal--stamp/);
  });
});
