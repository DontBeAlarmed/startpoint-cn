# StarPoint CN 部署与运维指南

本文覆盖本机 Windows 验收和 Linux 公网部署。管理接口同时使用应用令牌与反向代理边界；
`8001` 不应直接暴露公网，`/admin/` 也不应绕过 nginx 的 IP/Basic Auth 防线。

## 1. 运行基线

- Node.js `>=20.19.0`（与根 `package.json` 的 `engines` 一致）；
- 使用 lockfile 安装：根目录和 `admin/` 均执行 `npm ci`；
- `web/dist` 是本地产物，不提交 Git；部署前必须执行 `npm run build:admin`；
- 根目录与 `admin/` 的 high/critical audit 必须为 0。

```bash
node --version
npm ci
npm --prefix admin ci
npm audit
npm --prefix admin audit
npm run verify
```

`npm run verify` 会依次检查服务端类型、Node 测试、后台类型和构建体积、Python 工具测试。
启动器与仓库卫生门禁需另外执行：

```bash
npm run test:launcher
npm run test:hygiene
npm run check:hygiene
```

## 2. 本机 Windows 安全运行

复制配置并生成管理令牌：

```powershell
Copy-Item .env.example .env
./scripts/generate-admin-token.ps1
```

若 `.env` 已有令牌，需要主动轮换时使用 `-Rotate`。脚本只输出令牌指纹，不打印令牌正文。

```powershell
./start-cn.bat -CheckOnly       # 只检查环境、端口归属和构建新鲜度
./start-cn.bat                  # 前台运行，Ctrl-C 停止
./start-cn.bat -RestartOwned    # 只重启本项目 PID 记录确认的进程
```

Windows 启动器根据 PID 记录、Node 命令行和 `out/cn-server.js` 入口三重确认所有权。
端口属于其他进程时会拒绝启动，不会终止陌生进程。地址和端口取自 `.env` 的
`CN_LISTEN_HOST` / `CN_LISTEN_PORT`，不要把某台机器的 LAN IP 写死进脚本。

管理后台地址为 `http://<CN_LISTEN_HOST>:<CN_LISTEN_PORT>/admin/`。

## 3. Linux 准备与资源

以 Ubuntu/Debian 为例：

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx git apache2-utils sqlite3 openssl
```

使用 fnm、发行版 NodeSource 包或其他受维护方式安装 Node 20.19+，然后克隆项目：

```bash
git clone -b release/modes-20260714 https://github.com/kuronzzhan-droid/startpoint-cn.git starpoint-cn
cd starpoint-cn
npm ci
npm --prefix admin ci
```

需要“深渊连战 + 深渊武器”完整自建流程时，再阅读
[`self-host-modes.md`](./self-host-modes.md)。

将 CN CDN 资源放入 `.cdn/cn/`（约 10 GB）：

```text
.cdn/cn/
├─ EntityLists/       # PathFile 与 10939-android_medium.csv
├─ production/
└─ archive-*/
```

两份 EntityList 必须内容一致。资源结构说明见 [`cdn/overview.md`](./cdn/overview.md)。

## 4. `.env` 与管理鉴权

```bash
cp .env.example .env
TOKEN="$(openssl rand -hex 32)"
printf '\nCN_ADMIN_TOKEN="%s"\n' "$TOKEN" >> .env
unset TOKEN
chmod 600 .env
```

公网部署的关键项：

```dotenv
CN_LISTEN_HOST="127.0.0.1"
CN_LISTEN_PORT="8001"
CDN_BASE_URL="https://<YOUR_DOMAIN>/patch/cn"
SESSION_PUBLIC_HOST="<YOUR_DOMAIN>"
CN_ADMIN_COOKIE_SECURE="true"
```

`CN_ADMIN_TOKEN` 至少 32 UTF-8 字节。非 loopback 监听没有令牌时服务端会拒绝启动；
`CN_ADMIN_ALLOW_INSECURE_LOOPBACK=true` 只允许纯本机临时开发，不能用于 LAN/公网。
后台登录成功后使用带签名、限时的 HttpOnly 会话 cookie；管理 API 也支持
`Authorization: Bearer <CN_ADMIN_TOKEN>`。

## 5. 构建、前台启动与 systemd

先执行完整验收和构建：

```bash
npm audit
npm --prefix admin audit
npm run verify
bash scripts/start-cn.sh --check-only
```

Linux 启动器以前台方式运行，不做宽泛进程匹配，也不自动终止已有监听者：

```bash
bash scripts/start-cn.sh
```

生产环境建议交给 systemd 管理生命周期。下面的用户、路径和 Node 路径需要按实际环境替换：

```ini
# /etc/systemd/system/starpoint-cn.service
[Unit]
Description=StarPoint CN
After=network.target

[Service]
Type=simple
User=starpoint
WorkingDirectory=/srv/starpoint-cn
ExecStart=/usr/bin/node --env-file=/srv/starpoint-cn/.env /srv/starpoint-cn/out/cn-server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now starpoint-cn
sudo systemctl status starpoint-cn
journalctl -u starpoint-cn -f
```

代码或依赖更新时，先停服务，再执行 `npm ci`、`npm --prefix admin ci`、`npm run verify`，
最后 `sudo systemctl restart starpoint-cn`。不要用进程名范围匹配代替服务管理器。

## 6. 域名、TLS 与 nginx

域名解析到服务器后申请证书：

```bash
sudo certbot certonly --standalone -d <YOUR_DOMAIN>
sudo certbot renew --dry-run
sudo htpasswd -c /etc/nginx/.htpasswd admin
```

nginx 站点示例（替换域名和内网网段）：

```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;
limit_req_zone $binary_remote_addr zone=diagnostics:10m rate=1r/s;

