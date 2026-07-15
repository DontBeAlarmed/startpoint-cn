# AGENTS.md

StarPoint CN — 世界弹射物语(World Flipper)CN(雷霆)版服务端模拟器。
Fastify + TypeScript，CN 服务入口 `src/cn-server.ts`（端口 8001），国际服入口 `src/server.ts`（8000）。

## 当前进行中：后台管理界面重构（feature/admin-ui 分支）

完整方案见 `docs/admin-refactor-plan.md`（必读：功能清单、解耦点、里程碑、PR 策略）。

### 进度（2026-07-04）

- ✅ M0：换行符治理已在 main 完成（`.gitattributes` 全仓 LF，`*.bat` CRLF）
- ✅ M1：`admin/` 脚手架（Vite + React 18 + AntD 5 + react-router + react-query）
  - 构建产物 → `web/dist`（gitignored），cn-server 挂载在 `/admin`（含 SPA fallback，`web/dist` 不存在时自动禁用）
  - Dashboard 已接通 `GET /api/server/currentTime`；其余 4 页为占位
  - 根 package.json：`npm run build:admin` / `dev:admin`
- ✅ M2：账号/存档页 + 玩家详情页（已完成，见下）
- ✅ M3：邮件页、服务器时间卡片、种子页（已完成，见下）
- ⬜ M4：切换默认入口 + 删除旧页面（须经作者同意，独立 commit）

### M2 已完成内容

1. `web_api` 新增 JSON 端点：
   - `GET /api/server/accounts` — 账号列表 + 每账号存档数/默认存档
   - `GET /api/player/:id/detail` — 资源/角色/道具/装备/关卡进度/抽选关卡（JSON）
   - `GET /api/lookup/characters|items|equipment|quests` — 名称映射（`src/routes/web_api/lookup.ts`）
   - `POST /api/server/*` 系列按 `Accept: application/json` 分流，JSON 客户端返回 JSON，旧页面保留 redirect
2. 前端 `admin/src/pages/Accounts.tsx` — 账号表格 + 存档管理（切换/新建/克隆/改名/删除）+ 全部玩家列表
3. 前端 `admin/src/pages/PlayerDetail.tsx` — 资源内联编辑 + 角色/道具/装备/关卡/抽选关卡 Tabs + 工具操作（EX Boost/编队/邮箱/挑战重置/存档导出）
4. `admin/src/api/client.ts` 补充 `apiPatch` 方法
5. 校验规则复用 `src/routes/web_api/validation.ts`（通过现有 PATCH /:id/field 端点）

### M3 已完成内容

1. 后端补 JSON 分流（`refactor(web_api)`）：`POST /api/mail/send`、`player` 的 `clear_ex_boost`/`reset_parties`/`clear_receive_history` 按 `Accept` 分流；抽 `src/routes/web_api/http.ts` 共享 `wantsJson`
2. `admin/src/pages/Mail.tsx` — 邮件群发（附件类型 12 种 + type_id/数量联动 + 标题/正文，群发全体存档）
3. `admin/src/pages/Dashboard.tsx` — 服务器时间控制卡片（DatePicker 设置 / 重置为系统时间）
4. `admin/src/pages/Seeds.tsx` — 种子管理（模式切换 + 卡池组 + 验证/播放/测试三池 + tag 标注 + 测试种子设置）
5. `admin/src/api/client.ts` — 错误响应提取 `{ error }` 字段，提示更友好

### 待补强（非阻塞，见分析）

- PlayerDetail：账号设置字段/时间字段编辑、存档导入（`POST /:id/save` multipart）、清除接收历史按钮、表格搜索
- M4 前需：`/` 重定向到 `/admin`、删除 `web/pages`+`routes/web`+`web/public/player.js`（须作者同意）

## 工程基线（2026-07-15）

- Node.js 最低版本 `20.19.0`；根目录和 `admin/` 使用 `npm ci`，不得绕过 lockfile。
- Fastify 5 与插件版本已锁定在已验证兼容组；Vite 8/Rolldown 已启用按路由拆包和构建预算。
- Windows 启动入口为 `start-cn.bat`：从 `.env` 读取地址，校验构建新鲜度和 PID 所有权；
  端口属于陌生进程时必须拒绝，禁止按端口或进程名直接终止。
- Linux `scripts/start-cn.sh` 以前台方式运行，生命周期交给终端或 systemd；禁止恢复宽泛进程匹配。
- 新角色整包必须走 `mod-tools/wf_character_flow.py`：production 发布要求 37/37 必需资产、
  完整 manifest/hash/seal、三层一致和无漂移 preflight；普通单表修改才直接走 `wf_publish.py`。
- 资产整理必须执行 `scan → plan → preflight → quarantine → verify → restore drill`。
  隔离不等于删除，`purge` 需要单独明确授权和精确确认口令。
- 当前工程验收证据见 `docs/engineering-verification-2026-07-15.md`。

## 硬性约束

- **迁移期间旧后台零改动**：`web/pages/`、`src/routes/web/`、`web/public/` 在 M4 之前不许修改/删除
- 最终要向上游 `DontBeAlarmed/startpoint-cn` 提 PR，commit 保持小而清晰（`feat(admin):` / `refactor(web_api):`）
- 定期 `git rebase origin/main`
- 全仓 LF（`.gitattributes` 已配置）；不要提交 `web/dist`、`admin/node_modules`
- 未跟踪的 `decompile/`、`ffdec_26.2.1/`、`mod-tools/`、`pc-run/`、`弹国服/`、`assets/*.backup.json` 是本地逆向工作区，别动也别提交
- 已修改的 `assets/*.json`、`assets/cdndata/*.json`、`work/` 和未跟踪角色方案文档默认属于用户 WIP；
  未证明归属前不覆盖、不还原、不提交，也不得用 `git clean` 批量处理
- 依赖变更后根目录与 `admin/` 的 `npm audit` high/critical 必须为 0

## 常用命令

```bash
npm run verify           # 服务端/后台/Python 工具完整验收
npm run test:launcher    # Windows + Linux 启动安全门禁
npm run test:hygiene     # 仓库卫生检查器隔离测试
npm run check:hygiene    # 全仓路径安全扫描
npm run dev:cn           # 构建 + 前台启动 CN 服务(8001)
npm run dev:admin        # Vite 热更新(5173)，/api 代理到 8001
npm run build:admin      # 构建 SPA 到 web/dist，并执行 bundle budget
```

## 已知坑

- 玩家详情数据量大（角色/道具数千行），前端用 AntD Table 虚拟滚动或分页
- `@fastify/multipart` 已在 web_api 注册（存档导入用），新端点勿重复注册
- 后台已按页面 lazy-load，并由 Vite 8/Rolldown 拆包；修改依赖分组或路由后必须保留
  `admin/scripts/check-bundle.mjs` 的单 chunk 与业务路由预算，不能用提高阈值掩盖回归
