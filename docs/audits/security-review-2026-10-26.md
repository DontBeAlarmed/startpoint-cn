# 安全审查记录（2026-10-26 会话）

时点快照：部署加固分支（Task 0-5 落地前基线 = 4dcc54d1）的结论固化。每条判定含"补全账号系统后是否依然成立"。

## P0

| 项 | 代码位置 | 账号系统补全后是否依然成立 |
|---|---|---|
| 管理面无鉴权（web_api+seeds 与游戏 API 同监听） | `src/cn-server.ts:301-330` | 部分成立——ADMIN_API_TOKEN env 已兜底（本分支 Task 2）；账号模型不影响管理面 |
| signup 设备断言旁路 + 引继源删除 | `src/routes/cn/tool.ts`（signup）、`src/routes/cn/takeOver.ts:154-168`（事务删源账号） | 不成立——补全认证后 device_id 不再是唯一身份凭证 |

## P1

| 项 | 代码位置 | 补全账号系统后是否依然成立 |
|---|---|---|
| viewer_id 低熵 bearer（9 位、365 天、不轮换） | `src/routes/cn/tool.ts`（generateViewerId）、`src/data/domains/session.ts` | 成立——会话模型问题，非账号模型 |
| 凭据端点无限速 | signup/takeover/leiting 三路由（本分支 Task 4 已加 RATE_LIMIT） | 部分缓解——限速不解决认证缺失本身 |
| 公共仓库存静态信任物（openapi 硬编码 accessToken） | `src/routes/openapi.ts:134` | 不成立——本分支已改运行时随机 |

## P2

| 项 | 位置 | 补全后判定 |
|---|---|---|
| 双会话体系（VIEWER/ZAT 并存） | `src/data/domains/session.ts`、`src/routes/openapi.ts` | 成立——收敛属协议级改造 |
| multi 房间继承 host bearer 语义 | `src/multi/` 房间成员模型 | 成立 |
| `/debug/*` 明文会话/udid 断言杂项 | `src/cn-server.ts:126-138` 邻域 | 成立（低危） |

## 处置状态（2026-10-26 部署加固分支）

已落地：ADMIN_API_TOKEN Bearer 门禁（封装作用域）、凭据端点限速（RATE_LIMIT_*）、/crash XFF 信任改 TRUST_PROXY_XFF 门控、启动姿态警告、卫生清理（login_token/viewerIdToAccountId/硬编码 accessToken）。

未落地（协议级，Non-Goals）：viewer_id 熵变更、admin 分离监听、双会话（VIEWER/ZAT）收敛、signup 设备断言的 env 级缓解（不存在，只做文档直说）。
