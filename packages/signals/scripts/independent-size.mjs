// Measure grouping's marginal cost with and without stores/optimistic state.
// Run after build:js; --source also supports quick implementation experiments.
// Uses the same Rollup + esbuild pipeline as tests/treeshake.test.ts.
import { build, transformWithEsbuild } from "vite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv.includes("--source");
const dir = mkdtempSync(join(tmpdir(), "solid-independent-size-"));
const core = "createSignal, createMemo, createEffect, createRoot, flush";
const rows = [];
try {
  for (const [profile, extra] of [
    ["core", ""],
    ["store", ", createStore"],
    ["optimistic", ", createOptimistic"]
  ]) {
    for (const grouped of [false, true]) {
      const entry = join(dir, "entry.ts");
      writeFileSync(
        entry,
        `export { ${core}${extra}${grouped ? ", independent" : ""} } from "signals";`
      );
      const result = await build({
        configFile: false,
        logLevel: "silent",
        define: { __DEV__: "false", __OBSERVE__: "false", __TEST__: "false" },
        resolve: { alias: { signals: join(root, source ? "src/index.ts" : "dist/prod/index.js") } },
        build: { write: false, minify: false, target: "esnext", lib: { entry, formats: ["es"] } }
      });
      const { code } = await transformWithEsbuild(result[0].output[0].code, "out.js", {
        minify: true,
        ...(source && { mangleProps: /^_/, reserveProps: /^_(name|loc|parent)$/ })
      });
      const row = {
        profile,
        grouped,
        min: Buffer.byteLength(code),
        gzip: gzipSync(code, { level: 9 }).length,
        brotli: brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
          .length
      };
      rows.push(row);
    }
  }
  const costs = rows
    .filter(row => row.grouped)
    .map(row => {
      const plain = rows.find(candidate => candidate.profile === row.profile && !candidate.grouped);
      return {
        profile: row.profile,
        min: row.min - plain.min,
        gzip: row.gzip - plain.gzip,
        brotli: row.brotli - plain.brotli
      };
    });
  console.log(JSON.stringify({ source, rows, costs }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
