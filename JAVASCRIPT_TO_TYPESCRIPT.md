Why This Migration Is Possible Without Rewriting Everything
The project already has JSDoc comments everywhere — things like:

/**
 * @param {string} url
 * @returns {Promise<void>}
 */

TypeScript can understand these, and we're converting them to actual TypeScript syntax. So we're not starting from scratch — we're formalising types that are already documented.

Phase 0 — Setting Up the Toolchain
Before touching a single source file, we need to make the tools understand TypeScript. There are five areas to address:

1. npm install @babel/preset-typescript @typescript-eslint/parser @typescript-eslint/eslint-plugin
Note: TypeScript itself (typescript@^5.9.3) is already in package.json devDependencies — no need to install it again.

@babel/preset-typescript: The project uses Babel to transform JavaScript before running it in the browser. Babel doesn't know what TypeScript is by default — this package teaches Babel to strip TypeScript type annotations out of the code (Babel doesn't check types, it just removes them so the browser can run plain JS).

@typescript-eslint/parser and @typescript-eslint/eslint-plugin: The project uses ESLint to enforce code style. ESLint also doesn't understand TypeScript syntax by default. These two packages let ESLint read and lint .ts files properly.

2. Update tsconfig.json
This file already exists and already has strict: true and allowJs: true set. We need to make four changes to it:

a) Change moduleResolution to "bundler" — This is the single most important change in the whole migration.

Currently, all import statements in the code look like this:

import { something } from "./util.js"

The .js extension is explicit. If we just rename util.js to util.ts, TypeScript under the old setting would complain: "I'm looking for util.js and I can't find it!"

By switching to "bundler" mode (a TypeScript 5.0 feature), TypeScript is told: "When you see a .js import, also check if there's a .ts file with the same name." So import from "./util.js" automatically resolves to util.ts once it exists. This means we never have to change a single import statement across the whole codebase — the tooling handles it.

Note: moduleResolution: "bundler" requires the module option to be one of: "preserve", "es2022", "esnext", "es2020", or "es2015". Add "module": "preserve" (the most permissive option) alongside it.

b) Add isolatedModules: true — Babel compiles each file independently, with no cross-file type information. isolatedModules: true makes TypeScript enforce that every file is safe to compile this way, catching patterns that work with tsc but silently break under Babel (e.g., const enum, re-exporting a type without using export type).

c) Replace the files array with an include glob — The current tsconfig has:

"files": ["src/pdf.js", "web/pdf_viewer.component.js"]

This only type-checks two files. As we rename files to .ts, they won't be picked up unless we change this to an include pattern:

"include": ["src/**/*.{js,ts}", "web/**/*.{js,ts}"]

Note: allowJs: true (already set) allows .js files to be included here without errors.

d) Strict mode is already on — strict: true is already enabled in tsconfig.json. This means every .ts file we create must be fully typed from day one (no implicit any, strict null checks, etc.). We accept this cost per file as we convert — do not disable strict mode. If a file is too complex to type fully in one pass, add // @ts-nocheck at the top as a temporary escape hatch and file a follow-up to remove it.

3. Create src/types/globals.d.ts
Throughout the code there are checks like:

if (typeof PDFJSDev !== "undefined" && PDFJSDev.test("GENERIC")) { ... }

PDFJSDev is a special variable injected at build time by the Gulp preprocessor — it's not a real runtime variable. TypeScript doesn't know it exists and would error on every single line that references it. This file tells TypeScript: "Trust me, PDFJSDev is a thing — here's its shape."

