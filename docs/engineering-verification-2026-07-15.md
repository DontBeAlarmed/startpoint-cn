# 工程整改与验收记录（2026-07-15）

## 结论

本轮已完成项目级整理、依赖安全升级、后台拆包、启动器所有权保护、仓库卫生门禁、
可逆资产隔离和新角色包发布编排。服务端、后台、Node/Python 工具与隔离端口 HTTP 冒烟均通过。

唯一仍阻塞“seris_dragon_king 作为 production 新角色包发布”的条件，是 37 项必需资产中缺少
真实的 `character_detail_skill_preview.battle.amf3.deflate`。门禁按设计拒绝发布，没有用相似角色
资源伪造，也没有修改用户现有四个 JSON 或两个角色方案文档。

## 验收环境

| 项目 | 实测值 |
|---|---:|
| Node.js | 20.20.2 |
| npm | 10.8.2 |
| Python | 3.14.6 |
| 7-Zip | 24.09 x64 |
| 分支 | `release/modes-20260714` |

根 `package.json` 已明确要求 Node `>=20.19.0`。Fastify 升级依据官方
[v5 迁移指南](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/)和各插件兼容范围；
后台升级到 [Vite 8](https://vite.dev/blog/announcing-vite8)，并使用 Rolldown 原生拆包。

## 自动验证结果

| 验证项 | 结果 |
|---|---|
| 根 `npm audit` | 0 vulnerabilities |
| 根 `npm audit --omit=dev` | 0 vulnerabilities |
| admin `npm audit` | 0 vulnerabilities |
| admin `npm audit --omit=dev` | 0 vulnerabilities |
| 服务端 TypeScript | 通过 |
| Node 测试 | 38/38 通过 |
| admin TypeScript | 通过 |
| Python 工具测试 | 416 项通过，1 项按设计 skip |
| Windows 启动器 | 18 项断言通过 |
| Linux 启动器 | 8 项断言通过 |
| 仓库卫生隔离测试 | 9/9 通过 |
| 全仓卫生扫描 | 通过 |
| wf-mod Skill 校验 | `.agents` 与 `.claude` 两份均 valid，SHA-256 完全一致 |

完整命令：

```powershell
npm ci
npm --prefix admin ci
npm audit
npm audit --omit=dev
npm --prefix admin audit
npm --prefix admin audit --omit=dev
npm run verify
npm run test:launcher
npm run test:hygiene
npm run check:hygiene
```

## 后台构建结果

整改前观测到单体产物约 1,385,313 bytes（gzip 约 435.20 kB）。整改后页面均按需加载，
Vite 8 最终构建耗时约 325 ms：

- 最大 chunk：269,831 bytes；
- 最大业务路由 chunk：`PlayerDetail`，14,196 bytes；
- Dashboard、Accounts、PlayerDetail、Mail、Seeds 均为独立 lazy route；
- `admin/scripts/check-bundle.mjs` 对 vendor、Ant Design 和业务路由分别执行预算门禁。

## 启动与 HTTP 冒烟

Windows 启动器使用 PID 记录、Node 命令行和绝对入口文件三重确认进程所有权；Linux 启动器
保持前台受监督运行。两者都读取 `.env`、拒绝陌生端口占用者，并使用
`out/.cn-server-build-stamp` 避免 TypeScript 增量编译造成的重复构建。

最终隔离端口冒烟使用 HTTP `18006`、TCP `18008` 和临时数据库目录：

| 检查 | HTTP 状态 |
|---|---:|
| 无认证 `/api/server/currentTime` | 401 |
| Bearer 认证 `/api/server/currentTime` | 200 |
| `/admin/` | 200 |
| `/admin/accounts` SPA fallback | 200 |
| admin 入口 JS | 200，`application/javascript; charset=utf-8` |

进程终止后两个隔离端口均已释放，临时数据库已删除。CI workflow 已加入 Windows
Node 20.19/22 矩阵；本记录只声明本地验证通过，不把尚未触发的远端 GitHub Actions 写成已通过。

## 资产治理结果

隔离根为 `D:\Q\R1`：

| 项目 | 值 |
|---|---:|
| 隔离条目 | 11 |
| 隔离字节 | 23,193,175,177 |
| exact duplicate | 2 |
| proven regenerable | 1 |
| retention expired | 7 |
| stale cache | 1 |
| 永久清除 | 0 |

隔离后完整 manifest 验证曾返回 `ok=true`，并完成小条目 `restore → resume quarantine` 演练。
最终阶段再次尝试全量重哈希，300 秒时间窗内未完成；隔离区无写操作，随后核对 manifest、
11 个目标及总字节数均未变化。永久 `purge` 保持关闭，恢复入口为 `D:\Q\R1\restore.ps1`。

## 新角色流程

`mod-tools/wf_character_flow.py` 已成为整角色包唯一入口，提供：

```text
init → status → preflight → rebase → publish → rollback
```

核心门禁包括 37/37 必需资产、2 类明确排除资源、三层一致、manifest/hash/seal、可达的
客户端基线、停止服务、live 漂移检测、原子 active 提交，以及更高版本反向增量回滚。

当前只读实测证据：

- active character release 链：`1.4.133 → 1.4.140`，7 个 release、21 个归档，无 issue；
- P0 客户端图：`1.4.0`、`1.4.102`、`1.4.133` 均可达 `1.4.140`；
- 角色 `129999 / seris_dragon_king`：36/37；
- 缺失：`character/seris_dragon_king/battle/character_detail_skill_preview.battle.amf3.deflate`；
- production 未发布；现有 3 个旧快照保持 legacy，只读保留，未伪造 digest-bound marker。

## 保留边界与后续项

以下用户 WIP 未覆盖、未还原、未提交：

```text
assets/cdndata/character.json
assets/cdndata/character_text.json
assets/character.json
assets/mana_node.json
mod-tools/docs/角色生成器-Codex任务书.md
mod-tools/docs/角色生成器方案.md
work/
```

低优先级维护项：`ts-node-dev@2.0.0` 的开发期依赖仍会提示旧 `rimraf/glob/inflight` 已弃用，
但不进入生产依赖且 audit 为 0。替换调试运行时需要单独验证 watch/inspect 行为，不在本轮用
“消除警告”为理由冒险改动开发调试语义。
