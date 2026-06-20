# 抽卡动画 C3032 错误 — 完整分析报告
> 状态: 已修复(2026-06-15)   关键文件: src/lib/gacha.ts, src/lib/seed-validator.ts   相关端点: /gacha/exec

## 1. 现象

在国服客户端执行角色扭蛋（gacha/exec）后，弹窗报错：

```
C3032: ガチャ結果レア度不一致
結果レア度=★4, キャラクターレア度=★3
character_id=361009, seed=10006358, movie_id=fes
```

堆栈：`BallMovie.verifyResultBallRarity()` → `ClientError(3032)`

## 2. 根因

### 2.1 客户端校验逻辑

**文件**: `wf-2.1.125-cn-decompiled/scripts/scripts/pinball/scene/characterGet/ballMovie/BallMovie.as` (第 168-201 行)

```as3
// verifyResultBallRarity()
_loc6_ = param1 + 3;                    // ball.rarity (0-based) + 3 = 实际稀有度
_loc7_ = character.get_rarity();         // Master Data 中的角色稀有度
if (_loc6_ != _loc7_) throw C3032;      // 不匹配则报错
```

客户端用物理模拟的 `seed` 值跑 MersenneTwister → 球下落物理 → `ball.rarity`。客户端校验 `ball.rarity + 3 == character.rarity`。

### 2.2 服务端种子池缺陷

**文件**: `assets/gacha_movie_seeds.json`

| 稀有度 | 国际服 seeds 数 | CN 预期 seeds 数 | 问题 |
|:---:|:---:|:---:|------|
| ★3 (key "3") | **162** | 506 | 混入产生 ★4 球效果的种子 |
| ★4 (key "2") | 56+44 | 163+44 | 数量不足 |
| ★5 (key "1") | 23+7 | 23+7 | 基本正常 |

国际服的 `gacha_movie_seeds.json` 是从国际服服务器生成的——在国际服物理配置文件（`gacha/normal.json` 等）下，162 个种子都产生 ★3 结果。但国服客户端的物理配置文件不同，同样的种子在国服物理引擎下可能产生 ★4 → `ball.rarity=1` → `1+3=4 ≠ 3(character.rarity)` → C3032。

### 2.3 movie_id="fes" 加剧问题

**文件**: `assets/gacha.json` 中大量卡池的 `movieName` 字段为 `"fes"`。

```json
{ "movieName": "fes", "guaranteeMovieName": "fes" }
```

`movie_id="fes"` 是节日限定动画。客户端 `FixedFallingField` 对 `fes` 动画使用独立的物理配置（`gacha/fes.json`），其 `threshold.ballStar4` 阈值与国际服"normal"动画不同——同样种子在 `fes` 配置下更容易产生 ★4 球 → C3032 概率更高。

### 2.4 数据流与相关源码位置（汇总）

> 本小节合并自简版 `C3032_gacha_seeds.md`，补充完整版缺失的端到端数据流与精确源码行号。

错误信息（客户端原文，`ClientError` 形式）：

```
ClientError 3032: ガチャ結果レア度不一致
結果レア度=★4, キャラクターレア度=★3
character_id=361009, seed=10006358, movie_id=fes
```

#### 数据流

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

#### 服务端 — 种子选择和发送

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

#### 客户端 — 物理模拟和校验

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

## 3. 服务端动画选择逻辑（完整链路）

**文件**: `starpoint-cn/src/lib/gacha.ts` (第 97-163 行)

### 3.1 角色稀有度计算

```typescript
// 原代码（国际服做法）
const rarity = Math.floor(characterId / 100000) - 1
// 例如 351021 → Math.floor(3.51) - 1 = 2 → INDEX 2 = ★3

// 修复后（从 CN character.json 读取）
const assetData = getCharacterDataSync(characterId)
let rarity = assetData !== null ? (5 - assetData.rarity) : (5 - (Math.floor(characterId / 100000) - 1))
rarity = Math.max(0, Math.min(2, rarity))
// rarity: 0=★5, 1=★4, 2=★3
```

### 3.2 电影类型选择

