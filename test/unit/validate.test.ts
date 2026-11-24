import { describe, expect, it } from 'vitest';
import { redact, ShopShiftError } from '../../src/core/errors.js';
import {
  normalizeStore,
  slugify,
  validateAlias,
  validateEnvironmentName,
  validateName,
  validatePort,
  validateThemeId,
} from '../../src/core/validate.js';

describe('normalizeStore', () => {
  it.each([
    ['tangelo-demo', 'tangelo-demo.myshopify.com'],
    ['  Tangelo-Demo  ', 'tangelo-demo.myshopify.com'],
    ['tangelo-demo.myshopify.com', 'tangelo-demo.myshopify.com'],
    ['https://tangelo-demo.myshopify.com/', 'tangelo-demo.myshopify.com'],
    ['https://tangelo-demo.myshopify.com/admin/themes', 'tangelo-demo.myshopify.com'],
    ['https://admin.shopify.com/store/tangelo-demo/themes', 'tangelo-demo.myshopify.com'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeStore(input)).toBe(expected);
  });

  it.each([
    '',
    'brand.com',
    'https://evil.example/tangelo.myshopify.com',
    'tangelo.myshopify.com.evil.example',
    'user:pass@tangelo.myshopify.com',
    'tangelo.myshopify.com:8080',
    '-tangelo',
    'a b',
    '$(whoami)',
    "x'; rm -rf ~",
    'https://tangelo.myshopify.com/?next=x',
    'https://tangelo.myshopify.com/collections',
  ])('rejects %j', (input) => {
    expect(() => normalizeStore(input)).toThrow(ShopShiftError);
  });
});

describe('slugify', () => {
  it.each([
    ['Tangelo', 'tangelo'],
    ['Client Store 01', 'client-store-01'],
    ['  Café Été ', 'cafe-ete'],
    ['A/B "test"', 'a-b-test'],
  ])('%s becomes %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('rejects a name with nothing to identify it', () => {
    expect(() => slugify('!!!')).toThrow(/letter or number/);
  });
});

describe('field validation', () => {
  it('rejects aliases that could be read as flags or break a terminal', () => {
    expect(validateAlias(' me@example.test ')).toBe('me@example.test');
    for (const bad of ['', '--json', 'a\u001b[31m', 'a\nb', 'x'.repeat(300)]) {
      expect(() => validateAlias(bad)).toThrow(ShopShiftError);
    }
  });

  it('accepts theme IDs with or without a leading hash', () => {
    expect(validateThemeId('#123456')).toBe('123456');
    for (const bad of ['', '0', 'Dawn', '12a', '-1', '1.5']) {
      expect(() => validateThemeId(bad)).toThrow(ShopShiftError);
    }
  });

  it('bounds ports', () => {
    expect(validatePort('9292')).toBe(9292);
    for (const bad of ['0', '65536', 'abc', '', '92.5', '-1']) {
      expect(() => validatePort(bad)).toThrow(ShopShiftError);
    }
  });

  it('bounds names and environment names', () => {
    expect(validateName(' Tangelo ')).toBe('Tangelo');
    expect(() => validateName('')).toThrow();
    expect(() => validateName('x'.repeat(61))).toThrow();
    expect(validateEnvironmentName('production')).toBe('production');
    expect(() => validateEnvironmentName('--force')).toThrow();
  });
});

describe('redact', () => {
  it('removes anything token-shaped', () => {
    const text = 'shptka_0123abcd shpat_9f8e Bearer abc.def-ghi atkn_1234 plain';
    const result = redact(text);
    for (const secret of ['0123abcd', '9f8e', 'abc.def-ghi', '1234'])
      expect(result).not.toContain(secret);
    expect(result).toContain('plain');
  });
});
