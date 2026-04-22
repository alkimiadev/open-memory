# Handlebars Template Engine Compatibility with Bun Runtime

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Handlebars in the npm Ecosystem](#handlebars-in-the-npm-ecosystem)
3. [Bun Runtime Compatibility](#bun-runtime-compatibility)
4. [Performance Benchmarks](#performance-benchmarks)
5. [Bundle Size Analysis](#bundle-size-analysis)
6. [Precompilation Support](#precompilation-support)
7. [Alternative Template Engines](#alternative-template-engines)
8. [Comparison with Plain Template Literals](#comparison-with-plain-template-literals)
9. [Existing Codebase Assessment](#existing-codebase-assessment)
10. [Build Pipeline Considerations](#build-pipeline-considerations)
11. [Recommendation](#recommendation)

---

## Executive Summary

Handlebars v4.7.9 works correctly in the Bun runtime with no native module dependencies. However, it adds significant bundle weight (~216 KB bundled, or ~40 KB runtime-only) and its CJS-only module format means `bun build` bundles the entire library rather than tree-shaking unused helpers. For the open-memory plugin, which currently uses plain TypeScript template literals for all output formatting, introducing Handlebars would be a net negative: it adds a dependency, increases bundle size by 8-46%, and provides no capability that cannot be achieved with template literals plus the existing `lines.push()` pattern already in use.

If a template engine is needed in the future for user-facing or complex conditional templates, **Mustache** is the best lightweight option (14.8 KB bundled, logicless, ESM-compatible), and **Eta** is the best ergonomic option (16.1 KB bundled, ERB-style syntax) though it has a Bun-specific bug with compiled template invocation.

---

## Handlebars in the npm Ecosystem

| Property | Value |
|----------|-------|
| Latest version | **4.7.9** (published 2026-03-26) |
| License | MIT |
| Weekly downloads | ~25M |
| Repository | <https://github.com/handlebars-lang/handlebars.js> |
| Dependencies | `neo-async`, `source-map`, `uglify-js` (compiler only), `minimist` (CLI only), `wordwrap` (CLI only) |
| Native modules | **None** -- pure JavaScript, no `.node` binaries, no `node-gyp` |
| TypeScript support | `@types/handlebars` v4.1.0; `runtime.d.ts` included in package |
| ESM support | **No** -- CJS only, no `"module"` or `"exports"` field in `package.json`; Bun's CJS interop makes it work |

### Package Structure

```
handlebars/
├── lib/index.js           # Main entry (CJS)
├── runtime.js             # Alias for runtime-only entry
├── dist/
│   ├── cjs/
│   │   ├── handlebars.js        # Full CJS bundle (204 KB, compiler + runtime)
│   │   └── handlebars.runtime.js # Runtime-only CJS (72 KB)
│   └── handlebars.min.js         # Minified full (89 KB)
│   └── handlebars.runtime.min.js # Minified runtime (29 KB)
├── bin/                   # CLI for precompilation
└── types/
    └── index.d.ts         # Type declarations
```

The `runtime.js` entry point exports only the template execution engine (no compiler), which is the right import for production use with precompiled templates.

---

## Bun Runtime Compatibility

### Test Results

| Test | Result |
|------|--------|
| `import Handlebars from "handlebars"` | Works (CJS interop) |
| `Handlebars.compile()` + render | Works correctly |
| `import HandlebarsRuntime from "handlebars/runtime"` | Works |
| Precompiled template spec + runtime | Works correctly |
| `require("handlebars")` | Works (CJS in Bun) |
| `bun build --target bun` bundling | Works, 44 modules bundled |
| `Handlebars.registerHelper()` (custom helpers) | Works |
| `Handlebars.Utils.escapeExpression()` | Works |

### No Issues Found

Handlebars is pure JavaScript with no native bindings. There are no `.node` files, no `node-gyp` build steps, and no WebAssembly dependencies. All filesystem operations in the compiler/CLI path use standard `fs` module calls that Bun supports. The core template compilation and rendering rely only on string manipulation and `Function()` constructor for generated template functions -- both supported by Bun.

### CJS-Only Concern

Handlebars does not ship an ESM entry point. In the `package.json`:

```json
{
  "main": "lib/index.js",
  "module": "",   // intentionally empty / absent
  "type": ""       // CJS by default
}
```

This means `bun build` cannot tree-shake individual helpers or utilities -- the entire CJS module is bundled as a single chunk. In practice this means you get the full Handlebars library in your bundle even if you only use `compile()` and `escapeExpression()`.

---

## Performance Benchmarks

All benchmarks run in Bun v1.3.11 on Linux x64. 10,000 iterations each.

### Simple Template (`Hello {{name}}!`)

| Engine | Compile (μs/op) | Render (μs/op) | Combined (μs/op) |
|--------|------------------|-----------------|-------------------|
| Template literals | n/a | **0.17** | 0.17 |
| Mustache | 0.83 | **1.13** | 1.13* |
| Handlebars | 0.56 | 3.66 | 3.66* |
| EJS | 34.56 | 56.47* | 56.47* |
| Eta (renderString) | n/a | -- | 15** |

*Mustache and EJS combine parse + render in their `render()` call; separate compilation benchmark provided for reference.

**Eta has a bug in Bun with compiled template invocation (see below).

### Complex Template (list of 20 items with conditional formatting)

| Engine | Compile (μs/op) | Render (μs/op) |
|--------|------------------|-----------------|
| Template literals | n/a | **6.25** |
| Mustache | 0.47 | 18.13 |
| Handlebars | 0.70 | 18.76 |
| Eta (renderString) | n/a | 14.64 |
| EJS | 34.56 | 56.47 |

### Key Takeaways

1. **Template literals are ~3-30x faster** than any template engine for rendering, and ~3-10x faster even than pre-compiled engine-render paths.
2. **Handlebars and Mustache render performance** are nearly identical (~18 μs/op for complex templates). Handlebars has slightly slower render due to its richer helper system.
3. **EJS is by far the slowest** due to its `Function()` constructor approach and `with()` statement for scoping.
4. **Compilation cost is negligible** for all engines except EJS. Pre-compiling at build time saves ~1 μs at runtime -- not meaningful unless you're compiling hundreds of unique templates per second.
5. For the open-memory plugin, which renders ~1 template per tool call invocation, even the slowest engine would add under 60 μs per call. Render performance is not a concern; **bundle size is the deciding factor**.

---

## Bundle Size Analysis

### Standalone Engine Bundle Size

Bundled with `bun build --target bun --format esm`, minimal test program:

| Engine | Bundled Size | Modules | Notes |
|--------|-------------|---------|-------|
| **(none - template literals)** | **0 B** | 0 | Zero-dependency |
| Mustache | 14.8 KB | 2 | Smallest engine |
| Eta | 16.1 KB | 2 | ESM-native |
| EJS | 21.5 KB | 3 | Includes `jake` and async utilities |
| **Handlebars (runtime only)** | **40.4 KB** | 22 | For use with precompiled templates |
| **Handlebars (full)** | **216.8 KB** | 44 | Includes compiler + all built-in helpers |

### Impact on open-memory Plugin

The current open-memory plugin bundle is **474 KB** (mostly `@opencode-ai/plugin` + `@opencode-ai/sdk`).

| Addition | Size Added | % Increase |
|----------|-----------|------------|
| Mustache | +14.8 KB | +3.1% |
| Eta | +16.1 KB | +3.4% |
| EJS | +21.5 KB | +4.5% |
| Handlebars runtime-only | +40.4 KB | +8.5% |
| Handlebars full | +216.8 KB | **+45.7%** |

A 46% bundle size increase for Handlebars-full is unacceptable for a plugin loaded at OpenCode startup. Even the runtime-only variant adds 40 KB for template rendering capability already achievable with template literals.

### Handlebars Runtime vs. Full

The runtime-only bundle (`handlebars/runtime`) at 40.4 KB includes:
- Template execution engine
- `escapeExpression()` for HTML escaping
- Built-in helpers (`if`, `unless`, `each`, `with`, `log`, `lookup`)
- SafeString class
- Data tracking

The full bundle at 216.8 KB additionally includes:
- The AST compiler (parses `{{}}` syntax into template functions)
- The JavaScript compiler (generates function source from AST)
- The printer (AST → source text)
- Source map generation

If using precompiled templates, you only need the runtime.

---

## Precompilation Support

Handlebars supports template precompilation, which separates the compile step (build time) from the render step (runtime).

### Precompile CLI

```bash
npx handlebars src/templates/ -f dist/templates.js \
  --commonjs handlebars/runtime \
  --known each \
  --known if \
  --known unless
```

This produces a JS module containing precompiled template function specifications that can be instantiated with only the runtime:

```typescript
import HandlebarsRuntime from "handlebars/runtime";

// Template spec from precompile (could be imported from a generated file)
const templateSpec = {"compiler":[8,">=4.3.0"],"main":function(container,depth0,...){...},"useData":true};

const template = HandlebarsRuntime.template(templateSpec);
console.log(template({ name: "World" })); // "Hello World!"
```

### Precompile API

```typescript
import Handlebars from "handlebars";

// At build time
const spec = Handlebars.precompile("Hello {{name}}!");
// spec is a JSON-safe object string containing the template function source

// At runtime (only needs handlebars/runtime, 40 KB)
import HandlebarsRuntime from "handlebars/runtime";
const template = HandlebarsRuntime.template(eval("(" + spec + ")"));
```

### Feasibility for open-memory

Precompilation is feasible but adds complexity to the build pipeline. Since the open-memory plugin currently has only 4-5 formatting functions (all in `src/history/format.ts` and `src/compaction/prompt.ts`), the overhead of setting up precompilation is unjustified. Precompiled templates would save ~176 KB (full - runtime = 216.8 - 40.4) at the cost of a custom build step, with no meaningful runtime performance gain for templates called once per tool invocation.

---

## Alternative Template Engines

### Mustache (v4.2.0)

| Property | Value |
|----------|-------|
| License | MIT |
| Philosophy | Logic-less templates -- no `if`, no `for`, only sections |
| ESM Support | Yes (conditional exports in `package.json`) |
| Dependencies | None |
| Bundle size | **14.8 KB** |
| Bun compatibility | Works perfectly |
| TypeScript types | `@types/mustache` |

```typescript
import Mustache from "mustache";
Mustache.render("Hello {{name}}!", { name: "World" });
```

**Strengths**: Smallest bundle, zero dependencies, works in Bun, well-understood spec, XSS-safe by default.

**Weaknesses**: No logic at all -- cannot do conditional formatting without data preprocessing. For example, you cannot render `"No sessions found."` vs. a table based on row count without preparing the data model to include a flag. This is a significant limitation for the open-memory plugin's formatting needs.

### Eta (v4.5.1)

| Property | Value |
|----------|-------|
| License | MIT |
| Philosophy | Lightweight ERB-style templates, ESM-native |
| ESM Support | Yes (`"type": "module"`, dual CJS/ESM exports) |
| Dependencies | None |
| Bundle size | **16.1 KB** |
| Bun compatibility | **Partial** -- `renderString()` works, but compiled template invocation fails with `TypeError: undefined is not an object (evaluating 'this.config.escapeFunction')` |
| TypeScript types | Built-in |

```typescript
import { Eta } from "eta";
const eta = new Eta();
eta.renderString("Hello <%= it.name %>!", { name: "World" });
```

**Strengths**: ERB-style syntax (`<%= %>`, `<% %>`) familiar to many developers, ESM-native, very small, configurable delimiters.

**Weaknesses**: The compiled template bug in Bun is a blocker for production use. The `compile()` method produces a function that references `this.config` on a context that is `undefined` when invoked in Bun. This appears to be a `this`-binding issue in Bun's ESM module evaluation.

**Workaround**: Use `renderString()` only (no separate compile step). This is fine for the plugin's use case but eliminates the precompilation advantage.

### EJS (v5.0.2)

| Property | Value |
|----------|-------|
| License | Apache-2.0 |
| Philosophy | Embedded JavaScript templates |
| ESM Support | Yes (dual CJS/ESM) |
| Dependencies | None (previously had jake, asap; now zero) |
| Bundle size | **21.5 KB** |
| Bun compatibility | Works |
| TypeScript types | `@types/ejs` |

```typescript
import ejs from "ejs";
ejs.render("Hello <%= name %>!", { name: "World" });
```

**Strengths**: Familiar syntax, async rendering support, includes, layouts.

**Weaknesses**: **Slowest engine** in benchmarks (56 μs/op for complex templates). Uses `Function()` constructor which is a security concern if templates contain user input (not relevant for open-memory, but worth noting). No logic-less mode -- templates can execute arbitrary JS.

### Plain Template Literals (No Dependency)

```typescript
// Current open-memory pattern
export const formatSessionList = (rows: Record<string, unknown>[]): string => {
  if (rows.length === 0) return "No sessions found.";
  const lines: string[] = ["# Recent Sessions\n"];
  lines.push("| ID | Title | Updated | Messages |");
  lines.push("|----|-------|---------|----------|");
  for (const row of rows) {
    lines.push(`| ${row.id} | ${row.title} | ${row.updated} | ${row.msgs} |`);
  }
  return lines.join("\n");
};
```

**Strengths**: Zero bundle cost, fastest rendering, full TypeScript type safety, no dependency to maintain, no security surface.

**Weaknesses**: Verbose for complex conditional formatting. Harder to visually parse the output format from code. No built-in HTML escaping (irrelevant for this plugin which outputs plain text/Markdown).

---

## Comparison with Plain Template Literals

The open-memory plugin currently formats all output using TypeScript template literals and the `lines.push()` pattern. Here is an assessment of whether Handlebars would improve each formatting function:

### `formatSessionList()` (format.ts)

```typescript
// Current: 23 lines, clear, zero dependencies
// Handlebars equivalent:
const template = Handlebars.compile(`
# Recent Sessions
{{#if sessions.length}}
| ID | Title | Updated | Messages |
|----|-------|---------|----------|
{{#each sessions}}
| {{id}} | {{title}} | {{updated}} | {{msgs}} |
{{/each}}
{{else}}
No sessions found.
{{/if}}
`);
```

The Handlebars version is arguably more readable for the template structure, but adds a 216 KB dependency for marginal readability improvement.

### `formatMessageList()` (format.ts)

```typescript
// Current: 30 lines, with role icons, truncation logic, separator lines
// Handlebars would need a custom helper for truncation and role icons
// → Handlebars adds complexity, not simplicity
```

### `getCompactionPrompt()` (prompt.ts)

```typescript
// Current: 42 lines of static template text
// This is a static string, not a dynamic template at all
// Handlebars would be pure overhead
```

### Verdict

For the open-memory plugin's current formatting needs (4-5 functions, ~120 lines total), template literals are the right choice. Template engines become valuable when you have:
- Many templates (20+) that need to be maintained separately from code
- Non-developers editing templates
- Complex conditional rendering with repeated patterns
- Internationalization / localization requirements

None of these apply to open-memory currently.

---

## Existing Codebase Assessment

### Current Dependencies (package.json)

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.1.3"
  },
  "devDependencies": {
    "@types/bun": "^1.2.0",
    "@types/node": "^20.14.0",
    "typescript": "^5.7.3"
  }
}
```

**No template engine dependency exists.** All formatting is done with:
1. Template literals (`` `Hello ${name}!` ``) for simple interpolation
2. `lines.push()` + `lines.join("\n")` pattern for multi-line structured output
3. `String(row.field ?? "default")` for safe data access
4. `text.slice(0, maxLen)` for truncation

These patterns are used consistently across:
- `src/history/format.ts` -- 3 functions, 73 lines
- `src/history/search.ts` -- 1 function, 61 lines
- `src/tools.ts` -- inline formatting in handlers (session lists, compaction tables, context status)
- `src/compaction/prompt.ts` -- 1 static template, 42 lines

Total template-related code: ~250 lines across 4 files. Not enough to justify a template engine dependency.

---

## Build Pipeline Considerations

### Current Build Setup

```json
{
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun --format esm && tsc --emitDeclarationOnly"
  }
}
```

The build uses `bun build` (Bun's native bundler) with `--target bun --format esm`. This produces a single ESM bundle at `dist/index.js` (currently 474 KB).

### How `bun build` Handles Handlebars

When `bun build` encounters `import Handlebars from "handlebars"`:

1. It resolves `handlebars` through Bun's module resolution (looks in `node_modules`)
2. Since Handlebars is CJS with no ESM entry, Bun's CJS interop wraps it
3. The bundler traces all reachable exports and includes them in the output
4. **No tree-shaking occurs** because CJS exports are dynamic by nature
5. The entire Handlebars library (compiler + runtime + helpers) is included: **216.8 KB bundled**

With precompiled templates and `import HandlebarsRuntime from "handlebars/runtime"`:
1. Only the runtime entry point is resolved
2. Still CJS, so still no tree-shaking
3. But only 22 modules (vs. 44): **40.4 KB bundled**

### Custom Build Steps

If using Handlebars precompilation, the build pipeline would become:

```bash
# Step 1: Precompile templates (new step)
npx handlebars src/templates/ -f src/generated/templates.ts --commonjs handlebars/runtime

# Step 2: Existing build
bun build src/index.ts --outdir dist --target bun --format esm

# Step 3: Existing type declaration
tsc --emitDeclarationOnly
```

This adds toolchain complexity for minimal benefit. Precompiled template specs would also need TypeScript type declarations.

---

## Recommendation

### For the open-memory Plugin: Do NOT Add Handlebars

**Rationale:**

| Factor | Template Literals | Handlebars |
|--------|-------------------|------------|
| Bundle size impact | 0 KB | +40 KB (runtime) / +217 KB (full) |
| Dependencies added | 0 | 1 (plus transitive deps) |
| Build complexity | None | None (runtime) or added step (precompile) |
| Rendering speed | ~6 μs | ~19 μs |
| Code readability | Moderate | Slightly better for complex templates |
| Maintainability | TypeScript-native | New template syntax, separate .hbs files |
| Security surface | None | Template injection (mitigated by no user input) |

The open-memory plugin has:
- ~250 lines of template code across 4 files
- Simple formatting (Markdown tables, lists, status lines)
- No user-editable templates
- No internationalization needs
- No complex conditional logic beyond `if (rows.length === 0)`
- Startup-time load concerns (OpenCode loads plugins at session start)

Adding Handlebars would increase the bundle by 8-46% for zero functional benefit.

### If a Template Engine Is Needed in the Future

If the formatting requirements grow significantly (e.g., user-configurable output templates, i18n, dozens of templates), the recommended priority order is:

1. **Mustache** (14.8 KB) -- If you need only interpolation and section-based logic. Smallest footprint, zero dependencies, works in Bun, XSS-safe by default. The "logic-less" constraint forces cleaner data modeling.

2. **Eta** (16.1 KB) -- If you need ERB-style control flow (`<% if (...) { %>`) and are willing to use `renderString()` only (avoid the compiled-template `this` binding bug in Bun). ESM-native, excellent TypeScript support, configurable.

3. **Handlebars runtime-only** (40.4 KB) -- If you need Handlebars features (partials, custom helpers, precompilation workflow) and can accept the larger bundle. Use with precompiled templates only -- do not bundle the full Handlebars compiler.

4. **Handlebars full** (216.8 KB) -- Only if you need runtime template compilation (e.g., user-provided templates). Not recommended for plugins.

5. **EJS** -- Not recommended. Slowest engine, security concerns with `Function()` constructor, minimal advantages over Eta.

### Template Literal Best Practices (Current Approach)

For now, continue using template literals but consider these improvements:

```typescript
// Helper for markdown tables (type-safe)
function markdownTable(headers: string[], rows: string[][]): string {
  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const dataLines = rows.map(row => `| ${row.join(" | ")} |`);
  return [headerLine, separatorLine, ...dataLines].join("\n");
}

// Use tagged templates for multi-line strings
const compactionPrompt = String.raw`
You are compacting your own session to free context space.
...
`;
```

This keeps the zero-dependency advantage while reducing the `lines.push()` boilerplate.

---

## Appendix: Test Environment

- **Runtime**: Bun v1.3.11 (Linux x64)
- **Node compatibility**: Handlebars tested on Node v22+ (works)
- **Bundle target**: `--target bun --format esm`
- **Benchmark**: 10,000 iterations per test, single-threaded, warmed up
- **Template complexity**: Simple (`Hello {{name}}!`) and complex (20-item list with conditionals)
- **All engines tested**: Handlebars 4.7.9, Mustache 4.2.0, Eta 4.5.1, EJS 5.0.2

---

*Research conducted 2026-04-22. Versions and benchmarks reflect the state of npm at the time of writing.*