```typescript
const rankMovieRates = [
    [80, 20],   // ★5: 80% NORMAL, 20% GUARANTEE
    [80, 20],   // ★4: 80% NORMAL, 20% GUARANTEE
    [100]       // ★3: 100% NORMAL
]

const movieType = randomPoolItem(1, 101, rankMovieRates[rarity])
// GachaMovieType: NORMAL=0, GUARANTEE=1
```

### 3.3 种子选择（国际服逻辑，已被临时方案替换）

```typescript
const seeds = movieSeeds[rarity + 1][movieType]
// rarity+1 → key: "3"=★3, "2"=★4, "1"=★5
const seedIndex = randomInt(0, seeds.length + 1)
const seed = seeds[seedIndex] ?? seeds[0]
```

**问题**: `movieSeeds["3"]["0"]` 只有 162 个种子（预期 506），部分产生 ★4 球。

### 3.4 临时方案（当前生效）

```typescript
"movie_id": "normal",              // 跳过 fes，避免客户端严格校验
"seed": characterId * 1000         // 确定性种子，绕开损坏的随机池
```

**效果**: C3032 不再触发。缺点：所有抽卡使用相同动画（`normal`），无 GUARANTEE/FES 特效，每个角色种子固定。

## 4. 物理引擎分析

### 4.1 核心源码

| 文件 | 行数 | 作用 |
|------|:---:|------|
| `FixedFallingField.as` | 183 | 确定性球下落物理 |
| `FallingField.as` | 435 | 基础物理引擎 |
| `Ball.as` | ~50 | 球元素状态 |
| `Amulet.as` | ~30 | 护符元素 |

全部位于: `wf-2.1.125-cn-decompiled/scripts/scripts/pinball/gacha/ballMovie/`

### 4.2 确定性模拟逻辑

```
seed → MersenneTwister(seed) → randomRangeFloat() × N 次
```

每次调用消耗 1 个随机值，顺序固定：

| 序号 | 用途 | 影响 |
|:---:|------|------|
| 1 | `playProbability` | 是否播放入场动画 |
| 2 | Ball 初始 X 位置 | — |
| 3 | Ball 弹射角度 | — |
| 4 | **Ball.probability** | 球初始稀有度: `> threshold.ballStar4 → ★4` |
| 5+ | Amulet 位置 + 概率 × N | 球可升级到 ★4/★5 |

**文件**: `FallingField.as` (第 392-401 行 `createBall()`), `FixedFallingField.as` (第 126 行 `initBallRarity()`)

### 4.3 阈值配置（缺失）

物理配置文件 `gacha/{movie_id}.json`（如 `gacha/normal.json`、`gacha/fes.json`）定义了所有阈值：

```json
{
    "threshold": {
        "ballStar4": 0.XX,      // ★4 球阈值
        "amuletTwoUp": 0.XX,    // 护符 +2 升级阈值
        "amulets": [0.XX, ...]  // 各护符启用阈值
    },
    "ball": { "initialXMin": XX, ... },
    "amulet": { "countPerLine": X, "totalCount": X, ... }
}
```

**当前状态**: 这些配置文件存在于国服 CDN 二进制存档（`archive-common-full/*.zip`）中，但为编译后的 orderedmap 格式，未提取为文本 JSON。

## 5. 永久修复路径（5 步）

### 步骤 1：提取物理配置

从 CN CDN 二进制存档中定位并提取 `gacha/{movie_id}.json` 的文本版本。

**当前阻塞**: CDN 322 个 ZIP 中是二进制 orderedmap 格式，需要编写解码器或从客户端 SWF 反编译提取。

### 步骤 2：翻译物理引擎

AS3 `FixedFallingField` (183行) + `FallingField` 确定性部分 (约 80 行) → Python 约 50 行。

核心：MersenneTwister 消费顺序 + 阈值比较，无需真实物理模拟。

```python
def simulate_seed(seed: int, config: dict) -> int:
    rng = MersenneTwister(seed)
    playProb = rng.random()
    ballX = rng.random()
    ballAngle = rng.random()
    ballProb = rng.random()
    ballRarity = 1 if ballProb > config['threshold']['ballStar4'] else 0
    # Amulet upgrades...
    return ballRarity  # 0=★3, 1=★4, 2=★5
```

### 步骤 3：批量运行

```python
for seed in range(10000000, 10010000):
    rarity = simulate_seed(seed, config)
    seeds[str(rarity + 1)]["0"].append(seed)
```

