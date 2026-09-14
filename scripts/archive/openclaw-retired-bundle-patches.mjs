/*
 * Retired OpenClaw bundle patches archive.
 *
 * 只作历史参考：不要 import，不要执行，不要注册到 active patch registry。
 * 当前 OpenClaw 8.2 默认只允许 scripts/openclaw-bundle-patches.mjs 里的
 * strip-bundled-channel-plugins。
 *
 * 这些补丁曾经直接改 OpenClaw dist JS 运行逻辑，8.2 已改为由 Matcha 自己
 * 适配新版协议/鉴权链路，因此不能继续作为可执行 patch 保留。
 */

export {};

/*
const CUSTOM_PROVIDER_API_OWNER_HINT_NEEDLE = 'const normalizedProvider = normalizeProviderId(params.provider);\n\tif (!normalizedProvider) return;';
const CUSTOM_PROVIDER_API_OWNER_HINT_PATCHED_NEEDLE = 'const normalizedProvider = normalizeProviderId(params.provider);\n\tif (!normalizedProvider || normalizedProvider.startsWith("custom-")) return;';
const CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_NEEDLE = 'function shouldDeferSyntheticProfileAuth(params) {\n\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);';
const CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_PATCHED_NEEDLE = 'function shouldDeferSyntheticProfileAuth(params) {\n\tif (normalizeProviderId(params.provider).startsWith("custom-")) return false;\n\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);';
const WEB_LOGIN_START_SCHEMA_NEEDLE = `const WebLoginStartParamsSchema = Type.Object({
\tforce: Type.Optional(Type.Boolean()),
\ttimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
\tverbose: Type.Optional(Type.Boolean()),
\taccountId: Type.Optional(Type.String())
}, { additionalProperties: false });`;
const WEB_LOGIN_START_SCHEMA_PATCHED_NEEDLE = `const WebLoginStartParamsSchema = Type.Object({
\tchannel: Type.Optional(NonEmptyString),
\tforce: Type.Optional(Type.Boolean()),
\ttimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
\tverbose: Type.Optional(Type.Boolean()),
\taccountId: Type.Optional(Type.String())
}, { additionalProperties: false });`;
const WEB_LOGIN_WAIT_SCHEMA_NEEDLE = `const WebLoginWaitParamsSchema = Type.Object({
\ttimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
\taccountId: Type.Optional(Type.String()),
\tcurrentQrDataUrl: Type.Optional(QrDataUrlSchema)
}, { additionalProperties: false });`;
const WEB_LOGIN_WAIT_SCHEMA_PATCHED_NEEDLE = `const WebLoginWaitParamsSchema = Type.Object({
\tchannel: Type.Optional(NonEmptyString),
\ttimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
\taccountId: Type.Optional(Type.String()),
\tsessionKey: Type.Optional(NonEmptyString),
\tcurrentQrDataUrl: Type.Optional(QrDataUrlSchema)
}, { additionalProperties: false });`;
const WEB_LOGIN_PROVIDER_NEEDLE = 'const resolveWebLoginProvider = () => listChannelPlugins().find((plugin) => [...plugin.gatewayMethods ?? [], ...(plugin.gatewayMethodDescriptors ?? []).map((descriptor) => descriptor.name)].some((method) => WEB_LOGIN_METHODS.has(method))) ?? null;';
const WEB_LOGIN_PROVIDER_PATCHED_NEEDLE = `const resolveWebLoginProvider = (channelId) => {
\tconst requestedChannel = typeof channelId === "string" ? channelId.trim() : "";
\tif (requestedChannel) return getChannelPlugin(requestedChannel) ?? null;
\treturn listChannelPlugins().find((plugin) => [...plugin.gatewayMethods ?? [], ...(plugin.gatewayMethodDescriptors ?? []).map((descriptor) => descriptor.name)].some((method) => WEB_LOGIN_METHODS.has(method))) ?? null;
};`;
const WEB_LOGIN_PROVIDER_LOOKUP_NEEDLE = 'const provider = resolveWebLoginProvider();';
const WEB_LOGIN_PROVIDER_LOOKUP_PATCHED_NEEDLE = 'const provider = resolveWebLoginProvider(params.channel);';
const WEB_LOGIN_WAIT_CALL_NEEDLE = 'const result = await provider.gateway.loginWithQrWait({\n\t\t\t\ttimeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : void 0,\n\t\t\t\taccountId,\n\t\t\t\tcurrentQrDataUrl: typeof params.currentQrDataUrl === "string" ? params.currentQrDataUrl : void 0\n\t\t\t});';
const WEB_LOGIN_WAIT_CALL_PATCHED_NEEDLE = 'const result = await provider.gateway.loginWithQrWait({\n\t\t\t\ttimeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : void 0,\n\t\t\t\taccountId,\n\t\t\t\tsessionKey: typeof params.sessionKey === "string" ? params.sessionKey : void 0,\n\t\t\t\tcurrentQrDataUrl: typeof params.currentQrDataUrl === "string" ? params.currentQrDataUrl : void 0\n\t\t\t});';

function locateSingleJavaScriptFile(distDir, patchId, options) {
  return locateSingleFile(distDir, patchId, { ...options, extension: '.js' });
}

function locateSingleFile(distDir, patchId, options) {
  const { fileNamePrefix, markers, extension } = options;
  const candidates = listFilesByExtension(distDir, extension).filter((filePath) => (
    !fileNamePrefix || path.basename(filePath).startsWith(fileNamePrefix)
  ));
  const matches = candidates.filter((filePath) => {
    const source = readText(filePath);
    return markers.every((marker) => source.includes(marker));
  });
  if (matches.length !== 1) {
    throw new Error(`${patchId}: expected exactly one target in ${distDir}, found ${matches.length}${matches.length ? `: ${matches.map((item) => path.basename(item)).join(', ')}` : ''}`);
  }
  return matches[0];
}

function replaceOnce(source, needle, replacement, patchId) {
  const count = source.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`${patchId}: expected one needle match, found ${count}`);
  }
  return source.replace(needle, replacement);
}

function patchCustomProviderApiOwnerHint(openclawDir) {
  const patchId = 'custom-provider-skip-api-owner-hint';
  const distDir = path.join(openclawDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return { status: 'skipped', detail: 'dist not found' };
  }

  const target = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'providers.runtime-',
    markers: [
      'function resolveProviderConfigApiOwnerHint(params)',
      'const api = typeof providerConfig?.api === "string" ? normalizeProviderId(providerConfig.api) : "";',
      'return api;',
    ],
  });
  const before = readText(target);
  const alreadyPatched = before.includes(CUSTOM_PROVIDER_API_OWNER_HINT_PATCHED_NEEDLE);
  if (alreadyPatched) {
    return { status: 'clean', detail: path.relative(openclawDir, target) };
  }

  const source = replaceOnce(
    before,
    CUSTOM_PROVIDER_API_OWNER_HINT_NEEDLE,
    CUSTOM_PROVIDER_API_OWNER_HINT_PATCHED_NEEDLE,
    patchId,
  );
  verifyCustomProviderApiOwnerHintPatch(source, patchId);
  writeText(target, source);
  return { status: 'applied', detail: path.relative(openclawDir, target) };
}

function patchCustomProviderSyntheticProfileDefer(openclawDir) {
  const patchId = 'custom-provider-skip-synthetic-profile-defer';
  const distDir = path.join(openclawDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return { status: 'skipped', detail: 'dist not found' };
  }

  const target = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'model-auth-',
    markers: [
      'function shouldDeferSyntheticProfileAuth(params)',
      'shouldDeferProviderSyntheticProfileAuthWithPlugin({',
      'resolvedApiKey: params.resolvedApiKey',
    ],
  });
  const before = readText(target);
  const alreadyPatched = before.includes(CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_PATCHED_NEEDLE);
  if (alreadyPatched) {
    return { status: 'clean', detail: path.relative(openclawDir, target) };
  }

  const source = replaceOnce(
    before,
    CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_NEEDLE,
    CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_PATCHED_NEEDLE,
    patchId,
  );
  verifyCustomProviderSyntheticProfileDeferPatch(source, patchId);
  writeText(target, source);
  return { status: 'applied', detail: path.relative(openclawDir, target) };
}

function patchWebLoginContract(openclawDir) {
  const patchId = 'openclaw-web-login-contract';
  const distDir = path.join(openclawDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return { status: 'skipped', detail: 'dist not found' };
  }

  const protocolTarget = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'protocol-',
    markers: [
      'const WebLoginStartParamsSchema = Type.Object({',
      'const WebLoginWaitParamsSchema = Type.Object({',
      'const QrDataUrlSchema = Type.String({',
    ],
  });
  const serverTarget = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'server-methods-',
    markers: [
      'const WEB_LOGIN_METHODS = new Set(["web.login.start", "web.login.wait"]);',
      'const resolveWebLoginProvider =',
      'loginWithQrStart',
      'loginWithQrWait',
    ],
  });

  let protocolSource = readText(protocolTarget);
  let serverSource = readText(serverTarget);
  const protocolPatched = protocolSource.includes(WEB_LOGIN_START_SCHEMA_PATCHED_NEEDLE)
    && protocolSource.includes(WEB_LOGIN_WAIT_SCHEMA_PATCHED_NEEDLE);
  const serverPatched = serverSource.includes(WEB_LOGIN_PROVIDER_PATCHED_NEEDLE)
    && !serverSource.includes(WEB_LOGIN_PROVIDER_LOOKUP_NEEDLE)
    && serverSource.includes(WEB_LOGIN_WAIT_CALL_PATCHED_NEEDLE);
  if (protocolPatched && serverPatched) {
    return {
      status: 'clean',
      detail: `${path.relative(openclawDir, protocolTarget)}, ${path.relative(openclawDir, serverTarget)}`,
    };
  }

  if (!protocolSource.includes(WEB_LOGIN_START_SCHEMA_PATCHED_NEEDLE)) {
    protocolSource = replaceOnce(protocolSource, WEB_LOGIN_START_SCHEMA_NEEDLE, WEB_LOGIN_START_SCHEMA_PATCHED_NEEDLE, patchId);
  }
  if (!protocolSource.includes(WEB_LOGIN_WAIT_SCHEMA_PATCHED_NEEDLE)) {
    protocolSource = replaceOnce(protocolSource, WEB_LOGIN_WAIT_SCHEMA_NEEDLE, WEB_LOGIN_WAIT_SCHEMA_PATCHED_NEEDLE, patchId);
  }
  if (!serverSource.includes(WEB_LOGIN_PROVIDER_PATCHED_NEEDLE)) {
    serverSource = replaceOnce(serverSource, WEB_LOGIN_PROVIDER_NEEDLE, WEB_LOGIN_PROVIDER_PATCHED_NEEDLE, patchId);
  }
  if (serverSource.includes(WEB_LOGIN_PROVIDER_LOOKUP_NEEDLE)) {
    serverSource = replaceAll(serverSource, WEB_LOGIN_PROVIDER_LOOKUP_NEEDLE, WEB_LOGIN_PROVIDER_LOOKUP_PATCHED_NEEDLE, patchId);
  }
  if (!serverSource.includes(WEB_LOGIN_WAIT_CALL_PATCHED_NEEDLE)) {
    serverSource = replaceOnce(serverSource, WEB_LOGIN_WAIT_CALL_NEEDLE, WEB_LOGIN_WAIT_CALL_PATCHED_NEEDLE, patchId);
  }

  writeText(protocolTarget, protocolSource);
  writeText(serverTarget, serverSource);
  return {
    status: 'applied',
    detail: `${path.relative(openclawDir, protocolTarget)}, ${path.relative(openclawDir, serverTarget)}`,
  };
}
*/
