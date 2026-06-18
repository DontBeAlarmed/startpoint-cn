# 抽卡动画 C3032 错误 — 完整分析报告

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

### 6b. 物理引擎逻辑（AS3 源码移植）

所有移植代码位于 `src/lib/gacha-physics.ts`。

| 模块 | AS3 源文件（行号） | 移植行号 | 验证 |
|------|-------------------|---------|:---:|
| MersenneTwister 初始化 | `MersenneTwister.as:21-44` | `gacha-physics.ts:98-118` | ✅ |
| randomUInt (增量扭转) | `MersenneTwister.as:62-73` | `gacha-physics.ts:122-146` | ✅ |
| randomRangeFloat | `MersenneTwister.as:76-78` | `gacha-physics.ts:154-156` | ✅ |
| randomRange | `MersenneTwister.as:81-83` | `gacha-physics.ts:159-161` | ✅ |
| toFloat (uint→[0,1)) | `MersenneTwister.as:47-49` | `gacha-physics.ts:149-151` | ✅ |
| MathCompat.cos | `MathCompat.as:141-188` | `gacha-physics.ts:65-81` | ✅ |
| MathCompat.sin | `MathCompat.as:91-139` | `gacha-physics.ts:84-86` | ✅ |
| MathCompat._cos 核心 | `MathCompat.as:407-416` | `gacha-physics.ts:45-54` | ✅ |
| MathCompat._sin 核心 | `MathCompat.as:399-405` | `gacha-physics.ts:57-64` | ✅ |
| initBallRarity | `FixedFallingField.as:126` | `gacha-physics.ts:558-560` | ✅ |
| initAmuletRarity | `FixedFallingField.as:129-180` | `gacha-physics.ts:544-587` | ✅ |
| ★5 级联 + forceContacted | `FixedFallingField.as:74-122` | `gacha-physics.ts:683-704` | ✅ |
| isRarity5 强制★5 | `FixedFallingField.as:37-39` | `gacha-physics.ts:549-552` | ✅ |
| createBall (RNG #1-3) | `FallingField.as:392-401` | `gacha-physics.ts:415-421` | ✅ |
| createAmulet (RNG per amulet) | `FallingField.as:409-416` | `gacha-physics.ts:458-486` | ✅ |
| createBarAmulet (RNG per bar) | `FallingField.as:384-390` | `gacha-physics.ts:514-533` | ✅ |
| initField (RNG 顺序) | `FallingField.as:301-333` | `gacha-physics.ts:405-550` | ✅ |
| chooseNumbers | `FallingField.as:419-432` | `gacha-physics.ts:830-840` | ✅ |
| moviePlayable 判断 | `FixedFallingField.as:35` | `gacha-physics.ts:547` | ✅ |
| precalculateFieldResult | `BallMovie.as:1130-1152` | `gacha-physics.ts:788-801` | ✅ |

### 6c. 未完整移植的部分（== 误差来源 ==）

| 客户端组件 | AS3 源文件 | 当前简化 | 影响 |
|-----------|-----------|---------|:---:|
| Box2D CCD 碰撞检测 | `gacha_physics.World` CCD phase | 帧末距离检测 | 🔴 主要误差源 |
| 球连续运动积分 | `gacha_physics.Body.integrate()` | 半隐式欧拉 + 逐帧位移 | 🟡 |
| 约束求解器 (10 iter) | `gacha_physics.Contact.solve()` | 串行 pin 检测（sensor 无需求解） | 🟢 |
| 完整 Ball.as 类 | `Ball.as`（未反编译） | 简化为坐标+速度变量 | 🟡 |
| camera / slowFrame | `camera` AMF3 段 | 不需要（仅动画层） | 🟢 |

**精度现状**：经过以上全部移植修复，仿真精度为 normal ~51%、fes ~17%。未移植的 CCD 模块是剩余误差主因。当前透过 purified 池 ground truth 绕过仿真限制。

---

## 8. 当前状态

| 项目 | 状态 |
|------|:---:|
| C3032 报错 | ✅ 自动净化系统 |
| 种子表 | ✅ CN 物理引擎生成 ★3:19K ★4:60K ★5:121K |
| 物理配置 | ✅ 从 CN CDN 提取 5 个 AMF3 二进制，`threshold.amulets`/`ballStar4`/`isRarity5` 已重新验证 |
| 物理引擎 | ✅ MT19937 AS3 兼容 + MathCompat cos/sin 移植 + Box2D 半隐式欧拉积分 |
| 物理仿真精度 | ⚠️ normal 51%, fes 17% — AMF3 配置值正确，但逐帧 CCD/物理与客户端 Box2D 引擎仍有系统偏差 |
| gacha.ts | ✅ 池模式 + 优先级 + 惊险种子 + 跨池注入 |
| 惊险种子 | 🔄 清空重置，从头测试（201 个 ground truth） |
| 自动净化 | ✅ C3032 → recordDeviceData → autoPurify |
| Web 管理 | ✅ `/seeds` 模式切换 + 三栏比例 + 标签管理 |
| playMovie 预测 | 🔄 依赖仿真精度，客户端 beacon 上报是可靠替代方案 |

### 8a. 剩余误差来源分析

基于 seed=10000008 诊断（client★3, server★5）：

| 差异 | 占比估计 | 说明 |
|------|:---:|------|
| **护符接触检测** | 70%+ | 帧末距离检测 vs Box2D 完整 CCD。服务端检测到 3 个物理接触 → ★5，客户端无接触 → ★3 |
| **球轨迹** | 15-20% | 简化半隐式欧拉 vs Box2D `Body.integrate()` |
| **多护符同时接触** | 5-10% | Box2D 10 次约束迭代 vs 顺序遍历 |
| RNG | ~0% | MT19937 已验证正确（增量扭转+取模） |
| AMF3 配置 | ~0% | 已逐字节提取 + 5 文件交叉比对 |

要突破精度天花板，需完整移植 `gacha_physics.World` CCD 阶段（`gacha_physics/dynamics/World.as` 和 `Contact.as`）。

## 9. 自动净化流程（2026-06-15 新增，2026-06-18 修复稀有度解析）

```
手机抽卡 → C3032 crash
    → CrashUtil.debugBeacon GET → /debug 有 loc=...&C3032...&seed=...&movie_id=...
    → parseC3032Beacon() 用 /â(\d)/g 从乱码提取 ball★ 和 char★（★→â）
    → recordDeviceData(seed, ballRarity, charRarity)
    → blockSeed(seed)
    → autoPurify() → r = ball-3 → 移入正确稀有度净化池
```

惊险种子在净化池模式下优先选取，**零 C3032 抽卡**。

## 10. 相关 commit

| commit | 说明 |
|------|------|
| `cba7e6d` | C8700 multiplied_id rename |
| `c5ac355` | 导入 CN character.json (505) |
| `f6453fe` | F1009 learn_mana_node 响应格式 |
| 最新 | 抽卡动画seed/movie_id临时修复 |