### 步骤 4：写入文件

替换 `assets/gacha_movie_seeds.json` 和 `assets/gacha_rate_up_movie_seeds.json`。

### 步骤 5：还原代码

将 `lib/gacha.ts` 中的临时方案（`seed = characterId * 1000`, `movie_id = "normal"`）还原为完整的随机种子 + 动画选择逻辑。

**预估**: 1-2h（物理配置提取可能占大部分时间）

## 6. 永久修复（已完成 2026-06-15）

### 步骤 1：提取 CN 物理配置 ✅

从 CN CDN `archive-common-full` 中提取 4 个 gacha 动画配置文件：

| 文件 | CDN 路径 | 大小 |
|------|----------|:---:|
| `normal.amf3` | `production/upload/9d/29fc191c...` | 807B |
| `fes.amf3` | `production/upload/95/dc776712...` | 811B |
| `normal_guarantee.amf3` | `production/upload/1c/fc6f0f07...` | 807B |
| `rarity_5_guarantee.amf3` | `production/upload/4a/4fb93779...` | 790B |

提取流程：
1. 找到 hash 算法：`SHA1(path + "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnGy")`
   - path = `gacha/{movie_id}.gacha.amf3.deflate`
   - `AssetPathTools.as:14` 硬编码 salt
2. 从 `starpoint-cn/.cdn/cn/archive-common-full/*.zip` 定位文件
3. zlib raw deflate 解压 → AMF3 binary

关键阈值（4 个配置基本一致）：

```
ballStar4:     0.7583    (球初始 ★4 概率阈值)
amuletTwoUp:   0.8148    (护符 +2 升级阈值)
playMovie:     0.8995    (播放入场动画概率)
amulets[6]:    0.9022    (第 6 个护符启用阈值)
其余 amulets:  null 或 0   (全部禁用)
```

### 步骤 2：移植物理引擎 ✅

**文件**: `src/lib/gacha-physics.ts`

实现内容（~400 行 TypeScript）：
- MT19937 MersenneTwister 完整移植（624 元素状态数组 + 燃烧）
- `FallingField.initField()` RNG 消费顺序（ball ×4, playProbability ×1, pins, amulets）
- `FixedFallingField.initBallRarity()` / `initAmuletRarity()` 阈值判定
- 简化 2D 物理引擎：重力积分 + circle-circle 碰撞 + 弹性反弹 + 护符接触检测
- `performAmuletContacted()` ★5 升级全接触逻辑

### 步骤 3：批量生成种子表 ✅

```
$ node -e "generateSeedPools()"
Scanned 200001 seeds in 14s (~15K seeds/sec)
★3: 13169  ★4: 45108  ★5: 141724
```

写入 `assets/gacha_movie_seeds.json` 和 `assets/gacha_rate_up_movie_seeds.json`。

### 步骤 4：还原 gacha.ts ✅

恢复完整的随机种子 + 动画选择逻辑：
- `rankMovieRates` 选择 NORMAL(80%) / GUARANTEE(20%) 动画类型
- CN 种子池随机选取对应稀有度的 seed
- `movie_id` 按动画类型选择 `movieName` 或 `guaranteeMovieName`

## 7. 参数来源

### 6a. 物理配置参数（AMF3 二进制提取）

5 个元文件位于 `assets/gacha_movie_configs/`，从 CN CDN `archive-common-full` 中的 `gacha/{movie}.gacha.amf3.deflate` zlib 解压后提取。

#### field（物理世界边界）

| 参数 | AMF3 值 | 源文件 | AS3 引用 | 跨 movie |
|------|------|---------|---------|:---:|
| `width` | 1080 | `normal.amf3` | `FallingField.initWall:271` | 🟢 无差异 |
| `height` | 3840 | ↑ | ↑ | 🟢 |
| `gravityX` | 0 | ↑ | `FallingField.initField:306` | 🟢 |
| `gravityY` | 0.9 (double) | ↑ | ↑ | 🟢 |
| `wallRestitution` | 1 | ↑ | `FallingField.initWall:277` | 🟢 |

#### ball（球创建参数）

