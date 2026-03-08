# MatchaClaw 自建更新服务器发布手册

本文档用于团队统一操作：  
将 MatchaClaw 版本发布到 GitHub Release，并自动同步到你自己的服务器目录（Caddy 静态托管）作为客户端自动更新源。

---

## 0. 当前仓库配置（已接入）

已在项目中配置：

1. `electron-builder.yml` 发布源：
   - `generic`: `https://www.supercnm.top/claw-update`
   - `github`: `hellowKeyzj/Matcha-claw`
2. `.github/workflows/release.yml`：
   - 构建产物后自动执行 `rsync` 上传到服务器（受 secrets 控制）
   - 同时创建 GitHub Release
3. `electron/main/updater.ts`：
   - 使用 `app-update.yml` 提供的发布源，不再硬编码某个固定 URL

---

## 1. 服务器准备

以下命令在服务器执行（Ubuntu 示例）：

```bash
sudo mkdir -p /opt/claw-update
sudo chown -R www-data:www-data /opt/claw-update
sudo chmod -R 755 /opt/claw-update
ls -ld /opt/claw-update
```

---

## 2. Caddy 配置

在你的 `www.supercnm.top` 站点路由里加入：

```caddy
handle_path /claw-update/* {
    root * /opt/claw-update
    @manifest path /latest*.yml /alpha*.yml /beta*.yml
    header @manifest Cache-Control "no-cache, no-store, must-revalidate"
    file_server
}
```

应用配置：

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

调测：

```bash
curl -I https://www.supercnm.top/claw-update/
```

---

## 3. 给 GitHub Actions 准备 SSH 密钥

### 3.1 检查 `www-data` 是否可 SSH 登录

```bash
getent passwd www-data
```

如果最后一列是 `/usr/sbin/nologin`，workflow 用 `www-data` SSH 会失败。  
推荐改用 `root` 或单独 `deploy` 用户作为 `UPDATE_SERVER_USER`。

### 3.2 生成密钥并配置 `authorized_keys`（以 `www-data` 为例）

```bash
sudo mkdir -p /var/www/.ssh
sudo chown -R www-data:www-data /var/www/.ssh
sudo chmod 700 /var/www/.ssh

sudo -u www-data ssh-keygen -t ed25519 -C "gh-actions-deploy" -f /var/www/.ssh/matchaclaw_deploy_key -N ""
sudo -u www-data sh -c 'cat /var/www/.ssh/matchaclaw_deploy_key.pub >> /var/www/.ssh/authorized_keys'
sudo chmod 600 /var/www/.ssh/authorized_keys
```

查看私钥（用于 GitHub Secret）：

```bash
sudo cat /var/www/.ssh/matchaclaw_deploy_key
```

---

## 4. GitHub Secrets 配置

路径：仓库 -> `Settings` -> `Secrets and variables` -> `Actions` -> `Repository secrets`

新增以下 Secret：

1. `MATCHA_RELEASE_TOKEN`  
   用于创建 GitHub Release（需要目标仓 `contents:write`）
2. `UPDATE_SERVER_HOST`  
   示例：`www.supercnm.top`
3. `UPDATE_SERVER_PORT`  
   示例：`22`
4. `UPDATE_SERVER_USER`  
   示例：`www-data` 或 `root`
5. `UPDATE_SERVER_PATH`  
   示例：`/opt/claw-update`
6. `UPDATE_SERVER_SSH_KEY`  
   上一步生成的私钥全文（含 `BEGIN/END OPENSSH PRIVATE KEY`）

---

## 5. 推送发布（触发自动上传）

在本地仓库执行：

```bash
cd e:\code\Matcha-claw
git pull
git add .
git commit -m "chore: release prep"
git push
```

打测试 tag（触发 Release workflow）：

```bash
git tag v0.1.23-test1
git push origin v0.1.23-test1
```

---

## 6. 发布后调测命令

### 6.1 看 GitHub Actions

在 `Release` workflow 确认以下步骤成功：

1. `Deploy update files to update server`
2. `Create GitHub Release`

### 6.2 看服务器文件

```bash
ls -lh /opt/claw-update
```

### 6.3 验证更新索引与静态下载

```bash
curl -I https://www.supercnm.top/claw-update/latest.yml
curl -I https://www.supercnm.top/claw-update/latest-mac.yml
curl -I -H "Range: bytes=0-99" https://www.supercnm.top/claw-update/<你的安装包文件名>
```

说明：

1. `latest*.yml` 返回 `200` 即索引可访问
2. `Range` 请求返回 `206` 最佳（分段下载可用）

---

## 7. 常见报错与处理

### 7.1 `Skip server deploy (missing secrets)`

有 secret 名字缺失或为空。  
重新检查第 4 节 6 个 secret。

### 7.2 `Permission denied (publickey)`

检查：

1. `UPDATE_SERVER_SSH_KEY` 是否完整私钥
2. 服务器 `authorized_keys` 是否包含对应公钥
3. `UPDATE_SERVER_USER` 是否与密钥所属用户一致

### 7.3 `rsync ... Permission denied`

目录权限不对：

```bash
ls -ld /opt/claw-update
sudo chown -R www-data:www-data /opt/claw-update
sudo chmod -R 755 /opt/claw-update
```

### 7.4 `404 /claw-update/latest.yml`

检查：

1. Caddy 是否已 reload
2. `/opt/claw-update` 是否存在 `latest*.yml`
3. 路由是否写成 `handle_path /claw-update/*`

---

## 8. 删除测试 tag（可选）

```bash
git tag -d v0.1.23-test1
git push origin :refs/tags/v0.1.23-test1
```

