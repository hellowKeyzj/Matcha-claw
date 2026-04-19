import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { env, pipeline } from "@huggingface/transformers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(__dirname);

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const MODELS_ROOT = join(pluginRoot, "models");
const MODEL_DIR = join(MODELS_ROOT, ...MODEL_ID.split("/"));
const DTYPE = "fp32";

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const checkOnly = args.has("--check");

function configureTransformers({ allowRemoteModels, localFilesOnly }) {
  env.allowLocalModels = true;
  env.allowRemoteModels = allowRemoteModels;
  env.localModelPath = MODELS_ROOT;
  env.cacheDir = MODELS_ROOT;

  const endpoint = process.env.HF_ENDPOINT?.trim();
  if (endpoint) {
    env.remoteHost = `${endpoint.replace(/\/+$/, "")}/`;
  }

  return {
    cache_dir: MODELS_ROOT,
    local_files_only: localFilesOnly,
    dtype: DTYPE,
  };
}

async function verifyLocalModel() {
  const extractor = await pipeline(
    "feature-extraction",
    MODEL_ID,
    configureTransformers({ allowRemoteModels: false, localFilesOnly: true }),
  );

  const output = await extractor("local minilm verification", {
    pooling: "mean",
    normalize: true,
  });

  const dimensions = Array.isArray(output?.dims) && output.dims.length > 0
    ? output.dims[output.dims.length - 1]
    : ArrayBuffer.isView(output?.data)
      ? output.data.length
      : 0;

  console.log(
    `[minilm] Local model ready at ${MODEL_DIR} (${dimensions || "unknown"} dims, dtype=${DTYPE})`,
  );
}

async function downloadModel() {
  console.log(`[minilm] Downloading ${MODEL_ID} into ${MODEL_DIR}`);

  await pipeline(
    "feature-extraction",
    MODEL_ID,
    {
      ...configureTransformers({ allowRemoteModels: true, localFilesOnly: false }),
      progress_callback: (info) => {
        if (info?.status === "progress" && info.file) {
          const percent = typeof info.progress === "number"
            ? `${info.progress.toFixed(1)}%`
            : "progress";
          console.log(`[minilm] ${percent} ${info.file}`);
        }
      },
    },
  );
}

async function main() {
  await mkdir(MODELS_ROOT, { recursive: true });

  if (force && existsSync(MODEL_DIR)) {
    console.log(`[minilm] Removing existing model dir: ${MODEL_DIR}`);
    await rm(MODEL_DIR, { recursive: true, force: true });
  }

  if (!checkOnly && !existsSync(MODEL_DIR)) {
    await downloadModel();
  } else if (checkOnly) {
    console.log(`[minilm] Checking local model at ${MODEL_DIR}`);
  } else {
    console.log(`[minilm] Reusing existing local model at ${MODEL_DIR}`);
  }

  await verifyLocalModel();
}

main().catch((error) => {
  console.error(`[minilm] Failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
