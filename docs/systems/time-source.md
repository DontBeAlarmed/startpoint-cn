# 服务端时间来源

服务端运行时同时维护两种时间，业务代码必须先确定语义，再选择时间入口。不要在业务模块中直接调用 `Date.now()` 或无参数 `new Date()`。

## 权威来源与可控边界

真实时间的唯一业务入口是 `src/runtime/time/game-time.ts` 中的 `getRealNowMs()` / `getRealNow()`；它读取操作系统时钟，不叠加服务端日期偏移。虚拟时间由同一文件的 `getVirtualNowMs()` / `getVirtualNow()` 根据全局偏移生成。`src/utils.ts` 中保留的 `getServerTime()` / `getServerDate()` 是旧协议兼容入口，内部时间源属于时间服务层，业务代码不得再自行读取系统时钟。

全局虚拟时间由 `ServerTimeService` 管理，状态持久化在运行时数据目录的 `server-time.json`，可通过管理接口导入、导出、设置绝对时间或恢复系统时间；旧的 `active_account.json` 只作为迁移兼容来源。没有已保存状态时使用 `2024-08-14T12:00:00Z` 作为初始虚拟时间基准。服务端没有第二份按存档生效的运行时偏移，存档中的 `time_offset` 仅保留为兼容字段。

时间服务层自身可以直接触碰系统时钟，运行时文件名、锁、缓存和可注入组件的默认时钟也统一指向 `getRealNowMs()`。除这些底层入口外，业务模块不得出现直接 `Date.now()` 或无参数 `new Date()`。

## 时间入口

| 入口 | 含义 | 适用范围 |
| --- | --- | --- |
| `getRealNow()` / `getRealNowMs()` | 操作系统真实时间 | 体力自然恢复、每日挑战次数、每日登录、商店库存刷新、账号清理、登录/过期、资料卡完成事实 |
| `getVirtualNow()` / `getVirtualNowMs()` | 真实时间加服务端时间偏移 | 卡池、活动开放、任务业务判定、客户端 `servertime`、游戏内容日期 |
| `getGameTimeContext()` | 一次操作同时捕获真实和虚拟时间 | 同一请求同时需要两种时间时，避免分别取样造成边界不一致 |
| `getServerDate()` / `getServerTime()` | 兼容旧业务的虚拟时间入口 | 现有虚拟时间业务和协议响应；新代码优先使用 `getVirtualNow()` 或 `getGameTimeContext()` |

## 资料卡完成事实

资料卡会被分享到真实世界，因此“首次完成日期”记录真实时间。虚拟时间只决定该内容是否开放、以及结算是否满足条件；完成事实写入时使用同一次操作捕获的 `GameTimeContext.realNow`。

旧存档没有历史事实时返回“未记录”。不能使用角色 `update_time`、存档导入时间或当前虚拟时间推测历史完成日期。

## 运行时技术时间

TCP 心跳、Hub 会话、房间清理、发送队列背压和临时文件名使用真实流逝时间。这些时间不属于游戏业务时间，可以保留真实时钟，但应通过 `getRealNowMs()` 或依赖注入的 `now()` 获取，以便测试控制。

## 游戏日历口径风险的修复状态

定向审计确认 CN 客户端把无时区主数据时间按 UTC+8 解释：`boot_ffc6.as` 将 `JAPAN_STANDARD_OFFSET_MILLISECONDS` 设为 `28800000`，`ParseTools.parseDateTime()` 从 UTC 构造值中减去该偏移。修复前，服务端 `src/lib/gacha-catalog/period.ts` 固定减去 UTC+9，对同一个 `2024-08-14 20:00:00` 比客户端语义提前一小时，造成卡池、兑换和玩家周期边界整体漂移。

上述发现已由[游戏业务日历策略](../architecture/game-calendar-policy.md)统一修复：`src/time/game-calendar.ts` 提供按启动配置冻结的固定偏移策略（CN 默认 `480`，即 UTC+8），`gacha-catalog/period.ts` 的 UTC+9 解析、`stamina-campaign.ts` 依赖宿主 `TZ` 的无时区解析和 `cn/load.ts` 依赖宿主 `TZ` 的 `toDateString()` 日切比较都已迁移或删除。业务模块不再自行实现日历算术，解析结果不再随进程 `TZ` 改变。

该修复只改变无时区主数据字符串与业务日/周/月边界的解释。SQLite 中保存的 ISO 时间、Unix 秒/毫秒和网络 epoch 仍然表示绝对 UTC 时刻，不做日历换算；这一 UTC 存储口径与游戏日历口径的区分贯穿上文的全部时间入口。

## 可控性要求

- 时间偏移由服务端时间服务统一保存和恢复，业务模块不得自行维护第二份偏移。
- 需要测试时间跳转时，通过时间服务或 `setServerTime`/`setServerTimeOffset` 注入，不修改系统时钟。
- 同一请求内同时涉及真实时间和虚拟时间时，只创建一次 `getGameTimeContext()`。
- 新增时间判断必须在代码审查中注明使用真实时间、虚拟时间或运行时技术时间。
