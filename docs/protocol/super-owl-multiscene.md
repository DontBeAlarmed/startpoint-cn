# 超级猫头鹰双 Boss 联机

本文记录 CN 1.8.1 双 Boss 关卡的客户端协议和当前服务端缺口。该流程尚未实现，不能按普通单场景联机标记为可用。

## 关卡范围

CN 主数据中，`boss_battle_quest` 的 `1001002` 到 `1001019` 使用双 Boss 场地配置。客户端把这类关卡解析为一个 `BothBoss` play：第一场景结束后切换第二场景，最后只提交一次 HTTP 结算。

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

## 当前服务端状态

`src/multi/tcp/battle.ts` 当前只能完成首次 SceneReady 屏障，且 Notify 映射与 CN 客户端不一致：

| 客户端 Index | 当前服务端解释 | 结果 |
|---:|---|---|
| 0 | SceneReady | 首场景可进入 |
| 1 | Finalize | 第一 Boss 后会过早回 Finalized |
| 2 | Measurement | 最终握手无法对齐 |
| 3 | 未处理 | Measurement 缺失 |
| 4 | Heartbeat 兼容响应 | 与 LineSpeedWarning 语义不符 |
| 5 | 未处理 | 等待阶段心跳缺失 |

首次全员 SceneReady 后，当前 `battleExpectedCount` 和 `sceneReadyClients` 也没有按场景 generation 重置。第二场景无法重新形成独立屏障并广播第二次 BattleStart。

HTTP active quest 当前贯穿一次 start 到一次最终 finish，不会在第一 Boss 后自动结算。这一边界与客户端单 play 语义一致；缺口集中在 TCP Notify 和可重复场景屏障。

## 完成判定

只有同时满足以下协议行为后，才能把双 Boss 联机标记为已实现：

- LevelNext 与 Finalize 按 CN 枚举区分；
- 第二场景拥有独立 SceneReady 屏障和第二次 BattleStart；
- 重复或乱序消息不会重复切换场景；
- 真人掉线不会让剩余成员永久等待；
- 普通单 Boss 关卡不能进入 LevelNext 流程；
- Measurement、LineSpeedWarning 和 Heartbeat 不再复用错误 tag；
- 整场战斗只产生一次 HTTP finish、奖励与任务进度；
- 单人加 NPC、两名真人和三名真人均完成客户端回归。

当前没有对应自动状态机和客户端验收，因此支持矩阵应继续标记为缺失。
