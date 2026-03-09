# MatchaClaw 自建更新服务器发布手册（完整实操版）

目标：  
通过 GitHub Actions 自动构建并发布到 GitHub Release，同时把更新文件同步到你自己的服务器目录（Caddy 托管）作为客户端自动更新源。

---

## 0. 发布链路总览

当前项目已接入：

1. `electron-builder.yml`
   - `generic`: `https://www.supercnm.top/claw-update`
   - `github`: `hellowKeyzj/Matcha-claw`
2. `.github/workflows/release.yml`
   - 构建产物
   - 上传 GitHub Release
   - 通过 SSH + rsync 同步到服务器
3. 客户端更新读取 `app-update.yml`，不硬编码固定更新地址

---

## 1. 服务器准备（推荐 deploy 用户）

不要用 `www-data` 做 SSH 登录用户。建议独立部署用户 `deploy`。

### 1.1 创建 deploy 用户

```bash
sudo adduser --disabled-password --gecos "" deploy
```

### 1.2 创建更新目录并授权

```bash
sudo mkdir -p /opt/claw-update
sudo chown -R deploy:www-data /opt/claw-update
sudo chmod -R 775 /opt/claw-update
ls -ld /opt/claw-update
```

---

## 2. 配置 deploy 的 SSH 公钥登录

### 2.1 在你的本机生成/准备私钥

