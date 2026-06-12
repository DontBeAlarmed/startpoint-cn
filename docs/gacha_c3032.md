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

## 6. 辅助工具

**文件**: `scripts/extract_seeds.py` (87 行)

从 mitmproxy 流量文件中提取种子表。需要的输入：国服官方服务器的 `gacha/exec` 响应抓包。国服已关服，工具当前不可用。

## 7. 当前状态

| 项目 | 状态 |
|------|:---:|
| C3032 报错 | ✅ 临时方案已消除 |
| 种子表（★3） | ⚠️ 162 seeds (国际服)，混入 ★4 |
| 种子表（★4/★5） | ⚠️ 国际服数据，CN 兼容性待验证 |
| 物理配置 | ❌ 未提取 |
| 永久修复 | ⏳ 待物理配置就绪后执行 §5 步骤 |

## 8. 相关 commit

| commit | 说明 |
|------|------|
| `cba7e6d` | C8700 multiplied_id rename |
| `c5ac355` | 导入 CN character.json (505) |
| `f6453fe` | F1009 learn_mana_node 响应格式 |
| 最新 | 抽卡动画seed/movie_id临时修复 |
