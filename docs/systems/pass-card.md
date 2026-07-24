# 修行之道（Pass Card）

## 职责边界

修行之道包含两条独立业务链：

1. category 6、7、8 分别表示 PassDaily、PassWeek、PassEvent。任务完成后由通用任务结算直接发放 Pass 点数。
2. `Pass_card/get_pass_card` 和 `Pass_card/receive_all` 管理等级、免费/付费双轨奖励及领取记录，不产生任务进度。

两条链以 Pass `event_id` 隔离。任务请求只发送 `{category}`，不携带 `event_id`；服务端必须按国服主数据开放期选择当前任务，再由任务定义回连活动，不能把不同期次的点数或领奖状态混在一起。

## 主数据

官方 CN 1.4.54 资源包含完整 Pass 主数据：

| 表 | 数量 | 服务端资产 |
|---|---:|---|
| 日常任务/奖励 | 76 / 76 | `mission_pass_daily*.json` |
| 周常任务/奖励 | 76 / 76 | `mission_pass_week*.json` |
| 活动任务/奖励 | 115 / 115 | `mission_pass_event*.json` |
| Pass 活动 | 19 | `pass_card_event.json` |
| 等级奖励 | 1140 | `pass_card_reward.json` |

`npm run content:pass` 从 `wf-assets-cn/orderedmap/pass_card/` 生成上述资产。脚本支持 `WF_ASSETS_CN_DIR`，也能从普通检出和 `.worktrees/` 工作树定位工作区级 `wf-assets-cn`。生成前会校验资源根目录的 `VERSION` 精确为 `1.4.54`；缺失或其他版本均受控失败。脚本只做 JSON 结构转换，不修补、复用或猜测 CDN 内容。

三张任务表的关键列相同：`row[0]` 为活动 ID，`row[1]` 为字符串 pattern，`row[3]` 为 pattern type，`row[26]/row[27]` 为开放起止时间。奖励表外层键为任务 ID、内层键为阶段；当前每条 Pass 任务只有阶段 1，奖励全部是 kind 7 的 Pass 点数。

国服任务时间按 UTC+8 解释。category 6 在每日 05:00 重置，category 7 在周一 05:00 重置，category 8 只受各任务开放期约束。

## 进度与结算

- category 6 已接入单人成功、协力成功、冲刺和体力四类每日事实。
- category 7 已接入 type 16 协力成功和 type 39 体力；type 20 救援请求与 type 85 战斗表情缺少完整权威事实，继续使用持久化值，不从其他计数猜测。
- category 8 的累计登录按活动建立基线；type 16 指定协力关卡按 quest range、关卡类别和开放期逐场记录。
- category 8 的 6 条 type 23 指定 `battle_kind` 任务尚未启用自动事实，避免把不相干关卡计入。

Pass 周常使用 `pass-week:<event_id>` 专属快照。新存档和玩家跨日登录时会为当前活动建立基线，跨周时刷新；如果旧存档第一次接触 Pass 时缺少基线，服务端以当时状态建立保守基线，避免把活动开放前的周行为误算为本期进度。活动登录基线也在建档和每日登录时维护，不依赖玩家先打开 Pass 页面。跨日时的登录时间、登录天数、Pass 基线、日周任务和其他每日重置写入处于同一 SQLite 事务，任一步失败都会整体回滚并允许同一次登录重试。

任务阶段、领取状态、Pass 点数与原业务奖励处在同一 SQLite 事务。点数按活动 `threshold_point` 封顶；重复进入任务页或重复战斗不会重复发点。

## 等级奖励

数据库版本 7 增加：

- `players_pass_cards`：每个玩家、每个活动的点数、购买状态和登录基线；
- `players_pass_card_rewards`：每个等级奖励的免费轨与付费轨领取状态。

`get_pass_card` 返回真实 `point`、`is_buy` 和 `all_received_record`。两个 Pass 路由都只接受服务器时间下正在开放的活动；`receive_all` 在发奖前统一校验活动归属、当前等级、购买状态和请求数组，重复领取为空操作，任一奖励失败时整批回滚。

当前没有实现 Pass 购买流程，`is_buy` 默认为 `false`，因此付费轨不能领取。客户端验收还需覆盖任务提示、日/周重置、指定活动关卡、等级奖励弹窗和重启持久化。

## 自动测试

- `tools/mission_pass.test.cjs`：主数据、开放期、周期计算和阶段奖励；
- `tools/mission_pass_battle_facts.test.cjs`：指定协力关卡、失败和错误范围隔离；
- `tools/mission_pass_content.test.cjs`：主数据生成、资源版本校验与普通检出/工作树路径定位；
- `tools/mission_pass_route.test.cjs`：三分类协议、自动结算和重复请求；
- `tools/mission_pass_settlement.test.cjs`：点数事务、活动登录和跨日失败回滚；
- `tools/pass_card_route.test.cjs`：等级奖励、库存变更、重复领取、等级锁定、非法 body 和整批失败回滚；
- `tools/test-workflow/database-lifecycle.test.cjs`：真实 schema v6 到 v7 的 Pass 表迁移、外键和级联行为。
