# 箱式扭蛋

> 状态：`/reset` 已通过国服客户端验收（2026-07-19）；`/exec` 已完成服务端自动回归，待客户端复验。
> 路由：`/api/index.php/box_gacha/*`

## 端点

| 端点 | 用途 |
|------|------|
| `POST /get_box_list` | 返回指定箱式扭蛋的全部箱状态 |
| `POST /exec` | 消耗活动道具并抽取当前箱奖励 |
| `POST /close` | 关闭允许提前结束的箱子 |
| `POST /reset` | 按主数据规则重置已经抽空的箱子 |

四个端点都返回客户端强类型校验的 `data.all_box_info`。每个箱必须包含 `box_id`、`reset_times`、`all_drawn_reward_list`、`coming_next_reward_list` 和 `is_closed`，不能省略空数组或布尔字段。

## 数据来源

- 当前 Content snapshot 的 `box_gacha.json`：从官方活动与奖励主数据生成抽取道具、单抽费用和每箱总库存。
- 当前 Content snapshot 的 `box_reward.json`：每箱奖励构成；总库存由各奖励的 `available` 求和。
- 当前 Content snapshot 的 `box_gacha_box_settings.json`：由官方 `box_gacha/box` 主数据生成前置箱、重置方式、次数限制和开放期。
- `players_box_gacha`：玩家每个箱的剩余库存、关闭状态和重置次数。
- `players_box_gacha_drawn_rewards`：按 `player_id + gacha_id + box_id` 保存已抽奖励数量。

三张表由同一 Content Release 提供；snapshot 尚未初始化的低级测试才回退仓库内 bundled JSON。路由必须读取规则表，不能用“最后一个箱”或固定 `box_id` 推断是否允许重置。

## 空箱重置

`POST /reset` 请求包含 `viewer_id`、`box_gacha_id` 和 `box_id`。服务端通过 session 与 `resolvePlayerIdSync` 解析账号当前存档，并使用全局服务器时间检查开放期。

客户端沿用上游 JST 类型名，但国服初始化偏移为 UTC+8。主数据日期按北京时间解释，起止时刻均包含在有效期内。期外请求使用 HTTP 200 的 MsgPack 响应，并在 `data_headers.result_code` 返回业务码 `4608`，避免客户端把业务失败误判为 H400。重置前还必须满足：

1. 目标箱和规则存在。
2. `requiredBoxId` 对应前置箱已经解锁目标箱。前置箱库存为 0 时视为解锁；否则必须已经关闭。
3. `resetKind=2`，即只允许空箱重置。
4. `resetLimit` 为空，或当前 `reset_times` 尚未达到限制。
5. 当前 `remaining_number=0`。

## 抽取校验与结算

`POST /exec` 只接受正安全整数抽取数和布尔型 `stop_on_featured_rewards`。请求数不得超过根据已抽记录计算出的剩余库存，并在抽取前校验请求上限对应的活动道具余额。开放期外沿用客户端业务码 `4608`；带前置箱的目标箱只有在前置箱已经关闭或库存为 0 时才可抽取。

普通箱启用“抽到精选奖励后停止”时，活动道具只按本次实际抽出的胶囊数扣除。`resetKind=1/2` 的箱在客户端语义中需要重置按钮，因此忽略精选停止并执行请求的完整抽取数。

`/exec` 在一个 SQLite 事务中重新读取玩家、活动道具、父箱和已抽记录，并统一提交：

1. 道具、角色、装备、玛纳和经验奖励；
2. `players_box_gacha` 的剩余库存与关闭状态；
3. `players_box_gacha_drawn_rewards` 的累计已抽数量；
4. 按实际抽数计算的活动道具扣除。

任一步失败都会整体回滚。剩余库存以官方总库存减去已抽记录合计计算，提交后父箱同步到同一结果，避免客户端使用历史而 reset 使用父箱时出现双事实源分裂。

## 重置事务

重置服务使用可注入的同步依赖，并在一个 SQLite 同步事务内重新读取玩家箱状态。事务依次执行：

1. `reset_times += 1`。
2. `remaining_number = availableCounts[boxId]`。
3. `is_closed = false`。
4. 删除精确匹配当前 `player_id + gacha_id + box_id` 的已抽记录。

任一步失败都会回滚。第一次成功后立即重复请求会因库存已经恢复而失败，因此并发请求最多只有一个成功。重置不扣活动道具、不回收已经获得的奖励、不前进或退回箱号，也不修改其他箱。

## 活动 28 验证基线

箱 5 的 `resetKind=2`、`resetLimit=null`，总库存为 2732；箱 4 不允许重置。专项测试复现箱 5 的 `remaining_number=0`、`is_closed=true`、`reset_times=0` 和已抽合计 2732，验证成功后库存恢复、记录清空，以及所有失败路径均无部分状态。

## 客户端验收结果

- 活动 28 箱 5 点击“库存重置”后不再返回 H404。
- 页面保持箱 5，库存恢复为 2732，重置次数增加为 1。
- 库存非空时立即再次重置会被拒绝。
- 重新 load 后库存和重置次数正确保持。
- 当前未发现其他最终箱重置问题。

## 待审阅边界

- 客户端网络层可能以相同 `api_count` 重试。当前没有持久化箱式扭蛋请求回执；首次提交成功但响应丢失时仍可能发生第二次抽取。`api_count` 生命周期未确认前不做永久去重。
- `coming_next_reward_list` 仍为空。准确返回后续 3 格需要持久化奖池顺序或可重放随机状态。
- `/close` 当前只持久化关闭状态；`closeKind`、必需奖励和开放期的完整服务端限制仍需继续核对权威客户端流程。
- `/get_box_list` 尚未单独对齐开放期错误码，只保证返回结构完整。
