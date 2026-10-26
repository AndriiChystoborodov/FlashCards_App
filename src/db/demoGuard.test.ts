import { describe, expect, it } from 'vitest';
import { assertDemoDatabase } from './reset.js';

describe('assertDemoDatabase', () => {
  it('accepts only retain_dev on localhost without parameters', () => {
    expect(() => assertDemoDatabase('postgres://retain:retain@localhost:5433/retain_dev')).not.toThrow();
    expect(() => assertDemoDatabase('postgres://retain:retain@127.0.0.1:5433/retain_dev')).not.toThrow();
  });

  it.each([
    'postgres://u:p@localhost:5433/retain_test',
    'postgres://u:p@localhost:5433/retain_reset_test',
    'postgres://u:p@localhost:5433/retain_dev2',
    'postgres://u:p@db.example.com:5432/retain_dev',
    'postgres://u:p@localhost:5433/retain_dev?host=db.example.com',
    'postgres://u:p@localhost:5433/',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertDemoDatabase(url)).toThrow(/Refusing/);
  });
});
