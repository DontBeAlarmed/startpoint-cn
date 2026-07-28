# 第二玛纳板开放期

CN 客户端通过 `master/mana_board/mana_board2_open_condition.orderedmap` 决定角色是否能显示第二块玛纳板。
`GeneralCharacterLogic.canManaBoard2Open()` 要求角色稀有度高于二星，并以客户端收到的服务器时间检查角色专属
`start_time <= now <= end_time`。主数据日期按官方 `ParseTools.parseJstDataToUtcTime` 语义解释为 JST。

## 已修正风险

旧服务端没有加载开放期表，`/load` 会把数据库中的 `mana_board_index` 原样发送。若导入存档把角色停留在板二，
但当前服务器时间早于该角色开放期，客户端只构造板一数据却收到当前板二索引，存在 `F1009` 风险。

当前实现采用非破坏性降级：

- load 序列化时，如果板二在统一服务器时间尚不可见，只把响应中的 `mana_board_index` 降为 1；
- 数据库仍保留原索引，服务器时间进入开放期后会自动重新显示板二；
- `/character/open_mana_board` 在开放期前拒绝打开板二，且在创建 bond token 前完成校验；
- `/character/learn_mana_node` 和 `/character/receive_bond_token` 不能借旧存档索引绕过板二开放期。

三个写入口同时遵循[角色养成事务边界](./character-growth-transactions.md)：旧存档缺失 bond token 时，补行与
`mana_board_index` 更新同成同败；节点学习和信赖证领取也不会在后续写入失败时留下已扣资源或重复货币。

这项过滤不删除已学习节点、不重写 bond token，也不清理跨时间存档。节点数据可以留在服务端，客户端只在官方
可见期内操作板二。

## 时间语义

运行时一律读取全局服务器时间，不读取单存档 `time_offset`。JST 只用于把官方表中的日历文本转换为绝对时刻，
不是另一套运行时偏移。开始和结束边界均包含在开放期内，与 CN 客户端比较符号一致；缺表、缺角色行、非法日期
或未知角色均 fail closed。

## Content Sync

`mana_board2_open_condition.json` 作为 CDN 直接 OrderedMap 表动态生成，bundled 文件是官方 1.4.54 基线。
Registry 契约变化会让普通启动同步自动重建 release，不需要手动 `force`。
