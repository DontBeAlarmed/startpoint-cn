# 后台管理界面重构方案（React + Vite + Ant Design）

> 状态：方案 | 日期：2026-07-04 | 范围：8001 端口 Web 管理面板

## 1. 现状分析

### 1.1 架构

```
cn-server.ts (8001)
├── src/routes/web/      页面层：读 HTML + {{占位符}} 字符串替换，服务端拼接 <tr> 等 HTML
├── src/routes/web_api/  API 层：/api/player /api/server /api/mail /api/seeds（已较 REST 化）
└── web/
    ├── pages/*.html     5 个多页应用页面（index/players/player/mail/seeds）
    └── public/          tailwind.css + player.js（少量原生 fetch）
```

### 1.2 交互不流畅的根因

1. **整页刷新**：大部分操作是 `<form method="post">` → 302 跳转 → 重新 SSR 整页。
2. **服务端字符串拼 HTML**：`web/player.ts`（296 行）把角色/道具/装备/关卡全部拼成 HTML 一次输出，玩家数据大时首屏慢。
3. **无状态管理**：搜索、滚动位置、展开状态在每次操作后丢失。

### 1.3 功能清单（= SPA 页面规划）

| 模块 | 现有页面 | 现有 API | 备注 |
|---|---|---|---|
| 服务器时间 | index.html | GET/POST `/api/server/currentTime` `resetTime` `time` | 全局/按存档时间偏移 |
| 账号/存档管理 | players.html | `/api/server/selectAccount` `activateSave` `newSave` `deleteSave` `deleteAccount` `renameSave` `cloneSave` | 依赖服务端内存态 `selectedAccountId` |
| 玩家详情 | player.html + player.js | `/api/player/*`（字段编辑、角色/道具增删、关卡进度/抽选关卡删除、存档导入导出、清邮件/EX/编队/挑战次数） | 最复杂页 |
| 邮件群发 | mail.html | POST `/api/mail/send`（multipart） | |
| 种子管理 | seeds.html | `/api/seeds/stats` `list` `mode` `tag` `test-seed` | 页内已有 fetch 轮询 |

### 1.4 耦合点（解耦目标）

1. **SSR 与数据逻辑耦合**：`routes/web/player.ts` 直接 import `wdfpData` 的 sync 查询 + `character_table.json` 等 lookup，再拼 HTML。→ 数据部分抽成 JSON API，HTML 渲染移到前端。
2. **API 与页面导航耦合**：`web_api/server.ts` 多数端点处理完 `reply.redirect('/player')`。→ 增加 JSON 响应模式（按 `Accept` 头或新路径），SPA 用 JSON，旧页面期间保留 redirect。
3. **lookup 数据注入 HTML**：角色名/道具名/关卡名在服务端替换进模板。→ 新增只读 lookup API（`/api/lookup/characters|items|equipment|quests`），前端缓存。
4. **服务端全局单例 `activeAccount`**：`selectedAccountId` 存内存，页面渲染依赖它。→ SPA 改为 URL 参数驱动（`/admin/accounts/:id`），服务端态仅保留给游戏客户端用。
5. **validation.ts 白名单**：与 API 层解耦良好，保持不动，SPA 直接受益。

## 2. 目标架构

```
admin/                     ← 新增，React SPA 源码（独立 package.json）
├── src/
│   ├── pages/            Dashboard / Accounts / PlayerDetail / Mail / Seeds
│   ├── api/              fetch 封装（与 web_api 一一对应）
│   └── components/
├── vite.config.ts        dev: proxy /api → http://localhost:8001
└── package.json          react + antd + react-router + @tanstack/react-query

web/dist/                  ← admin 构建产物（git 忽略或 CI 构建）
src/routes/web_api/        ← 唯一数据出口，全 JSON 化
src/routes/web/            ← 迁移期保留，逐页删除
```

- **构建**：`npm run build:admin` → `web/dist`，cn-server 用 `@fastify/static` 挂到 `/admin`，SPA fallback 到 `index.html`。
- **开发**：Vite dev server (5173) 代理 `/api`，改前端不需重启后端。
- **依赖隔离**：admin 有独立 `package.json`，不污染服务端依赖；根 `package.json` 加 workspace 或简单 script 调用。

## 3. 渐进式迁移里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 | 换行符治理（见 §4.1）；建 `feature/admin-ui` 分支 | `git status` 干净 |
| M1 | admin/ 脚手架 + `/admin` 托管 + lookup API + `web_api` JSON 化补齐（player 详情 GET JSON、server 端点 JSON 响应） | `/admin` 可访问空壳，curl 拿到 JSON |
| M2 | 账号/存档页 + 玩家详情页（最高价值、最复杂） | 与旧页功能对齐，操作不整页刷新 |
| M3 | 种子页（含轮询→定时 refetch）、邮件页、服务器时间卡片 | 5 页全部可用 |
| M4 | `/` 重定向到 `/admin`，删 `web/pages`、`routes/web`、`web/public/player.js`，清理 tailwind 旧配置 | 旧代码删除，回归测试 |

**迁移期间旧页面完全不动**：`web/pages`、`routes/web`、`web/public` 在 M1–M3 期间零改动，SPA 只挂 `/admin` 并行运行。仅在 M4（SPA 全部页面验收通过后）一次性切换与删除。

## 4. 合并与提交 PR（feature 分支 + 单次合并）

### 4.1 前置：先在 main 治理换行符（关键）

当前工作区 378 个文件因 CRLF/LF 全量"被修改"。若不先处理，feature 分支合并时会全文件冲突。**在切分支前**，单独在 main 提交：

```bash
# 1. 先单独提交真实改动
git add assets/confirmed_seeds.json package-lock.json && git commit -m "chore: ..."
# 2. 加 .gitattributes（* text=auto eol=lf；*.bat eol=crlf）
# 3. 一次性 normalize
git add --renormalize . && git commit -m "chore: normalize line endings"
```

### 4.2 分支流程

```bash
git checkout -b feature/admin-ui   # 基于治理后的 main
# M1..M4 按里程碑提交，commit 前缀 feat(admin): / refactor(web_api):
git fetch && git rebase origin/main   # 定期同步，避免最终大冲突
# 完成后：
git checkout main && git merge --no-ff feature/admin-ui
```

### 4.3 向远程作者提交 PR

当前 origin 为 `DontBeAlarmed/startpoint-cn`。流程：

```bash
git push -u origin feature/admin-ui
# GitHub 上发起 PR: feature/admin-ui → main
```

若无该仓库写权限，先 fork 到自己账号，push 到 fork 后跨仓库发 PR。

PR 建议：

- **拆两个 PR 更易被接受**：PR#1 = 换行符治理 + `.gitattributes`（纯机械改动，先合）；PR#2 = admin SPA 重构。避免 419 万行噪音淹没真实改动。
- PR 描述附带：动机（旧页面整页刷新卡顿）、架构图（§2）、截图/GIF 对比、"旧页面在本 PR 中未删除/最后一个 commit 才删除"的说明，方便作者分阶段 review。
- M4 的删除旧页面可作为 PR 内独立 commit 或第三个 PR，由作者决定何时切换。

### 4.4 降低合并冲突的约束

- 前端代码全部在新目录 `admin/`，与现有代码零交集。
- 服务端改动集中在 `src/routes/web_api/`（加 JSON 端点为主，少改已有行为）。
- `routes/web/` 旧文件只在 M4 一次性删除，期间不修改。
- `web/dist` 加入 `.gitignore`，仓库不提交构建产物；部署脚本（`start-cn.sh` 等）加 build 步骤。
