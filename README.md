# StarPoint CN

StarPoint CN 是《世界弹射物语》国服（雷霆）客户端的非官方服务端实现。项目聚焦于解析官方客户端请求、维护玩家状态，并向客户端提供运行所需的 API、联机服务和 CDN 归档。

> `dev` 是集成测试分支。自动测试和服务端构建通过不等于客户端全量验收完成；稳定版本仍以 `main` 为准。未验证流程见[测试进度](./docs/status/test-progress.md)。

## 支持边界

当前开发与验收基线为：

- 官方 CN 1.8.1 客户端，仅修改登录跳过和服务器地址；
- 官方 CN 1.4.54 CDN，完整放入 `.cdn/cn/`；
- Node.js >= 20.12.0，日常使用当前默认版本；
- SQLite 本地状态，默认写入 `.database/`。

项目不保证兼容被修改的游戏逻辑、损坏或自制的 CDN、其他客户端版本，也不为这些输入提供自动修复。客户端 APK、官方 CDN 和漫画资源不随仓库分发。

网络运行范围为本机和受信任的局域网。服务端不提供公网管理后台鉴权、TCP TLS 或云安全承诺；变量语义和范围见[网络支持边界](./docs/getting-started/network-boundary.md)。

## 当前状态

服务端已经覆盖账号与存档、主要养成、单人关卡、部分特殊活动、抽卡、商店、邮件、NPC 协力及内容运行时，但仍有部分端点、任务分类和客户端流程尚未完成验收。

- [支持矩阵](./docs/status/support-matrix.md)：逐模块区分实现、自动测试与人工验收
- [测试进度](./docs/status/test-progress.md)：客户端、后台与宿主的实测范围和待测流程
- [已知问题](./docs/status/known-issues.md)：当前未解决问题
- [路由族覆盖](./docs/reference/routes-status.md)：按业务路由族查看当前实现边界
- [完整文档入口](./docs/README.md)：按使用目标选择阅读路径

## 最短启动

默认 `ASSET_MODE=local`。准备好官方 CDN 后：

```bash
npm ci
cp .env.example .env
bash scripts/start-cn.sh
```

启动脚本会先编译 CN 服务端，再按资源模式启动：`local` 先执行 `content:sync`，成功后启动；`remote` 和 `client-owned` 不执行本地内容同步，直接按该模式初始化并启动。详细准备、目录和故障排查见[运行服务](./docs/getting-started/README.md)。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run build` | 构建必需的 React 后台与服务端（等价于 `build:server`） |
| `bash scripts/start-cn.sh` | 前台构建；`local` 同步后启动，其他资源模式直接启动 |
| `npm run start:cn` | 使用已有构建；`local` 同步后启动，其他资源模式直接启动 |
| `npm run dev:cn` | 构建服务端；`local` 同步后启动，其他资源模式直接启动 |
| `npm run debug:cn` | TypeScript 热重载调试，不自动同步内容 |
| `npm run content:sync` | 为本地 CDN 手动生成或复用 Content Release |
| `npm run content:audit -- --source-root <WF_ASSETS_CN_ROOT>` | 只读核对 Registry 运行表与任务关键表来源 |
| `npm run build:admin` | 构建 React 管理后台 |
| `npm run docs:check` | 检查文档链接、目录入口和索引覆盖 |
| `npm run test:changed` | 运行与当前改动相关的测试 |
| `npm run verify:full` | 类型、完整测试、仓库卫生与服务端构建验证 |

`node out/cn-server.js` 是不会自动同步内容的低级调试入口；常规运行应使用上表中的受支持启动命令。

## 管理后台

React 管理后台是服务端内置的唯一管理界面，位于 `/admin/`。`/` 会进入该后台，`/player`、`/player/:id`、`/mail` 和 `/seeds` 只保留到对应 SPA 页面的一次兼容重定向。

根目录 `package-lock.json` 同时锁定服务端与 `admin` workspace 的依赖。安装和构建使用：

```bash
npm ci
npm run build
```

根 `build` 委托给 `build:server`：先构建后台并确认 `web/dist/index.html`，再编译服务端；任一步失败都不会产生受支持的无后台服务端构建。`build:legacy` 只供 CDN 校验和解包工具使用。

## 客户端补丁

连接本服务需要在官方 CN 1.8.1 客户端中完成两项最小修改：

1. 在 `pinball/config/core/DevConfig.as` 启用 SDK Dummy，跳过官方登录。
2. 在 `pinball/config/gbits/DevConfig_gf_android.as` 将 API 地址改为本服务地址。

仓库提供补丁脚本和说明，但不分发 APK：

```bash
bash client-patch/apply.sh <AS3_EXPORT_DIR> <SERVER_HOST>:8001
```

完整步骤见[客户端补丁说明](./client-patch/README.md)。

## 项目结构

- `src/routes/`：CN 与通用 HTTP API、管理后台 API
- `src/multi/`：多人房间、NPC 队友和 TCP 会话
- `src/data/`：SQLite 数据层及 22 个领域模块
- `src/content/`：CDN 解析、Content Release 与运行时快照
- `admin/`：React 管理后台
- `assets/`：服务端业务表和内置静态数据
- `docs/`：当前架构、系统、协议、参考与状态文档

## 贡献

提交功能前请先阅读[文档入口](./docs/README.md)和[验证工作流](./docs/development/verification-workflow.md)。新端点应以 CN 1.8.1 反编译代码、本地自备的脱敏抓包和当前实现为依据，并同步更新路由族覆盖或对应系统文档。

联机 NPC 昵称欢迎通过 PR 贡献。只需向 [`assets/server/npc_contributor_names.json`](./assets/server/npc_contributor_names.json) 添加昵称，不要提交 `playerId`；格式规则见[NPC 昵称贡献说明](./docs/systems/npc-contributor-names.md)。

## 相关项目

- [Duosion/starpoint](https://github.com/Duosion/starpoint)：全球服服务端基础
- [wdfp-extractor](https://github.com/ScripterSugar/wdfp-extractor)：资源提取
- [wfax](https://github.com/blead/wfax)：资源转换与修改
- [starview](https://github.com/duosii/starview)：APK 补丁工具

本项目采用 [GPL-3.0](./LICENSE) 许可证。
