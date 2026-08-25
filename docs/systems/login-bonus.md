# 登录奖励

当前服务端实现 CN CDN `master/bonus/login_bonus.orderedmap` 中的七种非 Premium 登录奖励类型，运行时使用 Content Snapshot 中的 `login_bonus.json`；服务端不单独维护周期长度或奖励常量。

## 时间与组选择

- 登录奖励使用全局虚拟业务时间，并与 `DAILY_RESET_HOUR` 的业务日边界一致。
- CDN 顶层键是 `bonus_group_id`，第二层连续整数键是领取 `index`。
- 保留 CDN 的七种非 Premium 类型：`Normal`、`Limited`、`Comeback`、`ComebackAlways`、`ActiveUser`、`ComebackCn`、`ComebackJp`。
- `start_time` 与 `end_time` 按 CN 客户端实际的 UTC+8 偏移解释，起止时刻均包含。
- 多个 `Normal` 组同时有效时，按客户端规则选择开始时间最早的组；其他类型的有效组各自独立推进。
- `Normal` 组到末尾后循环到 `index=1`；其他类型到末尾后停止，不会循环。
- `condition_period_start_time`、`condition_period_end_time`、`last_login_time_condition_for_comeback`、`include_beginner` 和 `comeback_bonus_group_id` 均由 CDN 转换并参与资格判断；资格信息不完整时按 CDN 字面 fail closed。
- `ActiveUser` 与其 `comeback_bonus_group_id` 指向的回归组互斥：已选择回归组后不再新建对应 ActiveUser 进度。
- CDN 没有有效组的历史空窗不发放奖励，也不推测最近组。

默认虚拟时间对应 `normal_2022`，该组由 CDN 定义为四日循环。其他历史时间会按同一规则自动选择当时有效的官方组。

## 发奖与确认

`/load` 在完整存档序列化前执行登录奖励结算：

1. 若玩家有尚未确认的批次，返回该玩家全部 pending 组的原 `group_id`、类型、`index` 和 `received_at`，不再次发奖。
2. 若当前业务日不晚于上次已发奖业务日，返回空奖励状态；服务器时间回拨不会重复发奖。
3. 若当日可领取，Normal、Limited 和其他符合资格的组在一个 SQLite 事务中合并调用统一 RewardGrant，并写入同一 `received_at` 的 pending 批次。
4. 新发奖励后重新读取玩家货币状态，保证本次 `/load` 响应与数据库一致。

客户端收到 pending 后会先调用 `/bonus/shown`，再展示奖励界面。该端点只确认当前 pending 批次：不发奖、不推进游标，重复调用成功且无副作用。若 `/load` 在数据库提交后响应编码失败，下次登录仍返回同一 pending 批次，因此不会重复发奖。

响应字段为：

- `login_bonus_received_at`：Unix 秒；没有 pending 时为 `null`。
- `bonus_index_list`：pending 时包含全部组的 `{ bonus_group_id, bonus_group_type, index }`，顺序与客户端处理顺序一致，否则为空数组。
- `premium_bonus_index_list`、`premium_bonus_mailed_item_list`：当前为空数组。

## 持久状态

`players_login_bonus_progress` 按 `(player_id, group_id)` 保存每组的最后发放 index、业务日、领取时间和展示确认时间。玩家删除时由外键级联清理；时间导入和虚拟时间调整不删除已发放状态。结算还会比较玩家所有组的最大已发放业务日，防止回拨后重新领取更早日期的未领取奖励。

性能边界：一次登录奖励结算只批量读取该玩家的全部组进度，随后在内存中按 `group_id` 复用；不会随着同时有效的奖励组数量逐组查询同一张表。奖励组目录来自已加载的 Content Snapshot，结算不重新读取 CDN 文件。

## 时间回拨与边界

- 登录奖励属于虚拟运营日历：向前调整可能进入新的 CDN 活动期，向后调整不会重发已确认奖励。
- 已确认记录不会重发；未确认 pending 批次会原样重放。回拨不会追补中间缺失日期，也不会重新开启已完成的 Limited 组。
- `premium_bonus_index_list`、`premium_bonus_mailed_item_list` 保持空数组。Premium Login Bonus 涉及付费资格和邮件，不在本服务端实现。

## 验证

- `tools/content_login_bonus_converter.test.cjs`：CDN 字段、UTC+8 周期、奖励槽和有效组选择。
- `tools/login_bonus_settlement.test.cjs`：事务发奖、pending、循环、跨组、回拨和失败回滚。
- `tools/login_bonus_route.test.cjs`：`/load` 响应、即时库存、`/bonus/shown` 与编码失败恢复。
