import test from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { resolveLanceDbRuntimePackageName } = jiti("../src/store.ts");

test("uses legacy LanceDB runtime on Intel Mac", () => {
  assert.equal(
    resolveLanceDbRuntimePackageName("darwin", "x64"),
    "@matchaclaw/lancedb-darwin-x64-compat",
  );
});

test("uses current LanceDB runtime on Apple Silicon Mac", () => {
  assert.equal(
    resolveLanceDbRuntimePackageName("darwin", "arm64"),
    "@lancedb/lancedb",
  );
});

test("uses current LanceDB runtime on non-mac platforms", () => {
  assert.equal(
    resolveLanceDbRuntimePackageName("win32", "x64"),
    "@lancedb/lancedb",
  );
  assert.equal(
    resolveLanceDbRuntimePackageName("linux", "x64"),
    "@lancedb/lancedb",
  );
});
