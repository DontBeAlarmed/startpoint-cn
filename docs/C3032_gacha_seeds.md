# C3032 — 抽卡动画稀有度不匹配

## 错误信息

```
ClientError 3032: ガチャ結果レア度不一致
結果レア度=★4, キャラクターレア度=★3
character_id=361009, seed=10006358, movie_id=fes
```

## 前因后果

### 数据流

```
服务端:
  gacha_movie_seeds.json["3"]["0"] → 随机选 seed=10006358
  → movie_id=fes (卡池 movieName="fes")
  → 发送给客户端

客户端:
  seed=10006358 → MersenneTwister(10006358) → 物理模拟
  → ball.rarity=1 (★4) → verifyResultBallRarity()
  → ball.rarity+3(4) != character.rarity(3) → C3032
```

### 根因

`gacha_movie_seeds.json` 和 `gacha_rate_up_movie_seeds.json` 是国际服数据。国际服和国服的**物理配置文件不同**（`gacha/{movie_id}.json` 定义了 `threshold.ballStar4`、`amulet` 位置、重力等参数）。同一个 seed 在国际服物理配置下产生 ★3，在国服物理配置下产生 ★4。

国际服种子池 `["3"]["0"]` 有 162 个 seed，其中混入了在国服物理配置下产生 ★4 的种子。

### 为什么不修复

- 非必现（随机触发，取决于抽到的 seed）
- 修复需要重建 CN 物理配置对应的完整种子表（~500+ seeds）
- 物理配置文件（`gacha/fes.json` 等）在 CN CDN 二进制存档中，未提取为纯文本
- 重建方式：翻译 `FixedFallingField` AS3 物理引擎 → Python → 批量跑 10000 个种子分类
- 估算工作量：2-4 小时，当前优先级不高

## 相关源码位置

### 服务端 — 种子选择和发送

**文件**: `src/lib/gacha.ts:129-152`
```typescript
// 抽卡结果生成
const assetData = getCharacterDataSync(characterId)         // 从 CN character.json 查稀有度
let rarity = 5 - assetData.rarity                            // → rankMovieRates 索引
const movieType = randomPoolItem(1, 101, rankMovieRates[rarity]) // → 动画类型
const seeds = movieSeeds[rarity + 1][movieType]              // → 种子池
const seed = seeds[randomIndex]                              // → 选种子
{
    "character_id": characterId,
    "movie_id": movieType === NORMAL ? movieName : guaranteeName, // → "fes" 等
    "seed": seed
}
```

**数据文件**: `assets/gacha_movie_seeds.json`, `assets/gacha_rate_up_movie_seeds.json`
```
{"3": {"0": [162个★3种子]}, "2": {"0": [...], "1": [...]}, "1": {...}}
  ↑ ★3 NORMAL种子池，部分在国服物理配置下实际产生★4
```

### 客户端 — 物理模拟和校验

**文件**: `wf-2.1.125-cn-decompiled/scripts/scripts/pinball/gacha/ballMovie/fallingField/FallingField.as`
- Line 63-72: `seed → MersenneTwister(seed)` 初始化 RNG
- Line 311: `playProbability = random.randomRangeFloat(0,1)` 第1次消费
- Line 392-401: `createBall()`: X, angle, **probability** 第2-4次消费
- Line 404-416: `createAmulet()`: position, **probability × 2** 每个护符消费3次

**文件**: `wf-2.1.125-cn-decompiled/scripts/scripts/pinball/gacha/ballMovie/fallingField/FixedFallingField.as`
- Line 124-127: `initBallRarity()`: `ball.rarity = ball.probability > threshold.ballStar4 ? 1 : 0`
- Line 129-179: `initAmuletRarity()`: 护符概率 → 升级球稀有度

**文件**: `wf-2.1.125-cn-decompiled/scripts/scripts/pinball/scene/characterGet/ballMovie/BallMovie.as`
- Line 189-196: `verifyResultBallRarity()`: `ball.rarity + 3 == character.rarity` → 不匹配 → C3032

## 修复路径

### 临时方案（立即可用）

```typescript
seed = characterId * 1000  // 确定性种子，绕开随机池
```

### 永久方案（待执行）

1. 从 CN CDN 二进制存档提取 `gacha/{movie_id}.json`（物理配置：thresholds、amulet 位置、重力等）
2. 翻译 AS3 物理引擎 `FixedFallingField` + `FallingField` (~618 行) → Python
3. 批量运行 10000 个种子，按稀有度分类
4. 写入 `gacha_movie_seeds.json`

## 当前状态

- ⚠️ 已知 bug，暂不修复
- 非必现，随机触发
- 不影响功能 —— 只是抽卡动画显示错误，角色正常获得，数据正确写入 DB
