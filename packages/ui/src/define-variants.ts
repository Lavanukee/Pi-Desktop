import { clsx } from 'clsx';

type VariantMap = Record<string, Record<string, string>>;

export interface VariantsConfig<V extends VariantMap> {
  /** Classes always applied. */
  base?: string;
  /** variant-name -> option-name -> classes. */
  variants: V;
  /** Option picked when the caller omits a variant. */
  defaultVariants?: { [K in keyof V]?: keyof V[K] & string };
}

export type VariantSelection<V extends VariantMap> = {
  [K in keyof V]?: (keyof V[K] & string) | undefined;
} & { className?: string | undefined };

/**
 * Minimal cva-style class composer (rebuilt locally per W1R conventions — no
 * external dep). Returns a function mapping a variant selection to a class
 * string; unknown/omitted variants fall back to `defaultVariants`.
 */
export function defineVariants<V extends VariantMap>(config: VariantsConfig<V>) {
  return (selection?: VariantSelection<V>): string => {
    const parts: Array<string | undefined> = [config.base];
    for (const name of Object.keys(config.variants) as Array<keyof V>) {
      const options = config.variants[name];
      const picked = selection?.[name] ?? config.defaultVariants?.[name];
      if (picked !== undefined && options !== undefined) {
        parts.push(options[picked]);
      }
    }
    parts.push(selection?.className);
    return clsx(parts);
  };
}

/** Extracts the props a `defineVariants` composer accepts. */
export type VariantProps<F> = F extends (selection?: infer P) => string
  ? Omit<NonNullable<P>, 'className'>
  : never;
