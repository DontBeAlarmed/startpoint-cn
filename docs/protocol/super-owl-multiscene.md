# 超级猫头鹰双 Boss 联机分析

## 范围

CN 1.8.1 主数据中的双 Boss 关卡为 `boss_battle_quest` 的 `1001002` 到 `1001019`。其中 `1001002/1001003` 使用超级猫头鹰缩略图；`1001004-1001019` 使用 `double_owl_lich_*` 或 `double_boss_owl_*` 场地。客户端将其解析为 `BothBoss`，不是两个独立 HTTP play。

## 客户端流程

依据 CN 1.8.1 反编译代码：

1. 初始 BattleScene 建立 battle TCP，发送 `BattleNotifyMessage.SceneReady(0)`。
2. 服务端全员就绪后发送 `BattleServerMessage.BattleStart(1)`。
3. 第一 Boss 完成后，`BattleScenePlayingStateImpl.bothBossNext()` 更新 round 并调用 `BattleScene.bothBossLevelNext()`。
4. 客户端发送 `BattleNotifyMessage.LevelNext(1)`，黑屏切换到新的 BattleScene。
5. 新场景 `afterTransition()` 再次发送 `SceneReady(0)`，进入 WaitForMate，等待第二次 `BattleStart(1)`。
6. 第二 Boss 完成后才发送 `BattleNotifyMessage.Finalize(2)`，随后调用一次 HTTP `/multi_battle_quest/finish`。

关键参考：

- `BattleNotifyMessage`: `SceneReady=0, LevelNext=1, Finalize=2, Measurement=3, LineSpeedWarning=4, Heartbeat=5`
- `BattleScene.as`: `bothBossLevelNext()`、`afterTransition()`、`exitBattleSceneAsQuestClear()`
- `BattleScenePlayingStateImpl.as`: `bothBossNext()`
- `BattleSocketContact.as`: 收到 `Finalized(2)` 会立即断开 battle socket

## 当前服务端缺口

`src/multi/tcp/battle.ts` 的 Notify 枚举整体错位：

| tag | 客户端真实含义 | 当前实现 | 影响 |
|---:|---|---|---|
| 0 | SceneReady | SceneReady | 初始场景可用 |
| 1 | LevelNext | Finalize，并回 `Finalized(2)` | 第一 Boss 后错误断开 socket |
| 2 | Finalize | Measurement | 最终握手错误 |
| 3 | Measurement(frame,time) | 未处理 | RTT/时间同步缺失 |
| 4 | LineSpeedWarning(span) | Heartbeat | 语义错误 |
| 5 | Heartbeat | 未处理 | 等待阶段心跳无响应 |

另一个缺口是场景屏障只能运行一次。初始全员 SceneReady 后，`battleExpectedCount` 被置为 0，`sceneReadyClients` 仍保留旧连接；第二场景的 SceneReady 永远无法再次触发 BattleStart。

## 补全方案

1. 用显式 TypeScript enum 替代数字和错误注释，严格对齐 CN TypePacker。
2. 为每个房间增加 battle round/generation，以及 `levelNextClients`、`sceneReadyClients` 两个集合。
3. 第一个合法 `LevelNext` 开启下一 generation，清空上一轮 SceneReady，并重设 expected real-player count；重复 LevelNext 必须幂等，不能再次清空。
4. 下一 generation 全员 SceneReady 后再次广播 `[1,[1]]`（BattleStart）。
5. `Finalize(2)` 只向该客户端回复 `[1,[2]]`（Finalized），并在最终 HTTP finish/断线时清理房间 battle barrier。
6. `Measurement(3)` 回复 `Measurement(3, frame, clientTime, serverTime)`；`Heartbeat(5)`只用于保持连接，不伪装成其他客户端消息。
7. LevelNext 仅允许 BothBoss 关卡触发。服务端需在 room battle context 保存 quest category/id，并用受控关卡集合或主数据字段判定，避免普通关卡伪造阶段切换。
8. HTTP active quest 在第一 Boss 后不得删除、发奖或更新进度；只在最终 `/finish` 结算一次。当前 HTTP 路径满足这一点，缺口集中在 TCP 状态。

## 必需测试

- 单人+NPC：首轮 SceneReady -> BattleStart -> LevelNext -> 第二轮 SceneReady -> BattleStart -> Finalize。
- 两名/三名真人乱序到达，包含 SceneReady 早于其他人的 LevelNext。
- 重复 LevelNext/SceneReady 幂等。
- 中途掉线后 expected count 收缩，不永久等待。
- 普通单 Boss 的 tag 1 不应进入第二场景。
- 最终只有一次 HTTP finish、一次奖励和一次进度更新。

结论：无需新增第二次 HTTP start/finish，也无需理解或改写战斗帧内容；现有 relay 可以继续透明转发。需要补的是 TCP Notify 枚举和可重复使用的场景同步屏障。
