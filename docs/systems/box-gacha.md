# 箱式扭蛋

> 状态：服务端已实现，`/reset` 待国服客户端验收
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

- `assets/box_gacha.json`：抽取道具、单抽费用和每箱总库存。
- `assets/box_reward.json`：每箱奖励构成。
- `assets/box_gacha_box_settings.json`：由国服 `orderedmap/box_gacha/box.json` 确定性生成的前置箱、重置方式、次数限制和开放期。
- `players_box_gacha`：玩家每个箱的剩余库存、关闭状态和重置次数。
- `players_box_gacha_drawn_rewards`：按 `player_id + gacha_id + box_id` 保存已抽奖励数量。

路由必须读取规则资产，不能用“最后一个箱”或固定 `box_id` 推断是否允许重置。

## 空箱重置

`POST /reset` 请求包含 `viewer_id`、`box_gacha_id` 和 `box_id`。服务端通过 session 与 `resolvePlayerIdSync` 解析账号当前存档，并使用该玩家的服务器时间检查开放期。

主数据日期按 JST（UTC+9）解释，起止时刻均包含在有效期内。期外请求使用 HTTP 200 的 MsgPack 响应，并在 `data_headers.result_code` 返回业务码 `4608`，避免客户端把业务失败误判为 H400。重置前还必须满足：

1. 目标箱和规则存在。
2. `requiredBoxId` 对应前置箱已经解锁目标箱。前置箱库存为 0 时视为解锁；否则必须已经关闭。
3. `resetKind=2`，即只允许空箱重置。
4. `resetLimit` 为空，或当前 `reset_times` 尚未达到限制。
5. 当前 `remaining_number=0`。

## 事务边界

重置服务使用可注入的同步依赖，并在一个 SQLite 同步事务内重新读取玩家箱状态。事务依次执行：

1. `reset_times += 1`。
2. `remaining_number = availableCounts[boxId]`。
3. `is_closed = false`。
4. 删除精确匹配当前 `player_id + gacha_id + box_id` 的已抽记录。

任一步失败都会回滚。第一次成功后立即重复请求会因库存已经恢复而失败，因此并发请求最多只有一个成功。重置不扣活动道具、不回收已经获得的奖励、不前进或退回箱号，也不修改其他箱。

## 活动 28 验证基线

箱 5 的 `resetKind=2`、`resetLimit=null`，总库存为 2732；箱 4 不允许重置。专项测试复现箱 5 的 `remaining_number=0`、`is_closed=true`、`reset_times=0` 和已抽合计 2732，验证成功后库存恢复、记录清空，以及所有失败路径均无部分状态。

客户端仍需点击箱 5 的“库存重置”完成验收：请求不再返回 H404，页面保持箱 5，库存恢复为 2732，重置次数变为 1，未再次抽空前不能重复重置。
