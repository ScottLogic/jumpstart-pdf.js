/**
 * Build-time variable injected by the Gulp preprocessor (external/builder/).
 * It does not exist at runtime — it is replaced by the build tool before the
 * code reaches the browser. TypeScript must be told it exists so that the
 * `typeof PDFJSDev !== "undefined"` guards and `PDFJSDev.test(...)` calls in
 * .ts files compile without errors.
 */
declare const PDFJSDev:
  | {
      test(flags: string): boolean;
    }
  | undefined;

// Polyfill for Math.sumPrecise (TC39 proposal). Only assigned when not
// natively available; declared optional so `typeof Math.sumPrecise` checks
// remain valid in TypeScript.
interface Math {
  sumPrecise?(numbers: Iterable<number>): number;
}

// Electron adds a `type` property to Node's `process` object.
declare namespace NodeJS {
  interface Process {
    type?: string;
  }
}

// Sanitizer API (used in FeatureTest.isSanitizerSupported).
declare const Sanitizer: unknown;

// Promise.withResolvers (ES2024) and Promise.try (TC39 proposal).
interface PromiseConstructor {
  withResolvers<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
  try<T>(
    fn: (...args: unknown[]) => T | PromiseLike<T>,
    ...args: unknown[]
  ): Promise<T>;
}
