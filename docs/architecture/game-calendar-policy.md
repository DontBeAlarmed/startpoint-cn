# 游戏业务日历策略

## 目标与边界

服务端必须把三类时间语义分开：

1. Unix timestamp、数据库 ISO 时间和网络 epoch 表示绝对 UTC 时刻，不附加业务时区；
2. 真实流逝时间和运行时超时使用单调或系统真实时钟，不参与游戏日历换算；
3. 无时区主数据字符串、客户端日历显示、业务日、业务周和业务月份使用一个进程级游戏日历策略。

`starpoint-cn` 的默认游戏日历偏移为 UTC+8。CN 1.8.1 客户端虽然保留 `JST`、`JapanStandardDateTime` 等上游命名，但启动时把 `AppTime_Impl_.JAPAN_STANDARD_OFFSET_MILLISECONDS` 设置为 `28800000`。卡池、第二玛纳板和玩家履历等生成类均调用 `ParseTools.parseJstDataToUtcTime()`，最终使用该运行时偏移，因此不能按符号名机械解释为 UTC+9。

游戏日历是客户端和主数据版本的属性，不是玩家地理位置属性。同一服务进程中的所有玩家共享一个冻结策略；玩家所在国家、浏览器时区和服务器操作系统 `TZ` 都不得改变活动窗口或周期边界。

## 配置契约

启动环境变量为：

```text
GAME_CALENDAR_UTC_OFFSET_MINUTES=480
```

- 缺省值为 `480`，保持 CN 服务器兼容；
- 值必须是规范十进制有符号整数，范围为 `-840..840` 分钟；
- 使用分钟而不是小时，允许固定的半小时或 45 分钟偏移；
- 固定偏移不应用夏令时，不能接受 IANA 时区名称；
- 配置只在进程启动时解析一次，解析失败必须在监听端口或写入运行数据前终止启动；
- 运行期间不可通过管理 API 修改。

`CnRuntimeConfig` 保存解析后的 `gameCalendarUtcOffsetMinutes`。Content Sync CLI 使用同一纯解析函数读取配置，不能各自实现一套环境变量校验。

非默认偏移只适用于与该偏移匹配的客户端和主数据。把 CN 客户端连接到 UTC+9 服务，或者仅按服主所在地选择偏移，均不属于受支持用法。

## 模块职责

新增所有权中立的纯时间模块 `src/time/game-calendar.ts`。它不读取 `process.env`、数据库、Content Snapshot 或系统本地时区，只提供不可变策略和值转换：

```ts
interface GameCalendarPolicy {
    readonly utcOffsetMinutes: number
    parseMasterTimestamp(value: string): number
    formatMasterTimestamp(epochMs: number): string
    getDayBucket(epochMs: number, resetHour?: number): CalendarDayBucket
    getWeekBucket(epochMs: number, resetHour?: number): CalendarWeekBucket
    getMonth(epochMs: number): number
}

function createGameCalendarPolicy(utcOffsetMinutes: number): GameCalendarPolicy
```

`parseMasterTimestamp()` 只接受严格的 `YYYY-MM-DD HH:mm:ss`，逐字段验证真实日历日期，以 UTC 字段运算减去固定偏移。`formatMasterTimestamp()` 执行精确反向转换并输出同一 canonical 格式。两者必须对合法秒精度值往返一致，且结果不受宿主 `TZ` 影响。

业务模块不得再自行出现 `8 * 60 * 60`、`9 * 60 * 60`、`hour - 8/9`、无时区 `new Date(string)`、`toDateString()` 或依赖宿主本地日期字段的游戏日历逻辑。领域专用错误类型可以包装统一解析错误，但不能重新实现偏移换算。

生产运行时使用一个只初始化一次的策略提供器。生命周期必须在初始化 Content Snapshot、注册路由和处理请求之前，用已冻结的 `CnRuntimeConfig` 配置该提供器。纯转换器和单元测试优先显式接收 `GameCalendarPolicy`，避免通过可变全局切换测试时区。

## Content Release 一致性

部分 Content converter 会把主数据日历字符串预计算为 epoch，另一些直接表保留原始字符串并在运行时解析。两条路径必须使用同一个偏移，否则同一 Release 内会出现互相矛盾的开放期。

Content Release manifest 增加 `gameCalendarUtcOffsetMinutes`：

- 新 Release 始终写入该字段；
- Content Sync 的复用判定把该字段作为转换身份的一部分；
- 配置变化必须产生新 Release，不能复用旧偏移生成的对象；
- 服务启动时要求当前 RuntimeConfig 与 active Release 字段一致，不一致时 fail closed；
- 旧 manifest 缺少字段时只按历史 CN 默认值 `480` 读取，保持已有 CN 部署可升级；旧 manifest 不得在非默认偏移下使用。

converterVersion 继续描述转换代码和输出 shape。单纯的偏移配置变化由 manifest 身份处理，不为每个偏移人为增加 converterVersion。

直接读取原始时间字符串的 catalog 同样使用 active 游戏日历策略。这样预计算表和运行时表在同一服务中具有一致语义。

## 迁移范围

迁移覆盖所有游戏业务日历换算，而不只覆盖当前四个 UTC+9：

- 卡池 banner、ticket、campaign 和玩家 Comeback/Stars 周期的解析与反向格式化；
- 第二玛纳板和玩家履历开放期；
- stamina、reward、login bonus、mission、quest、shop、box gacha、bond token、character election 等主数据开放期；
- 每日/每周 reset bucket、业务月份和新闻客户端日历字符串；
- Content converter 中预计算 epoch 的 UTC+8 逻辑。

迁移不改变以下语义：

