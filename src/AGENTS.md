# MatchaClaw Frontend (Renderer Process) Development Guide

本文档专门针对 `src/` 目录下的 React 渲染进程代码。
所有在此目录下开发的新页面、组件、状态管理逻辑，必须严格遵守以下规范，以确保：
1.  **高性能**：不阻塞 UI 渲染，保持 60fps 流畅度。
2.  **进程隔离**：新功能不得拖慢整个 Renderer 进程，不影响其他页面。
3.  **数据一致性**：用户看到的数据尽可能保持最新，避免展示陈旧数据。

---

## 1. 核心架构原则

### 1.1 Renderer 进程的职责边界
Renderer 进程是单线程的（Main Thread），负责 UI 渲染和用户交互。
*   **严禁**在 Renderer 进程中直接进行 CPU 密集型计算（如大文件解析、复杂算法）。
*   **严禁**直接调用 Node.js API（如 `fs`, `child_process`）。所有系统级能力必须通过 `src/lib/host-api.ts` 封装的 IPC 通道调用。
*   **长任务**：任何超过 **50ms** 的同步任务必须拆分或移至 Web Worker。

### 1.2 目录结构约定
遵守现有项目结构，禁止随意新增顶层目录：
*   `plugins/<owner>/`：业务页面、投影 state/store、业务 client、专属组件、hooks、locales 与 assets/样式；Renderer 投影不接管后端事实。
*   `app/`：具体插件清单、壳扩展点、路由/导航与 `layout/` 布局状态、工具链 warmup 装配。
*   `plugin-host/`：中性的贡献、订阅与生命周期机制；产品包管理归 `plugins/application-plugins/`。
*   `components/`：中性壳与通用 UI 组件（基于 shadcn/ui）。
*   `lib/`：共享工具与统一通信（`host-api.ts`、`api-client.ts`）；`types/` 保留公开跨层 DTO/contract。
*   `i18n/`：语言选择与资源聚合；业务翻译归所属插件，公共资源保留共享。

---

## 2. 性能优化规范

### 2.1 避免阻塞主线程
Renderer 进程卡顿是导致应用“假死”或“卡顿”的主要原因。

*   **长任务处理**：
    *   如果一个同步计算耗时 > 50ms，必须使用 `requestIdleCallback` 延迟执行，或拆分为多个小任务。
    *   对于大规模数据处理（如列表排序、过滤 > 1000 条数据），必须使用 **Web Worker** 或在 Main Process 处理后返回结果。
*   **防抖与节流**：
    *   所有高频事件（`scroll`, `resize`, `input` 输入框搜索）必须使用防抖（Debounce）或节流（Throttle）。

### 2.2 组件渲染优化
防止不必要的重渲染是保持页面流畅的关键。

*   **状态下沉**：
    *   状态应尽可能靠近使用它的组件。避免在顶层页面维护单个巨大 State，导致整个页面树频繁重渲染。
*   **使用 `React.memo`**：
    *   对于接收复杂 props 的纯展示组件，必须使用 `React.memo` 包裹。
*   **正确使用 `useMemo` / `useCallback`**：
    *   **禁止**在组件内部直接定义传递给子组件的回调函数（`onClick={() => ...}`），应使用 `useCallback` 包裹以保持引用稳定。
    *   对于复杂的计算属性（如过滤列表、转换数据结构），必须使用 `useMemo` 缓存结果。
    *   *例外*：计算量极小（如简单布尔判断）的不需要 useMemo，避免过度优化。

### 2.3 列表与虚拟化
*   **虚拟滚动**：
    *   任何超过 **50 条** 数据的列表渲染，必须使用虚拟滚动技术（推荐 `react-window` 或 `react-virtualized`）。
    *   禁止直接使用 `map` 渲染长列表，这会导致 DOM 节点过多，占用大量内存和样式计算时间。
*   **稳定的 Key**：
    *   列表项必须使用稳定的唯一 ID 作为 `key`，严禁使用 `index` 作为 key。

