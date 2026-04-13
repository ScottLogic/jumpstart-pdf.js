/**
 * Build-time variable injected by the Gulp preprocessor (external/builder/).
 * It does not exist at runtime — it is replaced by the build tool before the
 * code reaches the browser. TypeScript must be told it exists so that the
 * `typeof PDFJSDev !== "undefined"` guards and `PDFJSDev.test(...)` calls in
 * .ts files compile without errors.
 */
declare const PDFJSDev: {
  test(flags: string): boolean;
} | undefined;
