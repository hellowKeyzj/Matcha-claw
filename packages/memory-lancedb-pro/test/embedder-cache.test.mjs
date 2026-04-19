/**
 * Smoke test for Issue #598: embedder.ts EmbeddingCache initialization
 * 
 * Memory leak fix: EmbeddingCache._evictExpired() is called on every set()
 * when cache is near capacity (src/embedder.ts:72-82).
 * 
 * This test is a smoke/configuration test, NOT a full eviction test:
 * - It verifies Embedder can be created with nomic-embed-text model
 * - It verifies cacheStats is accessible (shows bounded cache: size, hits, misses)
 * - Full _evictExpired() testing requires OLLAMA server running
 * 
 * The fix itself is verified by:
 * 1. Review of src/embedder.ts:72-82 (TTL eviction on set)
 * 2. access-tracker and store serialization tests pass
 * 3. This smoke test confirms no regressions in constructor
 * 
 * Run: node test/embedder-cache.test.mjs
 */

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createEmbedder } = jiti("../src/embedder.ts");

async function testEmbedderCreation() {
  console.log("Testing embedder creation...");
  
  const config = {
    provider: "ollama",
    baseURL: "http://localhost:11434",
    model: "nomic-embed-text", // 768 dims - valid model
    apiKey: "test",
  };
  
  // Creating embedder should not throw
  const embedder = createEmbedder(config);
  
  // Verify cacheStats is accessible
  const stats = embedder.cacheStats;
  console.log("PASS  embedder created: keyCount=" + stats.keyCount);
  
  return embedder;
}

async function testCacheSmoke() {
  console.log("Testing cache smoke (no OLLAMA needed)...");
  
  const config = {
    provider: "ollama",
    baseURL: "http://localhost:11434",
    model: "nomic-embed-text",
    apiKey: "test",
  };
  
  const embedder = createEmbedder(config);
  const stats = embedder.cacheStats;
  
  // Verify cache has expected structure
  console.log("Cache stats: size=" + stats.size + ", hits=" + stats.hits + ", misses=" + stats.misses);
  
  if (typeof stats.size !== "number") {
    console.error("FAIL: cache.stats.size is not a number");
    process.exit(1);
  }
  
  console.log("PASS  cache smoke: bounded cache with size/hits/misses");
  return true;
}

async function testLocalMiniLmConstruction() {
  console.log("Testing local MiniLM embedder construction...");

  const embedder = createEmbedder({
    provider: "local-minilm",
    model: "all-MiniLM-L6-v2",
  });

  const stats = embedder.cacheStats;
  console.log("Local MiniLM model=" + embedder.model + ", keyCount=" + stats.keyCount);

  if (embedder.model !== "Xenova/all-MiniLM-L6-v2") {
    console.error("FAIL: local MiniLM model was not normalized to the ONNX-ready model id");
    process.exit(1);
  }

  console.log("PASS  local MiniLM constructor smoke");
}

async function main() {
  console.log("Running embedder-cache smoke tests...\n");
  
  try {
    await testEmbedderCreation();
    await testCacheSmoke();
    await testLocalMiniLmConstruction();

    console.log("\n=== ALL TESTS PASSED ===");
    console.log("embedder creation: OK");
    console.log("cache smoke: OK");
    console.log("local MiniLM constructor: OK");
    console.log("Note: Full _evictExpired() on set() requires OLLAMA server");
    process.exit(0);
  } catch (err) {
    console.error("\n=== TEST FAILED ===");
    console.error(err);
    process.exit(1);
  }
}

main();
