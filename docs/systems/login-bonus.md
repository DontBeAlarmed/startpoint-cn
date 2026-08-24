# 常规登录奖励

当前服务端实现官方 `Normal` 登录奖励主流程。奖励定义来自 CN CDN 的 `master/bonus/login_bonus.orderedmap`，运行时使用 Content Snapshot 中的 `login_bonus_normal.json`；服务端不单独维护周期长度或奖励常量。

## 时间与组选择

- 登录奖励使用全局虚拟业务时间，并与 `DAILY_RESET_HOUR` 的业务日边界一致。
- CDN 顶层键是 `bonus_group_id`，第二层连续整数键是领取 `index`。
- 只接入 `bonus_group_type=0` 的 `Normal` 组。
- `start_time` 与 `end_time` 按 CN 客户端实际的 UTC+8 偏移解释，起止时刻均包含。
- 多个 `Normal` 组同时有效时，按客户端规则选择开始时间最早的组。
- 当前组存在 `index + 1` 时继续推进，否则回到 `index=1`；虚拟时间进入另一有效组时从新组 `index=1` 开始。
- CDN 没有有效 `Normal` 组的历史空窗不发放奖励，也不推测最近组。

默认虚拟时间对应 `normal_2022`，该组由 CDN 定义为四日循环。其他历史时间会按同一规则自动选择当时有效的官方组。

## 发奖与确认

`/load` 在完整存档序列化前执行登录奖励结算：

1. 若玩家有尚未确认的批次，返回原 `group_id`、`index` 和 `received_at`，不再次发奖。
2. 若当前业务日不晚于上次已发奖业务日，返回空奖励状态；服务器时间回拨不会重复发奖。
3. 若当日可领取，在一个 SQLite 事务中调用统一 RewardGrant、推进游标并写入 pending 批次。
4. 新发奖励后重新读取玩家货币状态，保证本次 `/load` 响应与数据库一致。

客户端收到 pending 后会先调用 `/bonus/shown`，再展示奖励界面。该端点只确认当前 pending 批次：不发奖、不推进游标，重复调用成功且无副作用。若 `/load` 在数据库提交后响应编码失败，下次登录仍返回同一 pending 批次，因此不会重复发奖。

响应字段为：

- `login_bonus_received_at`：Unix 秒；没有 pending 时为 `null`。
- `bonus_index_list`：pending 时包含一项 `{ bonus_group_id, bonus_group_type: "Normal", index }`，否则为空数组。
- `premium_bonus_index_list`、`premium_bonus_mailed_item_list`：当前为空数组。

## 持久状态

`players_login_bonus_progress` 每名玩家保存一行：当前组、最后发放 index、最后发放业务日、领取时间和展示确认时间。玩家删除时由外键级联清理；时间导入和虚拟时间调整不删除已发放状态。

## 当前边界

当前没有实现 `Limited`、`Comeback`、`ActiveUser`、国服/日服回归变体或 Premium Login Bonus。这些类型虽存在于客户端和 CDN，但需要独立的活动资格、周期与发奖设计，不能复用 `Normal` 游标直接开启。

## 验证

- `tools/content_login_bonus_converter.test.cjs`：CDN 字段、UTC+8 周期、奖励槽和有效组选择。
- `tools/login_bonus_settlement.test.cjs`：事务发奖、pending、循环、跨组、回拨和失败回滚。
- `tools/login_bonus_route.test.cjs`：`/load` 响应、即时库存、`/bonus/shown` 与编码失败恢复。
