# 战阵流程与活动扭蛋箱重置设计

> 日期：2026-07-18  
> 范围：战阵流程语义、`box_gacha/reset`  
> 不包含：战阵真人联机、默认三队修复、活动时间调整

## 现场结论

### 战阵不是常规联机房间

国服客户端把战阵（Raid，Quest Category `23`）实现为玩家单人操作自己的三支队伍。关卡选择固定进入 `SingleQuestStartFlow`，配队页使用 `RaidEventPartySelectLogic`，开始后进入 `RaidBattleStart`；过程中不会创建、搜索或加入 `multi_battle_quest` 房间。

因此“找不到战阵多人入口”不是服务端漏发按钮。后续测试应称为“战阵三队 Raid 流程”，验证三队配队、`event/raid/battle/start`、战斗与结算，不再寻找常规共斗入口。

### 最终箱重置 H404

现场客户端连续请求：

```text
POST /api/index.php/box_gacha/reset
```

当前插件只实现 `/close`、`/exec` 和 `/get_box_list`，因此返回 H404。

本次活动为 `box_gacha_id=28`。玩家 18 已把箱 5 的 `2732` 个胶囊全部抽完，数据库状态为：

```text
remaining_number=0
is_closed=1
reset_times=0
```

CN `box.json` 中箱 5 的 `reset_kind=2`、`reset_limit=None`，含义是“仅空箱可重置，次数不限”。

## 协议

请求字段：

```text
box_gacha_id: Int
box_id: Int
viewer_id: Int
api_count: Int（公共请求字段）
```

成功响应沿用其他箱式扭蛋接口的箱状态结构：

```text
data.all_box_info: [
  {
    box_id: Int,
    reset_times: Int,
    all_drawn_reward_list: [{ reward_id: Int, number: Int }],
    coming_next_reward_list: Int[],
    is_closed: Bool
  }
]
```

客户端对这些字段进行强类型校验，不能省略。

## 规则资产

现有 `assets/box_gacha.json` 只有抽取费用和每箱总库存，不能判断某个箱是否允许重置。新增独立规则资产 `assets/box_gacha_box_settings.json`，由工具从 CN `orderedmap/box_gacha/box.json` 确定性生成。

每个箱保存：

```ts
interface BoxGachaBoxSettings {
    requiredBoxId: number | null
    resetKind: number
    resetLimit: number | null
    availableFrom: string
    availableUntil: string | null
    closeKind: number
}
```

本轮运行数据中只有 `reset_kind=0`（不可重置）和 `2`（抽空后可重置）。共 38 个最终箱允许抽空后无限重置。路由必须读取规则资产，不能按“最后一个箱”或 `box_id=5` 猜测。

## 重置事务

`POST /reset` 依次完成：

1. 校验 session、当前玩家、扭蛋 ID 和箱 ID。
2. 按全局服务器时间校验箱的开放期；期外返回业务码 `4608`。
3. 校验前置箱已经解锁当前箱。
4. 校验 `resetKind`、`resetLimit` 和当前库存：`reset_kind=2` 只允许 `remaining_number=0`。
5. 在一个 SQLite 同步事务中重新读取状态，随后：
   - `reset_times += 1`；
   - `remaining_number = availableCounts[boxId]`；
   - `is_closed = false`；
   - 删除当前 `player_id + gacha_id + box_id` 的已抽奖励行。
6. 返回全部箱状态。

重置不回收玩家已经得到的奖励，不影响箱 1～4，不扣活动道具，也不前进或退回其他箱。箱 5 重置后仍是箱 5。

第一次成功后立即重复请求必须失败，因为库存已经非空。同步事务保证两个并发请求最多只有一个成功。

## 测试

自动测试覆盖：

1. 规则资产与 CN `box.json` 逐项一致；`28/5` 为 `resetKind=2`、无限次，箱 4 不可重置。
2. 空箱 28/5 重置后变为 `reset_times=1`、`remaining=2732`、`is_closed=false`，已抽记录清空。
3. 玩家已获得道具和抽取货币不变化，箱 1～4 不变化。
4. 立即重复重置、非空箱、不可重置箱、未解锁箱、无效 ID 和期外请求均失败且数据库不变。
5. 路由响应包含完整 `all_box_info`。
6. 既有 `/close`、`/exec`、`/get_box_list` 和角色觉醒发布回归保持通过。

完成后由客户端点击箱 5 的“库存重置”按钮验收：不再 H404，页面仍停留箱 5，库存恢复为 2732，随后可以继续抽取。
