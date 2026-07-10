import { describe, expect, it } from 'vitest';
import { defineVariants } from './define-variants.ts';

const button = defineVariants({
  base: 'pd-btn',
  variants: {
    variant: { primary: 'pd-btn--primary', ghost: 'pd-btn--ghost' },
    size: { sm: 'pd-btn--sm', md: 'pd-btn--md' },
  },
  defaultVariants: { variant: 'primary', size: 'md' },
});

describe('defineVariants', () => {
  it('applies base + defaults when nothing is selected', () => {
    expect(button()).toBe('pd-btn pd-btn--primary pd-btn--md');
  });

  it('applies explicit selections over defaults', () => {
    expect(button({ variant: 'ghost', size: 'sm' })).toBe('pd-btn pd-btn--ghost pd-btn--sm');
  });

  it('treats explicit undefined like an omission (exactOptionalPropertyTypes callers)', () => {
    expect(button({ variant: undefined })).toBe('pd-btn pd-btn--primary pd-btn--md');
  });

  it('appends the className passthrough last', () => {
    expect(button({ className: 'extra' })).toBe('pd-btn pd-btn--primary pd-btn--md extra');
  });

  it('supports variant groups without defaults', () => {
    const chip = defineVariants({ variants: { tone: { danger: 'is-danger' } } });
    expect(chip()).toBe('');
    expect(chip({ tone: 'danger' })).toBe('is-danger');
  });
});
