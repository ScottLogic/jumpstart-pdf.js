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
      eval(code: string): unknown;
    }
  | undefined;

// Map.getOrInsertComputed and WeakMap.getOrInsertComputed (TC39 proposal, stage 3).
interface Map<K, V> {
  getOrInsertComputed(key: K, compute: (key: K) => V): V;
}
interface WeakMap<K extends WeakKey, V> {
  getOrInsertComputed(key: K, compute: (key: K) => V): V;
}

// Minimal type stubs for @fluent/bundle and @fluent/dom (no bundled .d.ts).
declare module "fluent-bundle" {
  export class FluentResource {
    constructor(source: string);
  }
  export class FluentBundle {
    constructor(
      locales: string | string[],
      options?: { functions?: Record<string, () => string> }
    );
    addResource(resource: FluentResource): Error[];
  }
}
declare module "fluent-dom" {
  type FluentBundle = import("fluent-bundle").FluentBundle;
  type BundleGenerator = AsyncGenerator<FluentBundle | Promise<FluentBundle>>;
  export class DOMLocalization {
    constructor(resourceIds: string[], generateBundles: () => BundleGenerator);
    connectRoot(element: HTMLElement): void;
    disconnectRoot(element: HTMLElement): void;
    translateRoots(): Promise<void>;
    translateElements(elements: HTMLElement[]): Promise<void>;
    formatMessages(
      ids: Array<{ id: string; args?: Record<string, string> | null }>
    ): Promise<Array<{ value: string | null }>>;
    pauseObserving(): void;
    resumeObserving(): void;
  }
}

// Firefox-specific document.l10n extension.
interface Document {
  l10n?: unknown;
}

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

// RegExp.escape (TC39 proposal, stage 4).
interface RegExpConstructor {
  escape(string: string): string;
}

// Firefox GeckoView: `window.isGECKOVIEW` and `globalThis.pdfjsPreloadedWorker`
// are injected by the Firefox shell in specific build configurations.
interface Window {
  isGECKOVIEW?: boolean;
}
declare var pdfjsPreloadedWorker: Worker | null | undefined;

// Build-time raw import function replaced by the preprocessor (behaves like
// `import()` but bypasses Babel/Webpack transformation).
declare function __raw_import__(src: string): Promise<any>;

// PDF.js viewer component API namespace, assigned to `globalThis.pdfjsViewer`.
declare var pdfjsViewer: unknown;

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
