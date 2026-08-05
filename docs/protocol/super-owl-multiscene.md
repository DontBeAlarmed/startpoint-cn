# 超级猫头鹰双 Boss 联机

本文记录 CN 1.8.1 双 Boss 关卡的客户端协议、服务端状态机和验收边界。服务端流程已有自动测试，尚未通过 CN 客户端人工验收。

## 关卡范围

CN 主数据中只有入口关卡 `1001002`、`1001003` 的第 122 列 `is_both_boss=true`。`1001004` 到 `1001019` 的 `is_both_boss=false`、`both_boss_hidden=true`，属于双 Boss 流程使用的隐藏战斗配置，不能作为允许 `LevelNext` 的入口。

内容转换器把第 122 列转换为可选的 `isBothBoss: true`；普通和隐藏关卡不写该字段。联机层按房间的 category、quest ID 和转换后的字段授权场景切换，不维护手工关卡 ID 白名单。

## 客户端协议

依据 CN 1.8.1 反编译代码，预期顺序为：

1. 初始 BattleScene 建立 battle TCP，发送 `SceneReady(0)`；
2. 全员就绪后接收 `BattleStart(1)`；
3. 第一 Boss 完成后发送 `LevelNext(1)`，切换新的 BattleScene；
4. 新场景再次发送 `SceneReady(0)`；
5. 全员再次就绪后接收第二次 `BattleStart(1)`；
6. 第二 Boss 完成后发送 `Finalize(2)`；
7. 客户端随后只调用一次 `/multi_battle_quest/finish`。

客户端 Notify 枚举：

| Index | 含义 |
|---:|---|
| 0 | SceneReady |
| 1 | LevelNext |
| 2 | Finalize |
| 3 | Measurement |
| 4 | LineSpeedWarning |
| 5 | Heartbeat |

`BattleSocketContact` 收到服务端 `Finalized(2)` 后会断开 battle socket，因此第一场景的 LevelNext 绝不能被当作 Finalize。

## 服务端实现

`SessionManager` 为每个房间保存场景 generation、预期真人数和本代 SceneReady 集合：

1. 房主的 lobby StartBattle 固化当局真人身份并建立 generation 0；
2. 首代全员 SceneReady 后广播第一次 `BattleStart(1)`；
3. 第一个合法 `LevelNext(1)` 建立 generation 1，并清空上一代 SceneReady；
4. 每个真人连接必须先发送本人的 LevelNext，服务端才接受该连接的第二代 SceneReady；上一代迟到或重复的 SceneReady 不会计入新屏障；
5. 重复 LevelNext 不再次清空屏障；
6. 第二代全员 SceneReady 后广播第二次 BattleStart；
7. 等待期间真人断线会缩减预期人数，条件满足时立即释放剩余玩家；
8. BothBoss 只有在 generation 1 屏障完成后才接受 `Finalize(2)`，提前或乱序 Finalize 会被忽略；合法结束会记录该玩家已 Finalize，并回复该连接 `Finalized(2)`。

battle 握手要求房间已进入战斗状态，且 connection ID 属于房主 StartBattle 固化的真人身份快照；客人不能提前固化名单，仅在战斗开始后临时建立的 lobby 连接也不能加入场景屏障。快照独立于 lobby/battle socket 生命周期，因此合法成员可在 lobby 断开后建立 battle socket，也不会因 battle socket 短暂断开而失去当局重连资格。服务端按 generation 记录每个 connection ID 是否已收到 BattleStart，只有 socket 写入成功后才记录送达；重连者提交对应的 SceneReady 时只向其补发遗漏代次，不会让在线成员重复进入场景。校验通过后 battle socket 继承快照中的 viewer/player 身份，未知成员和重复连接会被拒绝。Notify 3、4、5 分别按 Measurement、LineSpeedWarning、Heartbeat 处理，Measurement 返回客户端参照实现使用的 2000ms 告警阈值，不再占用旧客户端枚举位置。普通关卡和隐藏战斗配置发送 LevelNext 会被忽略。

HTTP active quest 仍贯穿一次 start 到最终 finish。第一 Boss 后不删除 active quest、不发奖励、不更新完成进度；BothBoss 的 HTTP finish 还要求当前玩家已完成合法 TCP Finalize。Hub 把参与者、房间、`battleSessionId` 和 Finalize 结果保存为只读完成事实，房间释放后仍保留最多 30 分钟，HTTP finish 查询该事实但不消费它。

完成后的房间生命周期由 coordinator/Hub 权威处理：全部剩余真人已 Finalize 时，Hub 结束并释放当局房间状态，同时保留完成事实供各节点延迟结算。每个玩家节点随后只在自己的 SQLite 事务中重新比对并消费 active quest；奖励、库存、任务、履历、邮件和 active quest 删除处于同一事务。若本地事务失败，所有写入回滚，active quest 与 Hub 完成事实都仍可用于重试。abort 先提交玩家自己的退款和 active quest 删除，再 best-effort 通知 coordinator；非房主会从当局参与者和 retained fact 授权集合移除，不能再 finish，房主则解散房间。本地节点不把自己的 room manager 当作远端房间权威。第二 Boss 后客户端只提交一次 HTTP finish，重复请求会因本地 active quest 已被事务消费而失败，不会重复结算。

## 验收边界

`tools/multi_battle_multiscene.test.cjs` 覆盖双代屏障、跨代迟到 SceneReady、重复 LevelNext、提前 Finalize/finish 拒绝、普通及非 Boss 关卡兼容、断线释放、跨代重连补发、房主成员快照、握手身份和 CN Notify 索引；`tools/boss_battle_multiscene_content.test.cjs` 校验转换器和运行资产只把 `1001002`、`1001003` 标记为入口。

仍需 CN 客户端人工验证单人加 NPC、两名真人和三名真人的完整切场、第二 Boss、最终结算及异常断线体验。自动测试通过不能写成客户端已通过。
