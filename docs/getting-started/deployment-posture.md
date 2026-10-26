# 部署姿态指南（Deployment Posture）

**定位声明**：本服务器为**私人部署形态**设计（局域网/本机、可信使用者）。以下三个 by-design 行为——管理 API 无鉴权（未设 `ADMIN_API_TOKEN` 时）、signup 身份=客户端断言 device_id、viewer_id 即长期 bearer 令牌——是**契约**而非缺陷；但公网部署前必须按下表处理。

## 威胁模型摘要

| 面 | 前提 | 责任归属 |
|---|---|---|
| 管理 API `/api/*` 无鉴权（未设 `ADMIN_API_TOKEN` 时） | 端口可达 | env 开关（`ADMIN_API_TOKEN`）或网络层 |
| `/tool/signup` 设备断言接管 + 引继源删除 | 知悉/撞到 device_id | **无 env 缓解**——只有网络隔离或补全认证（见第 4 节） |
| viewer_id 低熵 bearer（9 位、365 天、不轮换） | 可发包即可枚举 | RATE_LIMIT_* 缓解枚举速率；根治需补全会话模型 |
| 凭据端点爆破（signup/takeover/leiting/crash） | 可发包 | RATE_LIMIT_* 已兜底（默认 10/分/IP，crash 30/分） |

## 公网最低动作清单

1. 反向代理 + TLS（本服务不做 TLS）；
2. 防火墙收管理面端口，或设置 `ADMIN_API_TOKEN`；
3. 确认 `TRUST_PROXY_XFF=1` **仅在可信反代之后**设置——直连公网设它等于不限速；
4. `web/dist` 需 `npm run build:admin` 重建（token 模式下面板才有 token 输入口）；
5. 定期备份 `.database/`。

## 账号系统补全 recipe（未来接缝）

身份入口共三处，替换点与现状：

| 入口 | 文件 | 现状 |
|---|---|---|
| signup | `src/routes/cn/tool.ts` | device_id 断言 → 自动建号/复用 |
| 引继（takeOver） | `src/routes/cn/takeOver.ts` | 事务中删除未标记源账号 |
| ZAT-ZRT 模板 | `src/routes/openapi.ts` | 仅注册于全局 `src/server.ts`，CN 服务未挂载 |

替换点：实现 `src/lib/account-identity-provider.ts` 的 `AccountIdentityProvider`（`setAccountIdentityProvider`）+ 用真实验证替换 `leitingAuth.ts` 回显 + 复用 openapi 的会话签发。业务路由只消费 `session.accountId`，无需改动。

Schema 已预留 `username`/`password_hash`（**未接线**，勿与活的 `takeover_password_hash` 混淆）与 `idp_alias`/`idp_code`/`idp_id` 三元组。

## 环境变量参考

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_API_TOKEN` | 未设（不鉴权） | 管理 API Bearer 门禁；建议 ≥16 字符随机值 |
| `TRUST_PROXY_XFF` | 未设（不信任 XFF） | 仅在可信反代后设为 `1` |
| `RATE_LIMIT_SIGNUP_MAX` / `_WINDOW_MS` | 10 / 60000 | signup 每窗口每 IP 次数 |
| `RATE_LIMIT_TAKEOVER_MAX` / `_WINDOW_MS` | 10 / 60000 | 引继路由同上 |
| `RATE_LIMIT_LEITING_MAX` / `_WINDOW_MS` | 30 / 60000 | SDK 登录桩同上 |
| `RATE_LIMIT_CRASH_MAX` / `_WINDOW_MS` | 30 / 60000 | `/crash` 遥测同上 |