server {
    listen 443 ssl http2;
    server_name <YOUR_DOMAIN>;

    ssl_certificate     /etc/letsencrypt/live/<YOUR_DOMAIN>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<YOUR_DOMAIN>/privkey.pem;
    client_max_body_size 64k;

    # 游戏 API：公网客户端需要
    location /api/index.php/ {
        limit_req zone=api burst=30 nodelay;
        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # CN CDN：公网客户端需要
    location /patch/cn/ {
        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
    }

    location = /crash {
        limit_req zone=diagnostics burst=2;
        proxy_pass http://127.0.0.1:8001;
    }

    location = /debug {
        limit_req zone=diagnostics burst=2;
        proxy_pass http://127.0.0.1:8001;
    }

    # 其余路径（含 /admin/ 与管理 API）：内网/VPN + Basic Auth。
    # 服务端自己的 CN_ADMIN_TOKEN 仍然必须启用，形成第二层防线。
    location / {
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow <YOUR_LAN_SUBNET>;
        deny all;

        auth_basic "StarPoint Admin";
        auth_basic_user_file /etc/nginx/.htpasswd;

        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name <YOUR_DOMAIN>;
    return 301 https://$host$request_uri;
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/starpoint /etc/nginx/sites-enabled/starpoint
sudo nginx -t
sudo systemctl reload nginx
```

## 7. 防火墙

不要清空一台已有服务器的防火墙规则。新机器可用 UFW 建立最小放行集：

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 8003/tcp        # 仅启用联机 TCP 时
sudo ufw enable
sudo ufw status verbose
```

`8001` 只监听 `127.0.0.1`，不应添加公网放行规则。

## 8. 部署验收

```bash
# 只监听 loopback
ss -tlnp | grep 8001

# 游戏 API 与 CDN
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://<YOUR_DOMAIN>/api/index.php/tool/get_header_response
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://<YOUR_DOMAIN>/patch/cn/

# 管理面必须先被 nginx Basic Auth 拦截
curl -sS -o /dev/null -w '%{http_code}\n' https://<YOUR_DOMAIN>/admin/

# 应用层管理 API：无令牌 401，Bearer 令牌 200
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8001/api/server/currentTime
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer <CN_ADMIN_TOKEN>" \
  http://127.0.0.1:8001/api/server/currentTime
```

还要验证 `/admin/` 和至少一个 SPA 子路由（如 `/admin/accounts`）都返回 HTML，JS 资源返回
JavaScript MIME，并确认服务停止后端口释放。

## 9. 可逆资产维护

资产整理不是直接删除。固定顺序为 `scan → plan → preflight → quarantine → verify → restore drill`：

```powershell
$runDir = 'work/remediation/<run-id>'
$policy = 'mod-tools/asset-maintenance-policy-v1.json'
$quarantine = 'D:\WF\asset-quarantine\startpoint-cn-<run-id>'

python mod-tools/wf_asset_maintenance.py scan --repo-root D:\WF\startpoint-cn --policy $policy --run-dir $runDir
# 先把当前已验证的 CDN release graph 导出为 $runDir/cdn-graph.json；图不可达或 issues 非空时停止。
python mod-tools/wf_asset_maintenance.py plan --scan "$runDir/scan.jsonl" --cdn-graph "$runDir/cdn-graph.json" --policy $policy
python mod-tools/wf_asset_maintenance.py verify --plan "$runDir/plan.json" --mode preflight
python mod-tools/wf_asset_maintenance.py quarantine --plan "$runDir/plan.json" --quarantine-root $quarantine
python mod-tools/wf_asset_maintenance.py verify --manifest "$quarantine/manifest.jsonl"
```

从 manifest 选择一个小条目执行恢复演练，再恢复隔离状态：

```powershell
python mod-tools/wf_asset_maintenance.py restore --manifest "$quarantine/manifest.jsonl" --id <entry-id>
python mod-tools/wf_asset_maintenance.py quarantine --resume --manifest "$quarantine/manifest.jsonl" --id <entry-id>
python mod-tools/wf_asset_maintenance.py verify --manifest "$quarantine/manifest.jsonl"
```

`purge` 是独立、不可逆动作。隔离成功不构成永久删除授权；没有用户另行明确授权和精确确认口令时，
保持隔离即可。不要对本地逆向目录、角色 workspace 或未提交 JSON 使用 `git clean`。

## 10. 客户端与联机 TCP

客户端 APK 重定向见 [`client-patch/README.md`](../client-patch/README.md)：

- `DevConfig.as`：`sdkDummy = false` 改为 `true`；
- 服务域名改为 `https://<YOUR_DOMAIN>`。

联机战斗默认使用 TCP `8003`：

```dotenv
SESSION_HOST="0.0.0.0"
SESSION_PUBLIC_HOST="<YOUR_DOMAIN>"
```

TCP 目前为明文传输；只在需要联机时开放端口，并避免传输敏感内容。不需要联机时将
`SESSION_HOST` 改为 `127.0.0.1` 并关闭公网 `8003`。

## 11. 已知边界

| 项目 | 当前状态 | 运维措施 |
|---|---|---|
| 管理面 | 应用令牌 + 8 小时签名会话 | nginx 内网/VPN + Basic Auth 继续作为纵深防御 |
| TCP 联机 | 无 TLS | 按需开放 8003，不承载敏感数据 |
| 支付端点 | 自建服测试语义 | 不作为真实支付系统对外提供 |
| 日志 | 可能含设备标识 | 限制日志权限、保留期和对外分享范围 |