| 参数 | AMF3 值 | 源文件 | AS3 引用 | 跨 movie |
|------|------|---------|---------|:---:|
| `initialXMin` | 100 | `normal.amf3` | `FallingField.createBall:394` | 🟢 |
| `initialXMax` | 880 | ↑ | ↑ | 🟢 |
| `initialY` | 200 | ↑ | `createBall:395` | 🟢 |
| `ejectionVelocity` | 15 | ↑ | `createBall:397-398` | 🟢 |
| `ejectionAngleMin` | 40 | ↑ | `createBall:396` | 🟢 |
| `ejectionAngleMax` | 140 | ↑ | ↑ | 🟢 |
| `radius` | 48 | ↑ | `createBall:401` | 🟢 |
| `maxSpeed` | 35 | ↑ | `createBall:399`（仅记录，不强制） | 🟢 |

#### pin（弹射钉子）

| 参数 | AMF3 值 | 源文件 | AS3 引用 | 跨 movie |
|------|------|---------|---------|:---:|
| `countPerLine` | 4 | `normal.amf3` | `FallingField.initPins:286` | 🟢 |
| `lineCount` | 12 | ↑ | ↑ | 🟢 |
| `firstLineY` | 1070 | ↑ | `createPin:378` | 🟢 |
| `evenLineOffsetRatio` | 0.25 (double) | ↑ | `createPin:376` | 🟢 |
| `oddLineOffsetRatio` | -0.25 (double) | ↑ | `createPin:376` | 🟢 |
| `distanceHorizontal` | 290 | ↑ | `createPin:377` | 🟢 |
| `lineDistance` | 165 | ↑ | `createPin:380` | 🟢 |
| `verticalRestitution` | 0.7 (double) | ↑ | `createPin:381` | 🟢 |
| `horizontalRestitution` | 0.7 (double) | ↑ | `createPin:381` | 🟢 |
| `totalCountMin` | 30 | ↑ | `initPins:287` | 🟢 |
| `totalCountMax` | 35 | ↑ | `initPins:287` | 🟢 |
| `radius` | 24 | ↑ | `Pin.as:26` | 🟢 |

#### amulet（圆形护符 — 稀有度升级道具）

| 参数 | AMF3 值 | 源文件 | AS3 引用 | 跨 movie |
|------|------|---------|---------|:---:|
| `countPerLine` | 3 | `normal.amf3` | `FallingField.initAmulets:344` | 🟢 |
| `lineCount` | 14 | ↑ | ↑ | 🟢 |
| `firstLineY` | 1630 | ↑ | `createAmulet:412` | 🟢 |
| `evenLineOffsetRatio` | -0.25 (double) | ↑ | `createAmulet:409` | 🟢 |
| `oddLineOffsetRatio` | 0.25 (double) | ↑ | `createAmulet:409` | 🟢 |
| `distanceHorizontal` | 290 | ↑ | `createAmulet:410` | 🟢 |
| `lineDistance` | 165 | ↑ | `createAmulet:413` | 🟢 |
| `radius` | 40 | ↑ | `createAmulet:416` | 🟢 |
| `totalCount` | 5 / **7** | ↑ | `initAmulets:345` | 🔴 fes/fes_guar 不同 |
| `limitTotalCount` | false | ↑ | `FixedFallingField:150` | 🟢 |
| `decideTwoUpWhenAppear` | false | ↑ | `FixedFallingField:152` | 🟢 |

#### barAmulet（横向条形护符）

| 参数 | AMF3 值 | 源文件 | AS3 引用 | 跨 movie |
|------|------|---------|---------|:---:|
| `totalCount` | 5 | `normal.amf3` | `FallingField.initAmulets:357` | 🟢 |
| `lineCount` | 40 | ↑ | `initAmulets:356` | 🟢 |
| `firstLineY` | 3025 | ↑ | `createBarAmulet:387` | 🟢 |
| `lineDistance` | 165 | ↑ | `createBarAmulet:387` | 🟢 |
| `height` | 1 | ↑ | `createBarAmulet:389` | 🟢 |

#### threshold（稀有度阈值 — 每 movie 不同）

