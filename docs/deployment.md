# 公网部署完整指南（从零到运行）

## 核心原则

**管理面板和控制台绝不能直接暴露在公网**。使用 nginx 反向代理隔离，仅转发游戏 API 和 CDN 资源。

---

## 1. 环境准备

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y \
  nodejs npm nginx certbot python3-certbot-nginx \
  git apache2-utils sqlite3

# 使用当前环境默认的 Node.js；最低要求见 package.json 的 engines
node -v
```

如果默认版本不满足 `package.json` 的 `engines`：

1. 从 [Node.js 官方下载页](https://nodejs.org/en/download)安装满足 `engines` 的当前受支持版本。
2. 重新打开 shell，确认新版本已生效：

```bash
node -v
npm -v
```

确认后再继续执行 `npm install`。

---

## 2. 克隆项目 & 安装依赖

```bash
git clone <YOUR_REPO_URL> starpoint-cn
cd starpoint-cn
npm install
```

---

## 3. CDN 资源

将 CN CDN 资源放入 `.cdn/cn/` 目录（约 10 GB，从官方 CDN 下载或本地上传）：

```bash
# 确保以下结构存在
ls .cdn/cn/
# EntityLists/       ← 必须同时有 PathFile 和 10939-android_medium.csv
# production/        ← 所有 CDN 资源文件
# archive-*/         ← 版本化的 sha1+salt 命名归档
```

`EntityLists/` 目录需要两套命名的同内容文件：

```bash
cd .cdn/cn/EntityLists/
# 如果只有 PathFile，复制一份改名
cp PathFile 10939-android_medium.csv   # 反之亦然
```

> 详见 [`docs/cdn/overview.md`](./cdn/overview.md)

---

## 4. 配置 `.env`

```bash
cp .env.example .env
```

编辑 `.env`，找到公网部署区块（以 `# ═══════ 公网部署 ═══════` 标注），取消注释并填入实际值：

```bash
# 公网部署 — 取消注释，<YOUR_DOMAIN> 替换为你的实际域名
CN_LISTEN_HOST="127.0.0.1"                        # 仅监听本地，由 nginx 代理
CDN_BASE_URL="https://<YOUR_DOMAIN>/patch/cn"     # 公网域名 + HTTPS
SESSION_PUBLIC_HOST="<YOUR_DOMAIN>"               # 联机 TCP 公网地址

# 确认局域网部署区块的值也被注释或改为上方值
# CN_LISTEN_HOST 只能有一个未注释的值
```

完整 `.env` 各字段说明见文件内注释。

---

## 5. 域名 & SSL 证书

```bash
# 将域名 DNS 解析到你的服务器 IP
# 然后申请 Let's Encrypt 免费证书
sudo certbot certonly --standalone -d <YOUR_DOMAIN>
# 或如果 nginx 已运行：
sudo certbot --nginx -d <YOUR_DOMAIN>

# 验证自动续期
sudo certbot renew --dry-run
```

---

## 6. nginx 反向代理

### 6.1 创建站点配置

```bash
sudo nano /etc/nginx/sites-available/starpoint
```

填入以下配置（**替换所有 `<YOUR_DOMAIN>` 为你的实际域名**）：

```nginx
# 速率限制 zone 定义（放在 server 块外的 http 块中）
# 如果你的 nginx.conf 没有单独配置，就在此 server 块前定义
limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;
limit_req_zone $binary_remote_addr zone=diagnostics:10m rate=1r/s;

server {
    listen 443 ssl http2;
    server_name <YOUR_DOMAIN>;

    # SSL 证书（certbot 自动填入或手动指定）
    ssl_certificate     /etc/letsencrypt/live/<YOUR_DOMAIN>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<YOUR_DOMAIN>/privkey.pem;

    client_max_body_size 64k;

    # ── 游戏 API → Fastify ──
    location /api/index.php/ {
        limit_req zone=api burst=30 nodelay;
        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    # ── CN CDN 静态资源 ──
    location /patch/cn/ {
        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
    }

    # ── 诊断端点（严格限速） ──
    location /crash {
        limit_req zone=diagnostics burst=2;
        proxy_pass http://127.0.0.1:8001;
    }
    location /debug {
        limit_req zone=diagnostics burst=2;
        proxy_pass http://127.0.0.1:8001;
    }

    # ── 管理面板（内网 only + 密码保护） ──
    location / {
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow <YOUR_LAN_SUBNET>;               # 替换为你的实际内网网段
        deny all;

        auth_basic "Admin Panel";
        auth_basic_user_file /etc/nginx/.htpasswd;

        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
    }
}

# HTTP → HTTPS 永久重定向
server {
    listen 80;
    server_name <YOUR_DOMAIN>;
    return 301 https://$host$request_uri;
}
```

### 6.2 创建管理面板密码

```bash
sudo htpasswd -c /etc/nginx/.htpasswd admin
# 输入密码
```

### 6.3 启用站点

```bash
sudo ln -sf /etc/nginx/sites-available/starpoint /etc/nginx/sites-enabled/
sudo nginx -t                     # 检查配置语法
sudo systemctl reload nginx
```

---

## 7. 防火墙（iptables）

