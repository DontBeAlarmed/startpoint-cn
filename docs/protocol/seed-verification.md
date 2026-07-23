# 抽卡种子验证系统
> 状态: 已实现   关键文件: src/lib/seed-validator.ts, src/cn-server.ts:179-256, src/lib/gacha.ts:128   相关端点: /gacha/exec, /crash

抽卡动画种子通过客户端物理仿真进行验证。服务端把种子发给客户端，客户端通过 APK 信标（beacon）回传实际稀有度和 `play=` 标志。本文档配合 [./gacha-c3032.md](./gacha-c3032.md) 阅读：C3032 根因与物理引擎分析在该文档，种子池/信标/净化流程在本文档。

## Seed verification system (2026-06-20)

Gacha animation seeds are validated through client-side physics simulation. The server sends seeds to the client, which returns actual rarity and play= flag via APK beacons.

**Pool semantics:**

| Pool | play | rarity | Source |
|------|:---:|:---:|--------|
| `playPool` | 1 ✅ | ⚠️ simulated | PLAY beacon (play=1) → `addPlay` |
| `confirmedPool` | 0 ✅ | ✅ no C3032 | PLAY beacon (play=0) → `confirm` |
| `verifiedPool` | 1 ✅ | ✅ client-verified | C3032 beacon → `moveToVerified` |
| `pendingPool` | ? | ✅ crash report | `/crash` POST → `addPending` |

Pools are mutually exclusive within each movie: `verifiedPool` supersedes `playPool`, and startup normalization only deduplicates tiers belonging to that same movie.

**Modes** (not persisted, resets to `natural` on restart):

| Mode | Seed source | Use case |
|------|------------|---------|
| `natural` | verifiedPool → playPool → confirmPool | Production (mimics official) |
| `play` | playPool (isPlayMatch) | Test single seeds manually |
| `test` | playPool(!verified) → pendingPool → unknown | Batch validate via client |

**Beacon flow:**

```
Sent → sentSeeds + sentPlayFlags
  ↓
PLAY beacon: recordPlay → addPlay/confirm + moveToVerified → cleanupPending
C3032 beacon: recordPlay → moveToVerified + confirm → cleanupPending
  ↓
Next gacha/exec: flushAll() — stale sentSeeds → addPlay/confirm/addPending by play flag
```

**Key files:**
- `src/lib/seed-validator.ts` — SeedValidator class + MoviePool data structures
- `src/cn-server.ts:179-256` — Beacon handlers (`parseC3032Beacon`, `parsePlayBeacon`, `/crash`)
- `src/lib/gacha.ts:128` — `flushAll()` call at start of reward
- `web/pages/seeds.html` — Web panel (4 cards: cfgSummary + verified + play + test)
- `src/routes/web_api/seeds.ts` — `/stats` + `/list` + `/mode` APIs
- `assets/{confirmed,purified,verified}_seeds.json` — 只读初始 baseline
- `<DATA_DIR>/state/seeds/seed-state.json` — 唯一运行时权威 seed 状态快照

**APK patches** (starview): `04e-skip-c3032.sh` — Patches 4-7 inject PLAY/C3032 beacons into BallMovie.as at 4 injection points (verifyResultBallRarity, precalculateFieldResult, early return path, complete()).

## 只读 Bundle 与运行时状态

`confirmed_seeds.json`、`purified_seeds.json`、`verified_seeds.json`、`pool_config.json` 和 `test_seeds.json` 在 `assets/` 中只作为首次部署 baseline。仅当 `seed-state.json` 不存在时，服务端才一次性读取这五个文件并归一化为内存状态；快照一旦存在，confirmed、pending、play、verified、config 和 testSeeds 全部只从该快照加载，不再读取或按类别回退 baseline。因此 verified-only 或其他 mixed state 不会让已删除 seed 在重启后复活。

首次实际持久状态修改时，服务端才准备 `DATA_DIR/state/seeds`。每次 mutation 只复制发生变化的 movie 分支，然后把完整 `schemaVersion: 1` 快照写入本次 writer 独有的同目录 `.seed-state.json.<uuid>.tmp`，对文件执行 `fsync` 后通过 `rename` 发布到唯一权威目标 `seed-state.json`；发布失败则回滚内存并只清理本次成功创建的临时文件，不删除其他 writer 或进程中断遗留的 temp。该流程保证进程异常中断后可用新 temp 重试，不包含目录 `fsync`，因此不承诺操作系统或存储设备掉电后的持久性。目标、临时文件或目录若是符号链接或错误文件类型，保存立即失败，且不会回写 `assets/`。state JSON 的语法或结构损坏会阻止启动并保留原文件；baseline 任一文件损坏会记录安全告警并禁止发布不完整快照。

每个 movie 独立执行 `verified > play > confirmed > pending` 优先级，只清理同一 movie 内同 seed 的低层记录；不同 movie 的相同 seed 可独立选择、发送和跟踪。非 canonical state 仅在同一 movie 内存在 tier 冲突时拒绝。重复 mutation、相同 tag/testSeed/selectedMovieId 和同 movie 已 verified seed 的低层回报都返回未变化，不触发完整快照写入。

允许持久化的 movie ID 固定为 `normal`、`normal_guarantee`、`fes`、`fes_guarantee`、`rarity_5_guarantee`，输入必须为原样 trim 的小写字母、数字和下划线，原型键与其他 movie 均拒绝。一般运行时 seed 必须是 `0..2147483647` 的安全整数，对应 Flash MT signed-int32 和 MsgPack 兼容边界；后台 testSeed 进一步限制为当前 CN 动画语料的 `10000000..10399999`。所有动态快照 record 使用无原型对象构建；state store 在 read/write 边界执行 schema 校验和规范化，validator 只接收 store 已校验的 read 结果。stats/list 等只读查询通过 `peekPool` 返回未知 movie 的空结果，不创建 pool 或扩大后续快照；`getMovieIds` 和 `/stats` 始终按固定顺序列出全部五个 movie。

`gacha_movie_seeds*.json` 和 `gacha_rate_up_movie_seeds*.json` 是只读动画语料，始终从 `assets/` 加载，不迁移到 state。`pending_seeds.json`、`blocked_seeds.json` 等未参与当前运行时加载的文件也不创建对应 state 文件。

## 自动净化流程（2026-06-15 新增，2026-06-18 修复稀有度解析）

> 本节由 `gacha-c3032.md` §9 移交至此。

```
手机抽卡 → C3032 crash
    → CrashUtil.debugBeacon GET → /debug 有 loc=...&C3032...&seed=...&movie_id=...
    → parseC3032Beacon() 用 /â(\d)/g 从乱码提取 ball★ 和 char★（★→â）
    → recordDeviceData(seed, ballRarity, charRarity)
    → blockSeed(seed)
    → autoPurify() → r = ball-3 → 移入正确稀有度净化池
```

惊险种子在净化池模式下优先选取，**零 C3032 抽卡**。