| 参数 | normal | fes | normal_guarantee | fes_guarantee | rarity_5_guar | 源引用 |
|------|--------|-----|:---:|:---:|:---:|------|
| `ballStar4` | 0.7582740783691406 | 0.7429313659667969 | 3.814697265625e-05 | 3.814697265625e-05 | 0 | `FixedFallingField:126` |
| `amuletTwoUp` | 0.8148193359375 | 0.475677490234375 | 0.5 | 0.5 | 0 | `FixedFallingField:147` |
| `playMovie` | 0.8995208740234375 | 0.8994979858398438 | 0.9299392700195312 | 0.8994979858398438 | 0 | `FixedFallingField:35` |
| `isRarity5` | - | - | - | - | true | `FixedFallingField:37-39` |
| `amulets[]` | [0,0,0,0,0,0.9022] | [0,0,0,0,0,0,0,0.7191] | [0,0,0,0,0.1899,1] | [0,0,0,0,0,0.626,0.999,1] | [0,0,0,0,0,0] | `FixedFallingField:148` |

`threshold.amulets[]` 有效阈值索引（AS3: `amulet.probability > Number(threshold.amulets[i])`）：

| Movie | 有门槛的索引 | 阈值 | 适用于 |
|-------|:---:|------|------|
| normal | 5 | 0.9022 | 第 6 个护符（5 圆圈后第 1 个条形） |
| fes | 7 | 0.7191 | 第 8 个护符（7 圆圈后第 1 个条形） |
| normal_guarantee | 4 | 0.1899 | 第 5 个护符（5 圆圈最后 1 个） |
| fes_guarantee | 5, 6 | 0.626, 0.999 | 第 6、7 个护符 |
| rarity_5_guarantee | 无 | 全 0 | isRarity5=true 直接跳过物理 |

### 6c. 物理引擎移植验证

所有移植代码位于 `src/lib/gacha-physics.ts`。

| 模块 | AS3 源文件（行号） | 移植行号 | 验证 |
|------|-------------------|---------|:---:|
| MersenneTwister 初始化 | `MersenneTwister.as:21-44` | `gacha-physics.ts:98-118` | ✅ |
| randomUInt (增量扭转+pre-twist temper) | `MersenneTwister.as:62-73` | `gacha-physics.ts:122-146` | ✅ 2026-06-18 修复 |
| MathCompat.cos/sin | `MathCompat.as:141-188` | `gacha-physics.ts:39-86` | ✅ |
| initBallRarity | `FixedFallingField.as:126` | `gacha-physics.ts:558-560` | ✅ |
| initAmuletRarity | `FixedFallingField.as:129-180` | `gacha-physics.ts:544-587` | ✅ |
| ★5 级联 + forceContacted | `FixedFallingField.as:74-122` | `gacha-physics.ts:683-704` | ✅ |
| isRarity5 强制★5 | `FixedFallingField.as:37-39` | `gacha-physics.ts:549-552` | ✅ |
| createBall/Amulet/BarAmulet | `FallingField.as:301-333` | `gacha-physics.ts:405-550` | ✅ |
| step() 运动前护符检测 | `World.step() Phase A` | `gacha-physics.ts:634-674` | ✅ |

### 6d. 未完整移植的部分（== 剩余 15% 误差来源 ==）

| 客户端组件 | AS3 源文件 | 当前简化 | 影响 |
|-----------|-----------|---------|:---:|
| Box2D BroadPhase 选择性扫描 | `BroadPhaseSelectiveSweep.as` | 无（逐个遍历） | 🟡 ★5 接触检测 |
| 接触持久化管理 | `ContactManager.as` | `contacted` flag | 🟡 |
| ContactEventManager | `ContactEventManager.as` | 无 | 🟢 |
| 约束求解器 | `Contact.solve()` | 不需要（sensor 无需求解） | 🟢 |

**精度现状**：经过 RNG tempering 修复，仿真精度 **normal 81%, fes 85%**。★3/★4 预测 ~93%，★5 预测 ~4%。未移植的 contact persistence/broadphase 是 ★5 漏检的剩余主因。

---

## 8. 当前状态

