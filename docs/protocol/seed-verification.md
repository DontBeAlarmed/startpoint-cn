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

Pools are mutually exclusive — `verifiedPool` supersedes `playPool`. On startup, `load()` deduplicates across all pools.

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
- `assets/purified_seeds.json`, `assets/confirmed_seeds.json`, `assets/verified_seeds.json` — Persistence

**APK patches** (starview): `04e-skip-c3032.sh` — Patches 4-7 inject PLAY/C3032 beacons into BallMovie.as at 4 injection points (verifyResultBallRarity, precalculateFieldResult, early return path, complete()).

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
