# License 发布清单

用于 0005 授权链路上线前后的检查与回归。

## 1. 发布前检查

1. 客户端配置
- 确认 `electron/utils/license-config.ts` 的 `BUILTIN_LICENSE_ENDPOINT` 已指向正确服务
- 或确认部署环境注入 `MATCHACLAW_LICENSE_ENDPOINT`

2. 服务可用性
- `GET /health` 返回 200
- `POST /activate` 对合法授权返回 `valid=true`

3. 数据与权限
- `license-db.json` 与 `audit.jsonl` 权限可写
- 备份数据库文件

## 2. 发布后验证

1. 新设备激活
- 输入新授权码后，Settings > License 显示 `Granted`
- Setup Welcome 校验后可进入下一步

2. 已授权设备重启
- 重启后 `App` 正常进入主界面，不回退到授权页

3. 异常路径
- 服务不可达时返回 `network_error` 文案
- 清除授权后路由门禁回到 `/settings?section=license`

## 3. 回滚策略

1. 客户端层面
- 临时切换到可用授权服务地址（环境变量覆盖）

2. 服务层面
- 使用备份 `license-db.json` 回滚
- 重启授权服务进程

## 4. 交付资料

- `scripts/license_server.py`
- `scripts/license_audit_summary.py`
- `scripts/license-server-README.md`
- 生产环境配置与监控记录