如果你已有密钥可跳过。否则本机执行：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "matchaclaw-deploy"
```

### 2.2 把公钥写到服务器 deploy 账号

```bash
sudo -u deploy mkdir -p /home/deploy/.ssh
sudo -u deploy chmod 700 /home/deploy/.ssh
echo "ssh-ed25519 AAAA...你的公钥..." | sudo -u deploy tee -a /home/deploy/.ssh/authorized_keys >/dev/null
sudo -u deploy chmod 600 /home/deploy/.ssh/authorized_keys
```

---

## 3. 本机先做 SSH 联通验证（必须先过）

Windows PowerShell 示例：

```powershell
ssh -i "$HOME\.ssh\id_ed25519" -o IdentitiesOnly=yes -p 22 deploy@www.supercnm.top "echo ok"
```

看到输出 `ok` 再继续。  
如果要用临时 key 文件，换成该绝对路径即可。

---

## 4. Caddy 配置更新目录

在 `www.supercnm.top` 的站点中加入：

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

健康检查：

```bash
curl -I https://www.supercnm.top/claw-update/
```

---

## 5. GitHub Secrets 配置

路径：`Settings -> Secrets and variables -> Actions -> Repository secrets`

必须配置：

1. `MATCHA_RELEASE_TOKEN`
   - 用于创建 GitHub Release（Token 需要 `contents:write`）
2. `UPDATE_SERVER_HOST`
   - `www.supercnm.top`
3. `UPDATE_SERVER_PORT`
   - `22`
4. `UPDATE_SERVER_USER`
   - `deploy`
5. `UPDATE_SERVER_PATH`
   - `/opt/claw-update`
6. `UPDATE_SERVER_SSH_KEY`
   - 私钥全文（含 `-----BEGIN OPENSSH PRIVATE KEY-----` 到 `-----END ...-----`）

---

## 6. 触发发布

先提交并推送代码：

```bash
git add .
git commit -m "chore: release prep"
git push
```

再打测试 tag 触发 release workflow：

```bash
git tag v0.1.24-test1
git push origin v0.1.24-test1
```

---

## 7. 发布后验收

### 7.1 GitHub Actions

确认 `Release` 工作流中以下步骤成功：

1. `Deploy update files to update server`
2. `Create GitHub Release`

### 7.2 服务器落盘

```bash
ls -lh /opt/claw-update
```

应看到 `latest*.yml`、安装包、`*.blockmap` 等文件。

### 7.3 对外访问验证

```bash
curl -I https://www.supercnm.top/claw-update/latest.yml
curl -I https://www.supercnm.top/claw-update/latest-mac.yml
curl -I -H "Range: bytes=0-99" https://www.supercnm.top/claw-update/<安装包文件名>
```

判定：

1. `latest*.yml` 返回 `200`
2. `Range` 返回 `206`（最好），至少要可访问

---

## 8. 故障定位清单（按报错关键字）

### 8.1 `Load key ... error in libcrypto`

私钥格式损坏（常见：换行被改、拷贝不完整、把 `\n` 当普通字符）。

排查：

```bash
ssh-keygen -y -f id_ed25519 >/dev/null && echo OK
```

不为 OK 则重取私钥内容。

### 8.2 `Permission denied (publickey,password)`

最常见是 `UPDATE_SERVER_USER` 配错（例如公钥加在 `deploy`，secret 却填 `www-data`）。

排查：

```bash
ssh -i id_ed25519 -o IdentitiesOnly=yes -p 22 deploy@www.supercnm.top "echo ok"
```

不通就检查：

1. `authorized_keys` 是否有对应公钥
2. `UPDATE_SERVER_USER` 是否与公钥所属账号一致
3. 端口/域名是否正确

### 8.3 `rsync ... Permission denied`

目录权限不足：

```bash
ls -ld /opt/claw-update
sudo chown -R deploy:www-data /opt/claw-update
sudo chmod -R 775 /opt/claw-update
```

### 8.4 `Skip server deploy (missing secrets)`

有必需 secret 缺失或为空。  
回到第 5 节逐项核对。

### 8.5 `404 /claw-update/latest.yml`

检查：

1. Caddy 是否 reload 成功
2. `/opt/claw-update` 是否已有 `latest*.yml`
3. Caddy 路由是否是 `handle_path /claw-update/*`

---

## 9. Windows 一键检查脚本（发布前自检）

在 Windows PowerShell 执行以下脚本，可在打 tag 前快速确认：

1. 本地私钥格式可解析  
2. SSH 到服务器可免密登录  
3. 服务器目标目录可写  
4. 更新源 URL 可访问

```powershell
# ===== 根据你的环境修改这 5 个变量 =====
$HostName   = "www.supercnm.top"
$Port       = 22
$User       = "deploy"
$RemotePath = "/opt/claw-update"
$KeyPath    = "$HOME\.ssh\id_ed25519"
# =====================================

$ErrorActionPreference = "Stop"

function Assert-Ok($cond, $msg) {
  if (-not $cond) { throw $msg }
}

Write-Host "== 1/4 检查私钥文件 ==" -ForegroundColor Cyan
Assert-Ok (Test-Path $KeyPath) "私钥不存在: $KeyPath"
ssh-keygen -y -f "$KeyPath" > $null
Assert-Ok ($LASTEXITCODE -eq 0) "私钥无法解析（格式损坏或内容错误）"
Write-Host "私钥格式正常" -ForegroundColor Green

Write-Host "== 2/4 检查 SSH 免密登录 ==" -ForegroundColor Cyan
$sshCmd = "echo ok"
$sshOut = ssh -i "$KeyPath" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -p $Port "$User@$HostName" $sshCmd
Assert-Ok ($LASTEXITCODE -eq 0) "SSH 连接失败（用户/端口/公钥不匹配）"
Assert-Ok ($sshOut -match "ok") "SSH 已连通但未收到预期输出"
Write-Host "SSH 免密登录正常" -ForegroundColor Green

Write-Host "== 3/4 检查远端目录权限 ==" -ForegroundColor Cyan
$remoteCheck = "mkdir -p '$RemotePath' && test -w '$RemotePath' && echo writable"
$remoteOut = ssh -i "$KeyPath" -o IdentitiesOnly=yes -p $Port "$User@$HostName" $remoteCheck
Assert-Ok ($LASTEXITCODE -eq 0) "远端目录检查失败"
Assert-Ok ($remoteOut -match "writable") "远端目录不可写: $RemotePath"
Write-Host "远端目录可写" -ForegroundColor Green

Write-Host "== 4/4 检查更新源 URL ==" -ForegroundColor Cyan
$url = "https://$HostName/claw-update/"
$resp = Invoke-WebRequest -Method Head -Uri $url -TimeoutSec 15
Assert-Ok ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) "更新源 URL 不可访问: $url"
Write-Host "更新源可访问 ($($resp.StatusCode))" -ForegroundColor Green

Write-Host ""
Write-Host "发布前自检通过，可以推送 tag 触发发布。" -ForegroundColor Green
```

---

## 10. 清理测试 tag（可选）

```bash
git tag -d v0.1.24-test1
git push origin :refs/tags/v0.1.24-test1
```
