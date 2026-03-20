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
*   `pages/`：路由级页面组件。
*   `features/`：复杂业务功能模块（包含其独有的组件和逻辑）。
*   `components/`：通用 UI 组件（基于 shadcn/ui）。
*   `stores/`：Zustand 全局状态仓库。
*   `lib/`：核心工具库、API 客户端（`host-api`）。
*   `hooks/`：通用自定义 Hooks。

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
*   **组件卸载清理**：在 `useEffect` 中订阅事件（如 `window.electronAPI.onUpdate`）时，必须在 cleanup 函数中取消订阅，防止内存泄漏和无效更新。
​```javascript
    useEffect(() => {
      const unsubscribe = hostEvents.onUpdate(callback);
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
*   所有与后端（Main Process 或 OpenClaw Gateway）的通信，必须通过 `src/lib/` 下的模块进行。
*   **禁止**在组件内部直接使用 `fetch` 或 `axios` 调用远程 API，必须走 `host-api`。

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
*   [ ] **API 规范**：是否通过 `src/lib/host-api` 调用后端？

---

## 7. 示例：高性能列表页面模板

```tsx
import React, { useEffect, useMemo } from 'react';
import { useTaskStore } from '@/stores/taskStore';
import { FixedSizeList as List } from 'react-window';
import { Skeleton } from '@/components/ui/skeleton';
import { hostEvents } from '@/lib/host-events';

// 单个列表项组件，使用 memo 优化
const TaskRow = React.memo(({ data, index, style }) => {
  const task = data[index];
  return (
    <div style={style} className="p-2 border-b">
      {task.title}
    </div>
  );
});

export const TaskListPage = () => {
  const { tasks, fetchTasks, isLoading } = useTaskStore();

  // 1. 数据获取：首次加载 & 焦点刷新
  useEffect(() => {
    fetchTasks();
    
    // 监听后台数据变更
    const unsubscribe = hostEvents.onTaskUpdated(fetchTasks);
    
    // 清理订阅
    return () => unsubscribe();
  }, [fetchTasks]);

  // 2. 数据转换：使用 useMemo 缓存
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
  }, [tasks]);

  if (isLoading) return <Skeleton count={10} />;

  return (
    <List
      height={600}
      itemCount={sortedTasks.length}
      itemSize={50}
      width="100%"
      itemData={sortedTasks}
    >
      {TaskRow}
    </List>
  );
};
```

