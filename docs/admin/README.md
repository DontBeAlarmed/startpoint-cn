# 管理后台

本文描述当前管理后台的运行边界。后台用于管理本地服务状态，不属于游戏客户端协议，但其构建产物是服务端启动和 Server Bundle 的必需组件。

## 唯一界面

管理后台源码位于 `admin/`，使用 React、TypeScript、Vite、Ant Design v5 和 TanStack Query，并构建到 `web/dist/`。服务端始终在 `/admin/` 挂载静态产物，为 `/admin/*` 中不带扩展名的客户端路由回退到同一个 `index.html`；`/admin/assets/*` 和带扩展名路径缺失时返回 404。访问 `/` 或 `/admin` 会进入 `/admin/`。

管理后台采用可信网络边界：只允许本机、可信内网、可信 VPN，或部署者自有认证与来源防护反向代理之后的访问。服务端不内置管理员账号、密码、Cookie、CSRF 或公网会话；任何能访问该端口的调用方都可尝试修改或删除存档、清理账号、发送邮件和修改服务器时间，且兼容时间接口仍包含会改变状态的 GET 请求。管理 HTTP 不得直接暴露到不可信公网，也不能依赖浏览器同源策略代替服务端访问控制。

`/player`、`/player/:id`、`/mail` 和 `/seeds` 仅保留到 `/admin/` 对应页面的兼容重定向。旧 `src/routes/web/` 和 `web/pages/` 已删除，不再提供服务器渲染 HTML。缺少或损坏 `web/dist/index.html`，或入口引用的本地脚本、样式、图标缺失时，运行时会在初始化阶段拒绝启动；游戏 API、管理 API和 `/healthz` 不进入 SPA fallback。服务端不再挂载通用 `/public` 静态根。

普通开发默认从本地 `web/public/comic/` 读取漫画；嵌入模式通过绝对 `COMIC_DIR` 挂载外置漫画目录，未配置时漫画不可用。图片由 `/api/index.php/comic/image` 读取，该目录不属于后台构建产物，也不进入 Server Bundle。

## 主题与 token 化样式

后台提供明、暗两套主题。顶栏右侧的 `◐` 切换按钮（`ThemeToggle`）在两套模式间翻转，选择写入 localStorage（key `starpoint-admin-theme`）；初始未选择时跟随系统 `prefers-color-scheme`。生效的模式同时写在 `<html data-theme="...">` 上，CSS 与 AntD 两侧共同读取。

主题实现分为三层：

- **AntD 主题层**（`admin/src/theme.tsx`）：暗色启用 `theme.darkAlgorithm`，并把容器、浮层、布局底色与内部描边覆盖为石墨系 token（`#161B22`、`#21262D`、`#0D1117`、`#30363D`），主色保持星黄 `#FFD335`；Tooltip 单独固定深色半透明底与浅色文字，保证两种主题下可读。
- **CSS token 层**（`admin/src/styles.css`）：`:root` 声明亮色语义变量（背景、面板、描边、墨色、属性色等），`html[data-theme="dark"]` 用暗石墨值整体覆盖，并声明 `color-scheme: dark`。页面样式只允许引用语义 token，不直接写死颜色。
- **语义徽章层**：游戏属性色映射为状态语义——风（`--wind`）=成功、水（`--water`）=信息、雷（`--thunder`）=警告、火（`--fire`）=错误/危险。`.admin-badge-ok`、`.admin-badge-info`、`.admin-badge-warn`、`.admin-badge-muted` 共用同一规格：12px/600 字重、1.5px 同色描边、6px 圆角、`2px 9px` 内边距、不折行；muted 变体使用灰墨与浅灰底。尚未覆盖错误态的页面直接沿用 AntD danger 语音，`--fire` 作为错误语义的预留 token。

响应式样式遵循 mobile-first 约定：基础规则面向窄屏书写，桌面差异通过 `@media (min-width: 768px)` 覆盖，不新增 `max-width` 形式的媒体查询；大号数字使用 `clamp()` 随视宽缩放，不锁定像素字号。数据表格的窄屏横向滚动统一由 `.admin-table-card`（card body `overflow-x: auto`）与表格 `scroll={{ x: "max-content" }}` 承担；弹框宽度使用 `min(92vw, …)` 自适应，定时资源弹框（`.scheduled-resource-modal`）在窄屏收窄到 `calc(100vw - 24px)` 并把高度交还内容自然流动。

## 移动端布局

窄屏（<768px）不是桌面布局的缩放，而是三个专项设计：

