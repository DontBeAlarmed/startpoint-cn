# D27 Content Runtime Index 与 Typed Adapters

状态：实施与 whole-range review 完成（C1–C6）。DEBT-T09 已按退出条件关闭，`assets.ts` 跨域 facade 与 `getRuntimeContentTableSync(table,bundled)` 迁移 facade 均已删除；D27 作为 Gate D 的第一个 checkpoint 已完成，Gate D 随 D28 C7 closure 收口。

## 目标

D27 固定服务端 Content 的只读输入边界：底层只有一个进程生命周期内不可变的 runtime index，各业务领域通过自己的 typed adapter 读取静态事实。Content 不拥有玩家状态、数据库事务、错误协议或客户端路由。

## Runtime Index

现有 `ContentRepository` 已经承担 runtime index：

- 启动时从同一个 release snapshot 或 bundled runtime root 加载全部注册表；
- 每张表只进入一个深度冻结的对象集合；
- 同一表查询返回同一对象引用，查询不重复读文件；
- catalog、repository 与 archive source 固定在同一个 snapshot identity；
- release manifest、scope、converter version、source closure 与对象 digest 必须完整匹配；
- 缺失 current 才允许使用 bundled runtime，损坏 current/manifest/object 必须失败。

D27 复用该实现，不建立第二份全表索引，也不在启动时预构建全部领域 catalog。生产 snapshot 在一次进程生命周期内固定；Content 热替换属于未来独立设计，不在本 Gate 实现。

## Typed Adapter

raw table index 只供 Content 基础设施和声明的 adapter builder 使用。业务 owner 只消费有限领域 read model：

| 领域 | Typed read model | 不拥有 |
|---|---|---|
| Item | policy、上限、可售、有效期 | Inventory/Mail 写入与处置事务 |
| Shop | product、cost、stock/period metadata | 购买事务与玩家库存 |
| Gacha | banner、pool、campaign、exchange rate | payment、draw、history、prize writer |
| Star Crumb / Bond | 各自 product/list/resolve | 通用 Exchange 生命周期 |
| Character Growth | rarity、level、board、node、race 静态事实 | 玩家 Character aggregate |
| Mission | MissionCatalog、ActiveMissionPlan、有限 fact tables | 来源领域状态与奖励资产 |
| Quest / Event | quest、entry、reward、window/linkage descriptor | active quest、Single/Multi、各 Event mode 状态 |
| Admin | lookup/validation read model | 玩家客户端 owner 与 save restore 事务 |
| Save / Restore | 各域纯 integrity parser/query | 玩家 route、普通 Admin CRUD 与导入总事务 |
| Load compatibility | 登录修复/维护所需有限静态 policy | 通用 Content owner 或 Save 事务 |
| Transport metadata | CDN/release/version/digest/capability | 业务表、玩家状态和 Multi session |

领域 adapter 可以在内部解释多张 raw 表，并按 repository object identity 使用 `WeakMap` 缓存。两个 snapshot 即使版本字符串相同也不能共享派生 catalog；旧 snapshot 不需要主动清缓存。

## 初始化与失败语义

正式启动必须先完成 Content 初始化，再开放 HTTP、Multi 与 Modes。production strict accessor（`getStrictRuntimeContentTableSync`）在未初始化时抛 `CONTENT_SNAPSHOT_NOT_INITIALIZED`，不接收 bundled fallback。D27 期间曾以 `getRuntimeContentTableSync(table,bundled)` 作为同 Gate 内的迁移 facade，各领域子波次迁走 consumer 后已在 C6 删除该生产签名。初始化后的缺表、损坏表或关系不完整必须由对应 typed adapter fail closed；不得退回旧 bundled 内容继续发奖、购买、抽卡或推进任务。

测试中的 bundled 数据必须通过显式 test repository/provider 或 typed adapter 注入。生产 singleton 替换只在仍保护 snapshot 生命周期本身的低层测试中保留（由 `content_runtime_test_fixture_authority` guard 按职责 allowlist 管理），不能成为普通业务测试默认做法。

## 跨域 facade 与 Mode API

