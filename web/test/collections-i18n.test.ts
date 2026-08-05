import { describe, test, expect } from 'vitest';
import ar from '../src/i18n/ar.json';
import en from '../src/i18n/en.json';

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe('collections i18n', () => {
  test('every collect.* key exists in BOTH ar and en (public page is bilingual)', () => {
    const arCollect = flatten(ar).filter((k) => k.startsWith('collect.'));
    const enCollect = flatten(en).filter((k) => k.startsWith('collect.'));
    expect(arCollect.length).toBeGreaterThan(0);
    expect(new Set(enCollect)).toEqual(new Set(arCollect));
  });

  test('owner collections.* keys are present (Arabic-only)', () => {
    const keys = flatten(ar);
    for (const k of [
      'dashboard.nav.collections',
      'collections.title',
      'collections.new',
      'collections.empty',
      'collections.create.title',
      'collections.create.departmentsLabel',
      'collections.create.submit',
      'collections.detail.responded',
      'collections.detail.missing',
      'collections.detail.delete',
    ]) {
      expect(keys, `missing ${k}`).toContain(k);
    }
  });
});