- SQLite 中保存的 ISO 时间与 Unix 秒/毫秒；
- `getRealNow*()`、`getVirtualNow*()` 的绝对时刻表示；
- TCP 心跳、租约、超时、清理和性能计时；
- 带显式 offset 的 ISO-8601 管理输入；
- 玩家设备或浏览器的本地时区。

`DAILY_RESET_HOUR` 继续表示游戏日历中的小时。例如默认策略 `480`、reset hour `5` 表示北京时间 05:00。修改游戏日历偏移不会修改 reset hour 的数值。

`cn/load.ts` 中额外的 `toDateString()` 对齐分支在 `dailyResetPlayerDataSync()` 已更新 `lastLoginTime` 后没有独立业务作用，应删除；日切只保留统一策略下的 reset bucket 判断。

## 兼容与失败策略

- 默认配置下，除纠正现有 UTC+9 和宿主 `TZ` 漂移外，已正确使用 UTC+8 的行为保持不变；
- 非法主数据日期继续在 Content 构建或 catalog 准入阶段 fail closed；
- Release 偏移不匹配属于启动配置错误，不允许带着部分旧内容继续运行；
- 配置不进入玩家存档，导入、克隆和设备绑定不改变游戏日历；
- 管理端展示配置值和 active Release 值，便于诊断，但不提供在线编辑；
- 不为历史错误窗口补写玩家记录或回滚已经发生的结算。

## 已知纠正

CN 默认 `480` 下需要纠正的现有行为包括：

- `gacha-catalog/period.ts` 的 UTC+9 解析；
- `gacha-owner/player-period.ts` 的 UTC+9 反向格式化；
- `character-growth-content.ts` 的第二玛纳板 UTC+9 开放期；
- `player-history-catalog.ts` 的 UTC+9 履历期；
- `stamina-campaign.ts` 依赖宿主 `TZ` 的无时区 `Date` 解析；
- `cn/load.ts` 依赖宿主 `TZ` 的 `toDateString()` 分支；
- `gacha-owner-gate.md` 和二板测试中把 CN `JST` 符号名误写为真实 UTC+9 的旧结论。

例如 CN 主数据 `2024-09-05 12:00:00` 必须转换为 `2024-09-05T04:00:00.000Z`，而不是 UTC+9 产生的 `03:00:00.000Z`。

## 验收条件

自动验证至少覆盖：

- 配置缺省、合法正负偏移、边界和非法输入；
- leap year、月末、非法日期、canonical 格式和 parse/format 往返；
- 在不同宿主 `TZ` 下获得相同结果；
- CN `480` 的卡池、二板、履历、体力活动和每日 05:00 精确边界；
- 非默认偏移的至少一个主数据解析、反向格式化、业务日和业务月场景；
- Content Release 偏移写入、旧 manifest 的 `480` 兼容、偏移变化不复用和启动不匹配拒绝；
- 所有生产源码不再含领域私有 UTC+8/UTC+9 日历算术或无时区本地日期解析；
- 现有时间、Content Sync、卡池、任务、商店、二板、履历、体力和登录回归；
- TypeScript、文档、仓库卫生与受支持构建。

客户端人工验收至少覆盖卡池最后一小时、第二玛纳板开放整点、履历期起止、体力减免边界和北京时间 05:00 日切。非默认偏移只有配套客户端与主数据时才可声明受支持。

## 实施状态

上述架构契约已落地，当前已合并的模块与验证：

- 纯策略与提供器：`src/time/game-calendar.ts`（`createGameCalendarPolicy()`、canonical 主数据解析/反向格式化、业务日/周/月 bucket）与 `src/time/game-calendar-provider.ts`（进程级一次性冻结提供器，`getGameCalendar()` 为统一读取入口）。
- 启动冻结：`CnRuntimeConfig.gameCalendarUtcOffsetMinutes` 在 `src/runtime/config.ts` 解析校验，`src/cn-server.ts` 在 Content Snapshot 初始化与路由注册前注入 `productionGameCalendarProvider`。
- Content Release 身份：manifest 字段 `gameCalendarUtcOffsetMinutes`（`src/content/sync/schema.ts`）、偏移变化触发重建的复用判定（`src/content/sync/engine.ts`）、读取同一配置的 Content Sync CLI（`src/content/sync/cli.ts`）、启动不匹配 fail closed 的加载防线（`src/content/runtime/content-repository.ts`）；bundled fallback 固定报告 `480`。
- Converter 通道：预计算 epoch 的转换器统一通过 `ContentConverterContext.gameCalendar`（`src/content/converters/context.ts` 及 quest、box-gacha、reward、election 等转换器）。
- 运行时业务迁移：`time-utils`、商店 period、box gacha、bond token、character election、mission（catalog、event-entry-facts、active-plan-builder）、item inventory、reward campaign、news、pass card、admin clairvoyance、gacha catalog/owner period、character growth、player history、stamina campaign，以及 `cn/load.ts` 删除 `toDateString()` 日切分支。
- 只读可观测性：`/api/server/status` 的 `cdn.gameCalendar` 同时返回 `configuredUtcOffsetMinutes` 与 `contentUtcOffsetMinutes`（`src/lib/admin-content-status.ts`、`src/routes/web_api/server.ts`）；管理后台总览展示两个值并在不一致时显示警示标签，无在线编辑入口。
- 防回归与验证：`tools/game_calendar_source_guard.test.cjs` 用 `node:fs` 递归扫描全部生产 `.ts` 文件（仅对固定偏移实现模式豁免 `src/time/game-calendar.ts` 本身），拒绝私有 UTC+8/UTC+9 算术、无时区主数据追加偏移、宿主本地 Date 字段和私有 canonical 时间戳正则；另有策略、提供器、启动配置、Release 身份、converter、业务边界和后台状态的专项测试覆盖上文验收条件。