```bash
# 清空现有规则（谨慎！已经有精细规则则跳过此步）
sudo iptables -F

# 只允许本地 nginx → Fastify 8001
sudo iptables -A INPUT -p tcp --dport 8001 -s 127.0.0.1 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 8001 -j DROP

# TCP 联机 8003（可选，见第 11 步）
sudo iptables -A INPUT -p tcp --dport 8003 -j ACCEPT

# SSH
sudo iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# HTTP/HTTPS（nginx 对外）
sudo iptables -A INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# 已建立连接的响应包放行
sudo iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# 默认拒绝所有入站
sudo iptables -P INPUT DROP

# 持久化（重启后保留）
sudo apt install -y iptables-persistent
sudo netfilter-persistent save
```

---

## 8. 构建 & 启动

```bash
# 前台执行：build:server + content:sync normal + 启动服务
bash scripts/start-cn.sh
```

`scripts/start-cn.sh` 会先完成 CN 服务端构建，再以前台方式进入 bootstrap。bootstrap 加载可选 `.env`，运行 `content:sync` normal；只有同步成功并激活当前 Release 后才启动游戏服务。服务日志直接写入标准输出和标准错误，`SIGINT` / `SIGTERM` 会转发给当前活动子进程。

脚本不终止已有服务、不创建后台进程，也不写固定日志文件。需要后台运行时，由调用者或进程管理器托管上述前台命令，并负责进程生命周期与日志收集。

### 低级调试入口

```bash
npm run build:server
npm run content:sync
node out/cn-server.js
```

`node out/cn-server.js` 不会自动同步内容；它仅适合已明确准备并激活当前 Release 的高级调试场景。

### 管理面板访问

通过 VPN 或 SSH 隧道访问管理面板：

```bash
# 在你的本地机器上建立 SSH 隧道
ssh -L 8001:127.0.0.1:8001 user@<SERVER_IP>
# 然后浏览器打开 http://127.0.0.1:8001/
```

---

## 9. 验证部署

```bash
# 1. 查看监听端口（应只有 127.0.0.1 上）
ss -tlnp | grep 8001
# 输出：127.0.0.1:8001  ← 公网不可达

# 2. 公网访问测试（从外部机器执行）
curl -s -o /dev/null -w "%{http_code}" http://<SERVER_IP>:8001/
# 预期：000（被防火墙拦截）

# 3. API 端点测试
curl -s -o /dev/null -w "%{http_code}" https://<YOUR_DOMAIN>/api/index.php/tool/get_header_response
# 预期：200

# 4. 管理面板拦截测试
curl -s -o /dev/null -w "%{http_code}" https://<YOUR_DOMAIN>/
# 预期：401 Unauthorized（需要 Basic Auth 密码）

# 5. 在前台终端或进程管理器中检查服务标准输出
# 预期包含 CN StarPoint、SEED、TCP 和 listen 等启动信息
```

---

## 10. 客户端 APK 改造

需要修改官方 APK 连接到你的服务器。详见 [`client-patch/README.md`](../client-patch/README.md)：

- **免登录** — `DevConfig.as`:`sdkDummy = false` → `true`
- **重定向** — 域名改为 `https://<YOUR_DOMAIN>`

---

## 11. 联机 TCP（默认启用）

联机战斗需要客户端直连 TCP 端口 8003。

### `.env` 配置

```bash
SESSION_HOST="0.0.0.0"               # TCP 公网监听（.env.example 已默认）
SESSION_PUBLIC_HOST="<YOUR_DOMAIN>"   # 客户端连接的公网地址
```

### 防火墙

```bash
# 已在第 7 步配置
sudo iptables -A INPUT -p tcp --dport 8003 -j ACCEPT
```

### 如需关闭联机

```bash
# 防火墙阻止 8003 + .env 改为 SESSION_HOST="127.0.0.1"
sudo iptables -D INPUT -p tcp --dport 8003 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 8003 -s 127.0.0.1 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 8003 -j DROP
```

### 安全

- TCP 联机为**明文传输**，无 TLS 加密。未来可通过 nginx stream 模块添加 TLS 层
- 服务端已内置连接管理和房间过期清理，无需额外配置

---

## 安全加固清单

| # | 检查项 | 状态 |
|---|--------|:---:|
| 1 | CN 会话 token 使用随机数（非自增 ID） | ✅ `tool.ts` |
| 2 | `contentsGuide.ts` 验证 session | ✅ `contentsGuide.ts` |
| 3 | `/crash` 速率限制（30次/60秒）；`/debug` 不限速（游戏beacon流量大） | ✅ `cn-server.ts` |
| 4 | 请求体大小限制 64KB | ✅ `cn-server.ts` |
| 5 | `CN_LISTEN_HOST="127.0.0.1"`（仅本地监听） | ✅ `.env` |
| 6 | nginx 反向代理（443 + SSL） | ✅ 第 6 步 |
| 7 | 管理面板 IP 白名单 + HTTP Basic Auth | ✅ 第 6.2 步 |
| 8 | 防火墙只允许 22/80/443/8003 | ✅ 第 7 步 |

---

## 已知局限性

| 项目 | 风险 | 缓解 |
|------|------|------|
| Web 管理面板无应用层认证 | 内网用户可操作 | nginx `allow` IP + `auth_basic` |
| TCP 联机无 TLS | 明文传输 | 可加 nginx stream TLS；已有连接数管理和房间过期 |
| 支付端点无真实验证 | 本地支付绕过 | 设计如此（自建服），不对外 |
| 日志不脱敏 | 可能记录设备 ID | crash 截断至 2000 字符 |