---

## 3. 状态管理规范 (Zustand)

### 3.1 Store 设计原则
*   **按领域拆分**：将 Store 拆分为 `chatStore`, `taskStore`, `settingsStore` 等，避免单一巨大 Store。
*   **最小化状态**：只存储必要的、跨组件共享的状态。组件局部状态应使用 `useState`。

### 3.2 避免状态污染与内存泄漏
*   **组件卸载清理**：在 `useEffect` 中通过 `src/lib/host-events.ts` 订阅事件时，必须在 cleanup 函数中取消订阅，防止内存泄漏和无效更新。
​```javascript
    useEffect(() => {
      const unsubscribe = subscribeHostEvent('app-plugins:changed', callback);
      return () => unsubscribe(); // 必须清理
    }, []);
​```

### 3.3 数据新鲜度策略
为了避免用户看到旧数据：
*   **焦点刷新**：关键数据页面（如任务列表）应在窗口获得焦点（`visibilitychange` 或 `focus` 事件）时自动刷新数据。
*   **乐观更新**：对于用户操作（如标记完成），优先更新本地 Store（乐观更新），同时发起后台请求。若请求失败则回滚状态并提示用户。
*   **缓存策略**：对于非实时数据，可在 `lib/api-client` 层实现简单的内存缓存，但必须设置过期时间（TTL）。

---

## 4. 数据获取与 API 调用

### 4.1 统一 API 入口
*   业务 client 可以位于 `src/plugins/<owner>/`；所有后端请求仍复用 `src/lib/host-api.ts` → `src/lib/api-client.ts` 的统一 Electron IPC transport，事件复用 `src/lib/host-events.ts`。
*   **禁止**组件或插件 client 自建 `fetch`、`axios`、IPC/连接通道绕过统一 transport；目录归属不改变后端合同或授权。

### 4.2 错误处理
*   所有异步调用必须包含错误处理 UI（如 Toast 提示）。
*   网络异常不应导致白屏或崩溃，应展示友好的重试界面。

### 4.3 避免瀑布流请求
*   在页面初始化时，尽量并行发起多个独立的数据请求（`Promise.all`），而非串行等待。

---

## 5. UI 与 交互规范

### 5.1 首屏加载体验
*   **骨架屏**：数据加载期间必须展示骨架屏（Skeleton），避免布局抖动（CLS）。
*   **代码分割**：新页面路由必须使用 `React.lazy` 和 `Suspense` 进行懒加载，减小首包体积。

### 5.2 懒加载资源
*   非首屏图片必须使用懒加载（`loading="lazy"` 或 Intersection Observer）。
*   非关键动画库或大型组件（如复杂的图表、Markdown 编辑器）应动态导入。

---

## 6. 开发 Checklist

在提交涉及前端代码的 PR 前，请自查以下项：

*   [ ] **组件隔离**：新页面频繁操作时，打开 Chrome DevTools Performance 录制，确认没有意外的全量重渲染。
*   [ ] **长任务**：确保没有超过 50ms 的 JavaScript 执行任务阻塞主线程。
*   [ ] **内存泄漏**：切换路由离开新页面后，确认定时器、事件监听器已清除。
*   [ ] **列表性能**：长列表是否使用了虚拟滚动？
*   [ ] **数据更新**：是否处理了窗口重新聚焦时的数据刷新？
*   [ ] **API 规范**：业务 client 是否复用 `src/lib/host-api.ts` / `api-client.ts` 的统一 transport？

---

## 7. 示例：实际任务列表实现

页面、分页与虚拟列表参考 `src/plugins/tasks/pages/Tasks/index.tsx`，投影与请求去重参考 `src/plugins/tasks/stores/task-center-store.ts`，按当前 scope 预取参考 `src/plugins/tasks/plugin.ts`。复用实际 owner 与统一 transport，不照抄不存在的 Store 或事件 API。

