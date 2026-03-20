# secureclaw-runtime（运行时最小子集）

该目录是 `security-core` 实际运行时依赖的 secureclaw 子集，只保留启动审计链路必需文件：

- `src/auditor.ts`
- `src/types.ts`
- `src/utils/hash.ts`
- `src/utils/ioc-db.ts`
- `ioc/indicators.json`

## 设计目的

1. 让 `security-core` 的运行时依赖在 `src/` 内自闭环，便于重构与测试。
2. 运行时审计只依赖该目录最小子集，避免无关模块进入热路径。

## 同步原则

- 若后续需要跟进上游 secureclaw 变更，只在本目录按需同步上述最小子集。
- 运行时不允许新增跨目录导入其他快照源；新增能力必须先纳入本目录边界后再接入。