- **账号 / 存档页**：桌面表格整体替换为 `AccountsMobileView` 账号卡列表——列表与外层卡之间不留边框盒，账号之间用发丝线分隔；标题行为「账号 #N」加设备名 pill（单设备账号的设备 pill 上移到标题行，多设备在下方设备区列出）；详情区为「当前存档 / 绑定设备」两行标签值；操作键自适应等分铺满一行、不折行（icon + 文字）。点开「存档列表」后，存档卡以内联面板展开在账号列表下方（无二级页、无返回键）：当前存档徽章与存档名归拢左侧，Rank 计数靠右，存档操作同样一行铺满。
- **时间页**：大钟数字常驻为输入框、即编辑器本身。窄屏头部为左「标题 + 点击数字修改」、右「跟随系统时间」两端对齐，细分隔线后是「时间设置」小节行（左标签、右自定义模拟/跟随系统状态徽章）；数字区日期一行、时间一行居中排布，每段自带单位字，字号 `clamp(18px, 7.4vw, 32px)`。≥768px 桌面还原为单行大钟，状态徽章与跟随系统按钮并入时钟下方说明行。
- **总览页 hero**：虚拟时钟、状态徽章与五项指标在窄屏纵向堆叠且整体居中——时钟整行独占，UTC 行与徽章各自为不可拆分的换行单元；指标带退化为两列网格，运行时间独占首行、其余四项两两一行。≥768px 恢复时钟与徽章并排左对齐、指标五等分单列行。

## Web API

后台使用 `src/routes/web_api/` 提供的 JSON 或兼容表单接口，统一挂载在 `/api`：

- `/api/server`：运行状态、服务器时间、账号、存档、默认存档和账号清理；
- `/api/server/settings/gameplay`：读取和调整持久化的运行时游戏设置；
- `/api/player`：玩家详情、资源、角色、道具、关卡和重置操作；
- `/api/mail`：定向邮件发送与发送历史；
- `/api/news`：普通公告列表、创建、编辑、启停和物理删除；
- `/api/gifts`：公共礼包定义、状态机、物理删除和只读领取记录；
- `/api/lookup`：角色、道具、装备和关卡查询；
- `/api/seeds/status`：只读抽卡动画 catalog、本机 quarantine 全量计数与每 movie 20 个样本。

后台请求携带 `Accept: application/json`。新增后台功能应提供明确的 JSON 请求和响应，不在 React 页面中直接访问 SQLite。

账号页同时展示账号的设备来源映射、账号备注和清理状态。账号总览使用一次轻量玩家摘要查询并在内存中按账号分组，不随账号或存档数量产生逐账号、逐存档查询。旧设备名称接口仍用于管理员识别设备，空名称表示清除账号保留备注，不改变 `device_id -> account_id` 绑定。账号清理默认保留，可由服主配置无备注账号的超时删除；清理事务会写审计记录。玩家页的“清除 EX 能力”会同时清空该玩家所有角色的 EX 状态 ID 和能力列表，并返回实际受影响的角色数量；重复执行是成功的零修改操作，不返还任何养成材料。

每日任务和每周任务的管理员强制重置不属于新后台支持范围。周期切换仍由任务系统根据全局服务器时间处理，后台只保留“重置每日挑战”这一独立的挑战次数恢复操作。清空邮箱统一使用 `DELETE /api/player/:id/mail`，不再保留旧 SSR 专用的重复接口；账号页选择状态只存在于浏览器，不写入服务端运行状态。

## 构建边界

根 `package.json` 将 `admin` 声明为 npm workspace，根 `package-lock.json` 是服务端和后台的唯一依赖锁。可复现安装与受支持构建为：

```bash
npm ci
npm run build:server
```

根 `build` 委托给 `build:server`，且不安装依赖；`build:server` 先运行 workspace 的 `build:admin` 并校验 `web/dist/index.html`，成功后才编译和校验 CN 服务端。后台构建、入口校验或 TypeScript 编译失败都会让整体构建非零退出。`npm run build:admin` 可用于单独前端迭代，Vite 开发服务器只用于开发并通过代理访问已运行的服务端。

Server Bundle 始终打包完整 `web/dist/`，manifest 固定为 `admin.required=true`。Builder 和 verifier 都要求 `web/dist/index.html`；源码中仍存在 `web/pages` 时 Builder 会明确拒绝，Bundle 中出现该目录时 verifier 也会拒绝。运行时 `/healthz` 返回 `admin.required=true` 和 `admin.available=true`；admin 不可用时整体状态不能进入 ready。

## 当前页面与验收边界

