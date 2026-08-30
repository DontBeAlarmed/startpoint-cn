# 公共礼包码

本文描述公共礼包码的定义、可见入口、精确兑换语义和存档边界。有效期、batch、channel、总领取人数限制、单条重置和人工重发不在当前范围。

## 数据模型与迁移

礼包由 schema 24 建立三张表：`server_gift_codes` 保存礼包定义和状态，`server_gift_rewards` 保存有序奖励，`players_gift_redemptions` 保存每个玩家存档的领取事实。schema 24 的新表为空，不从旧配置导入礼包。

`server_gift_codes` 的 code 使用 SQLite `BINARY` 唯一约束，状态只有 `stopped` 和 `active`。奖励类型在数据库层限制为客户端礼包协议支持的 `1` 道具、`4` 免费星导石、`5` 角色、`6` 装备、`8` 玛纳和 `9` 经验池。`players_gift_redemptions` 以 `(gift_id, player_id)` 为主键，删除礼包或玩家时级联删除。

礼包定义和服务器礼包状态不属于玩家存档。`players_gift_redemptions` 是服务器本地运营事实，V2 快照显式排除该表；同服克隆使用专用复制边界，外部导入会清除目标存档记录。

## 客户端入口与能力

`/api/index.php/load` 和 `/api/index.php/tool/check_enable_gift` 读取同一个 capability 服务。只要存在任一 `active` 礼包，两者都返回 `enable_gift=true`；没有任何 active 礼包时都返回 `false`。服务端不允许两个入口对能力声明不一致。

兑换入口是：

```text
POST /api/index.php/gift/receive
body: { key: string }
```

路由先校验请求对象、`viewer_id`、viewer session 和当前绑定的玩家存档；这些请求边界不合法时返回 HTTP 400，不进入礼包结果码。通过入口校验后，兑换服务返回的 `result_code` 包装在 HTTP 200 中。成功响应 `result_code=1`，`all_gift_info` 按奖励 `position` 返回 `type`、`type_id` 和 `number`。响应不新增客户端字段，也不携带数据库 ID、revision 或领取快照。

## Code 与奖励校验

兑换和后台使用同一个精确 code 规则：非空、单行、UTF-16 长度不超过 20，支持客户端可输入的任意字符。匹配区分大小写，不执行 trim、大小写转换或 Unicode 归一化；SQLite `BINARY` 唯一约束与查询一致。原始提交 code 不写入普通日志。

每个礼包有 1..20 条奖励，`position` 从 0 连续递增。道具、角色、装备必须有正整数 `type_id` 并通过当前 Content 集合校验；免费星导石、玛纳、经验池的 `type_id` 必须为 null。角色和装备数量必须为 1；道具数量不超过当前官方持有上限；其余资源最大为 int32 正上限。后台保存和启动前都会校验完整奖励，兑换事务内还会重新校验数据库中的奖励。

后台 note 可为 null 或不超过 512 UTF-16 单位的字符串；note 不下发给游戏客户端。

## 状态机

新建礼包只能是 `stopped`。stopped 礼包可编辑 code、note 和奖励，可启动或物理删除。启动事务重新读取 stopped 状态、匹配 revision，并重新校验 code 和全部奖励。

active 礼包立即可兑换，但定义不可变，只允许停止。停止只改变礼包状态，不删除领取记录。停止后可修改奖励；如果奖励发生变化，`reward_revision` 加一，未领取存档以后按新奖励领取，已有存档仍不可重领。奖励未变化时 `reward_revision` 保持不变。

只有 stopped 礼包可物理删除。删除级联删除奖励和全部领取记录；同一个 code 之后新建会得到新礼包 ID，因此所有存档都可重新兑换。所有状态变化都要求当前 `revision`，冲突返回 409。

## 兑换事务与错误

服务端从 viewer session 解析当前 `player_id` 后，在同一个 SQLite 事务中执行：

1. 使用原始 `key` 精确查询礼包；
2. 检查 active 状态；
3. 检查 `(gift_id, player_id)` 是否已领取；
4. 事务内重读 active 礼包 authority、revision 和 reward revision；
5. 重新读取并校验全部奖励；
6. 插入含 reward revision 和不可变 reward snapshot 的领取记录；
7. 通过 RewardGrant owner 发放六类标准奖励；
8. 每条奖励写入一条领取历史；
9. 提交后返回成功和奖励投影。

实际结果码如下：

| result_code | 语义 |
|---:|---|
| `1` | 成功 |
| `6101` | 字符串 key 为空、含换行、长度超过 20，或没有精确匹配礼包 |
| `6103` | 礼包存在但不是 active |
| `6104` | 当前 `player_id` 已领取该礼包 |

`6102`、`6105`、`6106` 当前不使用。奖励、历史或领取记录任一步失败都会回滚整个请求；主键并发冲突按 `6104` 处理。成功响应丢失后重试只会得到 `6104`，不会重复发奖或重放成功弹窗。

## 克隆、导入与导出

普通登录和正常游戏保留当前存档的领取记录。同服显式克隆在克隆外层事务中把来源存档记录复制到新存档，并把 `inherited_from_player_id` 记为来源玩家；复制失败时整个克隆回滚。

普通新建存档和默认模板不复制任何领取记录。V2 导出快照不包含 `players_gift_redemptions`。恢复、模板导入或任何外部导入进入目标存档时，服务端在恢复事务中清除该存档全部礼包领取记录；即使来源文件声称来自同一服务器，导入后也按未领取处理。来源 schema 高于当前服务器时仍先拒绝导入。

## 管理后台

后台提供礼包列表、详情、创建、stopped 编辑、启动、停止、物理删除和只读领取记录查询。列表显示 code、状态、奖励摘要、reward revision、领取存档数和时间；领取记录支持按玩家 ID、玩家名称和账号 ID 分页搜索，并显示继承标记和来源玩家。

active 礼包在后台只读，只允许停止。不提供单条领取删除、重置、强制标记、人工补发或 reward snapshot 编辑。给玩家补偿使用后台邮件。

## 验证边界

schema 24 迁移、code 与奖励校验、状态机、精确兑换、事务回滚、同服克隆继承和外部导入清除有自动测试覆盖。礼包入口显示、弹窗、奖励图标、重复兑换提示和多客户端并发仍需 CN 1.8.1 客户端实机验收。
