/**
 * MatchaClaw 对 OpenClaw 内置 channel 插件做的剔除清单。
 *
 * 写在这里的每个插件 id（对应 OpenClaw 包内 `dist/extensions/<id>/`），都会被
 *   1. `scripts/bundle-openclaw.mjs`：在 production 产物
 *      `build/openclaw/dist/extensions/<id>` 中删掉，
 *   2. `scripts/strip-openclaw-bundled-channels.mjs`：在 dev 模式直接删
 *      `node_modules/openclaw/dist/extensions/<id>`（通过 `postinstall` 钩子
 *      自动调用）。
 * 这样 OpenClaw Gateway 启动时就不会再把这些 channel 加载进来。
 *
 * 加进列表的常见原因：
 *   - 我们用了独立 npm 化的同功能插件（例如 @larksuite/openclaw-lark）替代它；
 *   - 它的运行时依赖在我们仓库里解不出兼容版本，会触发 OpenClaw 现场 npm
 *     install，而该回退路径在 Windows + Electron utilityProcess 下无法找到
 *     可用的 npm，会抛 "Unable to resolve a safe npm executable on Windows"。
 */

/**
 * @typedef {string} OpenClawBundledChannelPluginId
 */

/** @type {readonly OpenClawBundledChannelPluginId[]} */
export const REMOVED_BUNDLED_CHANNEL_PLUGIN_IDS = Object.freeze([
  // 由独立 npm 包 @larksuite/openclaw-lark（channel id: openclaw-lark）接管。
  // OpenClaw 内置 feishu 插件要求 @larksuiteoapi/node-sdk@^1.61.1，与我们
  // 仓库锁定的 1.60.0 版本不兼容，启动时会触发现场 npm install 并失败。
  'feishu',
]);

/**
 * 判断给定插件 id 是否在剔除清单中。
 *
 * @param {string} pluginId
 * @returns {boolean}
 */
export function isRemovedBundledChannelPluginId(pluginId) {
  return REMOVED_BUNDLED_CHANNEL_PLUGIN_IDS.includes(pluginId);
}