4. Update gulpfile.mjs (the build system)
Gulp orchestrates the build, and this is also where the Babel configuration lives (there is no separate babel.config.js file — it's embedded in gulpfile.mjs). We update it to:

Add @babel/preset-typescript to the Babel presets list inside gulpfile.mjs
Tell Webpack (the bundler): "When you see a .ts file, run it through Babel with the TypeScript preset"
Update glob patterns like **/*.js to **/*.{js,ts} so new TypeScript files don't get ignored

5. Update eslint.config.mjs
We add a separate block of ESLint rules specifically for .ts files. Some JS rules clash with TypeScript (e.g., TypeScript handles undefined variables itself, so ESLint's no-undef rule would create false positives). We swap those out for TypeScript-aware equivalents.

Phase 1 — src/shared/ (Start Here)
This is the safest place to begin because:

Only 8 files
No dependencies on any other part of the project (they only import from each other)
Everything else depends on them — so getting these right first gives us clean types to build on
What we do for each file:
git mv foo.js foo.ts — rename the file. Git tracks the rename so history is preserved.
Convert JSDoc to TypeScript — e.g., instead of writing @param {string} url in a comment above the function, we write url: string directly in the function signature.
Run npx gulp generic — make sure the build still compiles
Run npx gulp unittest — make sure nothing broke
Tricky conversions in shared/:
Flag enums (the project has many constants used like enums):

// Before (JS)
const RenderingIntentFlag = { ANY: 0x01, DISPLAY: 0x02 };

// After (TS)
const RenderingIntentFlag = { ANY: 0x01, DISPLAY: 0x02 } as const;

The as const tells TypeScript to treat the values as exact literal types (the value 1, not just "some number"), which enables type-safe usage.

BaseException — This is a class defined using an unusual old JavaScript trick (an IIFE pattern). TypeScript dislikes it. We refactor it to a clean modern class:

class BaseException extends Error {
  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
}

Phases 2–4 — The Core Libraries
These three phases convert the three main source directories. The key insight is their dependency structure:

src/display/ (the rendering API) does not directly import from src/core/ (the PDF parser) — they communicate via Web Worker messages. So Phase 3 can begin in parallel with Phase 2.
src/scripting_api/ (the PDF JavaScript sandbox) only depends on src/shared/, so it can also run in parallel.
Phase 2 — src/core/ (the PDF parser, runs in a Web Worker)
This is the largest and most complex directory (~113 files). We work through it in layers, converting leaf files (no dependencies) first, then files that depend on them, and so on up to the top-level orchestrator files.

The most complex file, evaluator.js (~4,000 lines, handles PDF drawing operators), is converted last. For files that have circular dependencies (File A imports File B which imports File A), we use import type — TypeScript's way of saying "I only need this for type information, not at runtime", which breaks the circular reference.

Phase 3 — src/display/ (the rendering API, runs on the main thread)
Same layer-by-layer approach. The most important file here is api.js — it defines the entire public API (what developers use when embedding PDF.js). Its 30+ @typedef blocks become proper TypeScript interface declarations. These are tested by npx gulp typestest, which compiles type test files against the generated .d.ts output to verify nothing regressed.

Phase 4 — src/scripting_api/ (the PDF JavaScript sandbox)
Relatively isolated. One caution: this code runs inside a sandboxed eval context for security reasons, so we must not add anything that generates extra runtime code. The Babel TypeScript preset is safe here because it only strips types — it doesn't add runtime type metadata.

Phase 5 — web/ (the UI viewer)
This is the visible part — the toolbar, sidebar, thumbnails, etc. It's done last because it depends on the public API from src/display/api.js being fully typed first.

The web viewer's files are also converted layer-by-layer: utilities first, then components that use those utilities, then platform-specific files (Firefox/Chrome extensions), and finally the main entry point (app.js, viewer.js).

Verification After Each Phase
After every phase, we run five checks:

tsc --noEmit — TypeScript type-checks everything but doesn't emit any files. This catches type errors.
npx gulp generic — Webpack builds the full bundle. This catches build errors.
npx gulp unittest — Runs the Jasmine unit test suite. This catches regressions.
npx gulp typestest — Compiles the type test files against the generated .d.ts declarations. This catches public API regressions.
npx gulp lint — Runs ESLint (including the TypeScript-specific rules added in Phase 0). This catches style and type-aware lint regressions.
The goal is that after every single phase, all five of these pass — meaning the project stays in a working state throughout the entire migration.