后台目前包含总览、时间与千里眼、账号与存档、玩家详情、公告、礼包、邮件、种子管理和游戏设置九个页面。九个页面均已完成本轮界面重构：基于 CSS token 的明暗双主题（暗色采用石墨配色）、顶栏切换与 localStorage 持久化、mobile-first 的窄屏回退，以及账号与存档页的设备名称修改。检查点二的人工实测共产生九轮修正，覆盖移动端账号卡/存档卡、时间页窄屏重设计、总览 hero 堆叠居中、操作键等分铺满、设备 pill 行内改名等专项；随后的响应式收尾审计在 390/820/320 视口复测九页与三个弹框，未再发现横向溢出。

所有 React Query 写操作都提供成功和失败反馈。公告和礼包页使用服务端 revision 冲突与业务错误反馈；active 礼包只读并仅提供停止，礼包领取记录只读。源码级测试覆盖 API 契约、EX 能力清除、设备修改、表单规则、页面接线和主题切换约束。

已知的后续事项有两项：其一是五个页面的深度调整，具体范围与优先级由维护者另行讨论后立项；其二是明暗两套主题与桌面、平板、手机三端的完整验收矩阵，以及电脑浏览器的破坏性操作回归，统一在本分支 Task 13 最终 Gate 中执行。

## 运行时游戏设置

数据库 schema 8 增加单例表 `server_gameplay_settings`。这类设置属于运行中的游戏规则，不属于进程监听、文件目录或 CDN 拓扑，因此由管理后台持久化，保存后无需重启服务。

当前开放三项设置。掉落倍率允许 `1～10` 的整数，默认值为 `1`；它只影响关卡固定道具、玛纳、经验、属性素材和以太素材的数量，不改变稀有掉落池的命中概率或奖励数量。一次结算只读取一次当前设置，后台保存的新值从之后发生的结算开始生效。

“本服玩家：所有多人房间救援资格”和“本服玩家：房主救援身份”默认开启。前者只让本服真人玩家把所有多人房间视为救援来源；后者是前置条件开启后的房主自救开关。两项都不会改变其他服务器，也不发布铃铛。多人在本地节点 `/start` 成功时按当时本地设置冻结资格并写入 active quest；`/finish` 读取事务内重新取得的 stored active quest，不再按当时设置重算。变更后台设置只影响之后的成功 `/start`。A/B 节点各自持久化和读取自己的设置。失败、中止、单人结算、没有碎片映射和无资格不发奖；`attention_key` 来源继续延期。具体映射和测试边界见[多人救援碎片兼容奖励](../systems/multi-rescue-fragments.md)。

为兼容旧部署，创建该单例行时会读取一次旧环境变量 `DROP_MULTIPLIER`；未设置时写入 `1`。单例行存在后数据库即为唯一权威，后续启动不会再用环境变量覆盖或校验已有值。完成首次升级启动后可以从本地 `.env` 删除该变量，新部署的 `.env.example` 不再提供它。

`ASSET_MODE`、CDN/数据目录、HTTP/TCP 监听地址和端口等启动边界仍由环境变量或 Supervisor 控制。后台最多只读展示这类状态，不提供在线修改，避免运行中的进程写回部署配置。

总览中的服务状态直接反映服务启动时冻结的 `RuntimeConfig` 和当前 `ContentSnapshot`。Content 路径环境与网络配置在同一次解析中冻结，请求期间修改环境变量不会改变已运行进程使用的目录、监听地址、CDN 模式或内容版本；需要变更时应重启服务并重新完成内容初始化。

总览展示的 ZIP 和 Overlay 数量是当前 Snapshot 的声明值，不是对磁盘或远端 CDN 的实时探测。页面同时展示可复制的业务内容摘要和多人战斗内容摘要，便于核对实际加载内容与联机兼容身份。时间页的千里眼会按固定 Repository 缓存静态时间线和搜索索引，但“当前开放卡池”仍在每次请求时使用全局服务器时间重新计算。

因此：

- 自动测试通过不等于后台已经完成人工验收；
- 修改存档、删除账号、批量邮件等操作应使用测试数据验证；
- 当前验收状态统一记录在[支持矩阵](../status/support-matrix.md)和[测试进度](../status/test-progress.md)。

嵌入式打包规则见[Server Bundle](../runtime/server-bundle.md)。

## 待执行专项

- [壳内 WebView 存档导出无反应（服务端侧修复）](webview-save-export-fix.md)：admin 前端 + web_api 的待执行交接文档，壳（launcher）侧零改动。
- [防御机制死锁残留自愈交接（服务端侧）](stale-guard-self-heal-handoff.md)：sync.lock / 凭据锁的 stale-guard 自愈修复交接文档，待服务端侧执行。
