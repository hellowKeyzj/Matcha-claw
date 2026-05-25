import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  DEFAULT_LANCEDB_PACKAGE,
  INTEL_MAC_LANCEDB_COMPAT_PACKAGE,
  resolveLanceDbRuntimePackageName,
} = jiti("../src/store.ts");

describe("LanceDB runtime package selection", () => {
  it("uses the Intel Mac compatibility package on darwin x64", () => {
    assert.equal(resolveLanceDbRuntimePackageName("darwin", "x64"), INTEL_MAC_LANCEDB_COMPAT_PACKAGE);
  });

  it("uses the default LanceDB package on other platforms", () => {
    assert.equal(resolveLanceDbRuntimePackageName("darwin", "arm64"), DEFAULT_LANCEDB_PACKAGE);
    assert.equal(resolveLanceDbRuntimePackageName("linux", "x64"), DEFAULT_LANCEDB_PACKAGE);
    assert.equal(resolveLanceDbRuntimePackageName("win32", "x64"), DEFAULT_LANCEDB_PACKAGE);
  });
});