| 项目 | 状态 |
|------|:---:|
| C3032 报错 | ✅ 自动净化系统 |
| 种子表 | ✅ 1,000,000 种子（fes 400K, normal 400K, guarantee 各 100K）。三模式选取：natural/play/test |
| 物理配置 | ✅ 从 CN CDN 提取 5 个 AMF3 二进制，`threshold.amulets`/`ballStar4`/`isRarity5` 已重新验证 |
| 物理引擎 | ✅ MT19937 AS3 兼容 + MathCompat cos/sin 移植 + Box2D 半隐式欧拉积分 |
| 物理仿真精度 | ✅ rarity ~85%（RNG tempering 修复后）。playMovie ~5%（不可靠——playProbability 被 RNG 重试偏移） |
| RNG tempering | ✅ 修复：pre-twist 值 tempering（精度 17% → 85%） |
| 惊险种子 | ✅ C3032→beacon→purified(play=1) 或 confirmed(play=0) |
| 自动净化 | ✅ 简化模型：unknown→confirmed（1 次无 crash）→purified（play=1 beacon） |
| Web 管理 | ✅ 三模式切换 + 组选择器 + 5 列 purified（★3/★4/★4保底/★5/★5保底）+ 标签管理 |
| playMovie 预测 | ✅ client PLAY beacon 100% 准确。purified play=1 种子天然可靠 |
| gacha 抽卡去重 | ✅ flat array 按原始随机顺序，不再 group 同一角色 |
| 自然模式 | ✅ drawIndex=0 强制 playPool（对齐客户端），后续 10%。⚠️ normal_guarantee ~7% 播放率未对齐（playMovie=0.9299 vs 0.8995） |
| gacha.ts | ✅ 池模式 + 优先级 + 惊险种子 + 跨池注入 |
| 惊险种子 | 🔄 从头测试（500K 种子，play= beacon 已部署） |
| 自动净化 | ✅ C3032 → recordDeviceData → autoPurify |
| Web 管理 | ✅ `/seeds` 模式切换 + 三栏比例 + 标签管理 |
| playMovie 预测 | 🔄 依赖仿真精度，客户端 beacon 上报是可靠替代方案 |

### 8a. 仿真精度分析（2026-06-19 更新）

**rarity 预测**：~85%（基于 purified ground truth 360 种子）

**playMovie 预测**：~5%（基于 18 个 `confirmed_play` 种子实测）。`playProbability` 是 RNG 最后一位——前置 `chooseNumbers()` 重试次数偏移导致 RNG 位置不同，服务端读到的值和客户端**完全不相关**。**playMovie 无法通过仿真预测，唯一可靠来源是客户端 PLAY beacon（`play=1`）。**

### 8b. purified_r3 = 0 原因

★3 ball + play=1 物理上极难发生：

```
moviePlayable=true (10%) → fes 7 圆形护符 + 5 全宽条形护符覆盖整个下落区域
  → 球穿过时几乎必然碰到至少 1 个护符 → 升级到 ★4/★5
  → 循环结束后 ball.rarity ≠ ★3

moviePlayable=false (90%) → 球停在 ★3 → 但 play=0 → 进入 confirmed 而非 purified
```

**puified_r3 = 0 是物理必然，不是 bug。** ★3 可播放种子通过 `confirmed_play` 机制收集（客户端 PLAY beacon play=1 → 不区分稀有度）。

### 8c. 种子池简化模型（三池）

| 池 | 含义 | 来源 |
|----|------|------|
| unknown | 未测试 | 仿真生成（rarity 85% 准确） |
| confirmed / confirmed_play | rarity 正确 / 确认可播放 | 发送 1 次无 C3032 / PLAY beacon play=1 |
| purified | rarity 正确 + 可播放 | C3032 beacon + play=1（仅 ★4/★5） |

选取优先级（purified mode）：testSeed > purified(r===ri) > confirmed_play > unknown

修复历史：
- RNG temering bug（2026-06-18）：`randomUInt()` 对 POST-TWIST 值做 tempering，AS3 用 PRE-TWIST 值。修复后精度飞跃 17% → 85%。
- threshold.amulets 越界（2026-06-18）：JS `?? 0` 让越界索引激活，AS3 `Number(undefined)=NaN` 永不激活。修复后 fes_guarantee 从 37% → 90%。

## 9. 自动净化流程

> 种子净化/验证详见 ./seed-verification.md

## 10. 相关 commit

| commit | 说明 |
|------|------|
| `cba7e6d` | C8700 multiplied_id rename |
| `c5ac355` | 导入 CN character.json (505) |
| `f6453fe` | F1009 learn_mana_node 响应格式 |
| 最新 | 抽卡动画seed/movie_id临时修复 |
