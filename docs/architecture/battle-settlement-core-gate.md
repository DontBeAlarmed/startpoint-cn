# D25 Battle Settlement 有限核与 Single/Multi Adapter

状态：有限 shared core、Single adapter、Multi adapter 与依赖边界已实现；D25 focused/performance 与 whole-range closure 在 C6 完成。客户端实机验收统一延期到 D28 后。

## 边界结论

Battle Settlement Core 不是共同生命周期服务。它只拥有两个无副作用的 typed plan：

- `battle-settlement-values.ts`：根据调用方已验证的玩家、关卡、倍率与本场数值计算 Mana/EXP、rank/degree、boost 和玩家 after-state；
- `battle-quest-progress-plan.ts`：根据本场成功事实与历史最佳生成 quest progress insert/update/no-op。

两个 plan 都不读写 SQLite，不读取 active quest，不访问网络，不持有 Content snapshot，不构造 HTTP/TCP 响应，也不知道 room/session/host/guest/NPC。

## Adapter 所有权

| Owner | 保留职责 | Shared core 不得拥有 |
|---|---|---|
| Single | start/active identity、finish 外层事务、continue/abort、ScoreAttack 排除、Daily Challenge、entry/stamina、各 Event handler、active quest 删除与响应 | Single 请求字段、continue count、restore、ScoreAttack/Rush/Raid/Carnival 状态 |
| Multi | Hub/Coordinator 验证、finish 外层事务、hostFinished、multi clear count、失败返还、rescue/periodic、room/session/TCP、内存 active quest publication | coordinator、room number、battle session、host/guest/NPC 语义 |

Single 与 Multi 各自通过本域 value/progress adapter 调用 shared plan，并在原外层事务中执行 SQL。Single 缺失 leader 时保留历史 leader；Multi 保持既有语义，可显式清空缺失 leader 并持久化 `hostFinished`。

## 依赖方向

```text
Single lifecycle ─┐
                  ├─> immutable Settlement Values / Quest Progress plans
Multi lifecycle  ─┘

shared plans -X-> SQLite / active quest / HTTP / TCP / room / session
Single lifecycle -X-> Multi transport
Multi lifecycle  -X-> Single continue / abort
```

RewardGrant、Mission、Character Growth、entry lifecycle、additional/score/periodic reward 已有各自 owner，D25 直接复用，不再包成万能 Battle service。Common Response 的 absolute/delta/Optional 字段投影留给 D28。

## 测试边界

- shared values/progress 由纯函数测试固定正常、boost、insert/update/no-op、单调历史与不可变结果；
- `battle_settlement_boundary.test.cjs` 只固定依赖方向和生命周期不进入 shared core，不冻结函数排列或文件行号；
- Single 保留完整 start/finish/continue/abort、identity、rollback、response 与独立性能 baseline；
- Multi 保留 host/guest、失败/成功/重复 finish、room/session/TCP、rollback 与独立性能 baseline；
- Multi transport tests 永不因 settlement 共享而删除。

DEBT-T05 的 Single orchestrator 源码形状矩阵已由上述 typed API、依赖边界和生命周期测试替代。DEBT-T08 只收敛共同结算数值/进度 fixture；Single lifecycle 与 Multi transport/performance fixture 因职责不同而明确保留。