`src/lib/assets.ts` 曾同时承载 Quest、Reward、Character/Growth、Gacha、Shop、Config、Item、Equipment 与 Event 读取。D27 按领域子波次迁移其全部实际生产 export 后，C6 删除了该 barrel；没有保留同等能力的跨域生产 facade，也没有换名复制成 `ContentService`。

`ModeHost.table<T>(string)` 是 Mode API v1 的公开契约，不能在版本号不变时删除。D27 将其作为 breaking change：Mode API v2（`MODE_API_VERSION=2`）只暴露实际 hook 所需有限命名查询（`host.content`）；v1 manifest 在模块取得 host 前 fail closed 并记录不兼容，不提供仍可读任意注册表的 v1 shim。

Admin lookup/validation、Save/restore integrity、Load compatibility/maintenance 与 CDN/Multi transport metadata 分别保留自己的权限、外层事务、错误和 session 语义。它们可以复用领域纯查询或 parser，但不合并为玩家业务 owner。

## 明确排除

- `ContentService.getTable(name)` 或按任意 kind/id 返回任意对象的万能服务；
- 包含 134 张表字段的总接口或第二份全量数据 copy；
- Content 层读取/写入 Player、Account、Inventory、Mail、Mission progress 或 active quest；
- 根据 URL、route 名称、Single/Multi 身份或 Event mode 选择业务 handler；
- 合并 Shop、Gacha、Mission、Growth、Quest/Event 的业务生命周期；
- 为 schema-only、无 actual consumer 的客户端不可达分类补造 E2E。

## DEBT-T09（已关闭）

重复 snapshot 初始化 fixture 和 source-shape 白名单只能在替代边界成立后删除。退出条件与关闭证据：

1. raw index contract、identity、release pinning 与 corruption fail-closed 有行为测试——`content_runtime_index_contract`（strict pre-init/错误传播/幂等 restore）、`content_snapshot_configuration`、`content_runtime_mission_tables`（broken release 不回退）、`content_runtime_endpoint_tables`（损坏 fail-closed）；
2. D16–D26 actual consumer 都有领域 typed adapter 代表——C2–C4 各子波次全部提交（见仓库外 consumer ledger 实施状态）；
3. 业务层 raw reader 由最小依赖方向 guard 管理——`content_runtime_boundary`（strict accessor builder allowlist）、`content_runtime_authority`、`content_runtime_direct_tables`、`content_runtime_test_fixture_authority`（业务测试 fixture 统一安装 guard）；
4. 被删除的 fixture 已由独立 provider/typed adapter 测试替代——`content_runtime_table.test.cjs` 随迁移 facade 删除，其快照优先/pre-init/错误传播覆盖由改写后的 `content_runtime_index_contract` 承担；重复 snapshot 安装由统一 helper（`content-snapshot-fixture`/bundled snapshot helpers）替代，业务测试直接赋值清零；
5. actual enum、Missing-runtime、CDN transport、Multi transport/session 测试完整保留（D27 各波次未触碰）；
6. focused regression 与性能 admission 通过（C6 全量受影响组与 perf admission 绿，日志见仓库外进度材料）；
7. 仓库外 consumer ledger 无未分类/未处置调用点，Actual Missing-runtime closure 表中的应实现项都有真实生产 consumer。

## 性能准入

- 不增加 raw 表或 unique object 的文件读取次数；
- 不复制第二份全表数据；
- typed catalog 默认按需、每 repository identity 最多构建一次；
- hot lookup 维持 O(1) 或领域索引复杂度；
- Shop、Gacha、Mission、Battle/Event 现有性能基线不得退化；
- 同机、同 Node、同 snapshot/profile 各运行三轮取中位数；冷加载、RSS/heap、100k hot lookup 相对 D27_BASE 回归不得超过 20%，lookup 绝对值保持 `<500ms`；环境不同只观察。
- unique object/table read、无第二份全表 copy、每 repository identity 每 adapter 最多构建一次是硬结构门禁，不因机器不同放宽。
- 具体 profile 与实现前冻结阈值记录在仓库外 D27 性能协议；只有实测后才报告收益。

## Gate 边界

D27 只收口 Content 输入，不改变业务状态和客户端响应。D28 将在已稳定 owner result 与 typed Content 输入之上完成 Common Response 字段级 projector。Gate D 的唯一 broad、整段 final review 与服务重启在 D28 末尾执行。
