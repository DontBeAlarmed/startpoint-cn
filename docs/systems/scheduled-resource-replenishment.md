# 定时资源补充

定时资源补充是管理后台提供的服务端资源保障功能。它不创建游戏内邮件；玩家请求 CN `/load` 时，服务端按规则检查当前库存，命中后直接写入背包或免费星导石余额。

## 规则范围

后台邮件页提供独立的“定时资源补充”区域。规则支持：

- 全局规则，对所有现有及后续存档生效；
- 指定存档规则，只对一个 `player_id` 生效；
- 普通道具和免费星导石两种资源；
- 发放数量、触发下限、配置持有上限、启用状态、真实时间启用区间和备注。

角色、装备和能力魂珠不属于当前白名单。全局规则与指定存档规则拥有独立 ID 和状态；同时命中时全部发放，不覆盖、不去重。

## 时间与触发

启用区间和每日领取状态都使用统一时间模块的真实时间。业务日通过 `getBusinessDayKey(realNow, DAILY_RESET_HOUR)` 计算，不受虚拟服务器日期前后调整影响。

每条规则只记录最近一次**成功发放**的业务日：

1. 当前业务日已经成功发放时跳过；
2. 当前数量大于或等于触发下限时跳过，但不写状态；
3. 当前数量低于触发下限时发放，并与奖励在同一事务中写入成功业务日。

因此玩家当天首次登录库存充足时不会锁死规则；当天消耗到下限以下后再次 `/load` 仍可触发。连续离线不会补发历史日期，只结算当前真实业务日的一份。

## 权威上限

普通道具的官方持有上限来自 `master/item/item.orderedmap` 第 19 列 `max_count`，内容同步生成 `item_max_count.json`。免费星导石上限来自当前 Content Snapshot 的 `config.json.max_virtual_money`。

后台配置的持有上限可以低于权威上限，但不能高于权威上限。每条规则还必须满足：

```text
0 <= trigger_threshold
0 < grant_amount
trigger_threshold + grant_amount < inventory_cap
```

非法规则无法通过后台保存。运行时再次执行同一校验；历史数据库中若出现非法规则，该规则会被跳过，不会推测或截断奖励。

邮件使用同一张 `item_max_count.json` 校验单封普通道具附件数量，但邮件领取仍由客户端按当前可持有空间拦截。定时资源补充不经过邮件，因此不会增加邮箱记录或 `mail_arrived`。

## 存储与事务

`scheduled_resource_rules` 保存服务端规则；指定存档规则通过外键归属玩家。`players_scheduled_resource_state` 以 `(player_id, rule_id)` 保存最近成功业务日和真实发放时间。删除规则或玩家时状态级联清理。

结算链路为：

1. 一次读取当前存档可见的启用规则；
2. 一次批量读取这些规则的玩家状态；
3. 一次批量读取相关道具库存；
4. 使用 `/load` 已有玩家快照读取免费星导石；
5. 命中后在一个 SQLite 外层事务内调用 RewardGrant，并写入成功业务日。

RewardGrant 接收已批量读取的道具前态，不再为每条规则或每个道具重复查询。没有规则、没有待处理业务日或库存未低于下限时，不建立奖励写事务。奖励或状态任一步骤失败会回滚整个发放，下一次 `/load` 可以重试。

规则和状态属于当前服务端本地配置，不进入跨服务器玩家存档导入。服务重启和普通代码替换不会丢失 SQLite 中的规则或发放状态。

## 客户端边界

当前实现是服务端 only：

- `/load` 序列化会返回发放后的最新库存；
- 不新增客户端字段；
- 不伪装登录奖励；
- 不新增自定义横幅；
- 不创建溢出邮件，也不补发历史日期。

客户端是否对 `/load` 中的库存变化显示已有提示，沿用客户端现有行为，服务端不承诺专用提示。

## 验证入口

- `tools/scheduled_resource_storage.test.cjs`；
- `tools/scheduled_resource_rules.test.cjs`；
- `tools/scheduled_resource_settlement.test.cjs`；
- `tools/load_scheduled_resource_settlement.test.cjs`；
- `tools/admin_scheduled_resource_routes.test.cjs`；
- `tests/admin-scheduled-resource-ui-source.test.js`。
