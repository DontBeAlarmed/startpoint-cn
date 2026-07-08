# 卡池生成逻辑

> 状态: 已采用 `gacha_odds` 重建 `assets/gacha.json`
> 关键文件: `assets/cdndata/gacha.json`, `assets/gacha.json`, `tools/gacha_odds_export.cjs`, `tools/rebuild_gacha_from_odds.cjs`

本文说明离线服务端的普通卡池数据如何从 CN CDN 还原。这里的“卡池”指 `assets/gacha.json` 中每个 banner 的可抽取角色/装备列表、UP 标记和同星级内权重。

## 目标

旧转换链路会把当前角色/装备表按类型、星级或属性扩进历史池，导致早期池混入后期角色，属性复刻池也只能靠名称或属性规则推断。

新链路改为使用 CDN 自带的 `gacha_odds` 表:

- `assets/cdndata/gacha.json` 决定有哪些卡池，以及每个卡池引用哪些 odds 表。
- `master/gacha_odds/<odds_id>.orderedmap` 决定该池在对应星级下的实际条目和权重。
- 生成器不再做属性过滤、ID 范围推断或“当前全角色表补全”。

## 数据来源

### 卡池主表

`assets/cdndata/gacha.json` 来自 CDN master 数据。生成器逐个读取其中的 gacha row，并使用固定列位:

| 列 | 含义 | 用途 |
| ---: | --- | --- |
| `1` | 展示名 | 写入 `name` |
| `4` | 页面类型 | 写入 `pageKind` |
| `5` | 单抽消耗 | 写入 `singleCost` |
| `6` | 十连消耗 | 写入 `multiCost` |
| `7` | 折扣消耗 | 写入 `discountCost` |
| `8` | 每账号一次十连消耗 | 写入 `tenTimesPerAccountCost` |
| `10` | 保底星级 | 写入 `guaranteeRarity`, 用于生成保底组星级权重 |
| `11` | 星级概率 odds id | 写入 `rarityOddsId`, 并生成 `rankRates` |
| `13` | `prize_kind` | `0` 角色池, `1` 装备池 |
| `14` | 角色 3 星 odds id | 角色池 `pool["3"]` |
| `15` | 角色 4 星 odds id | 角色池 `pool["2"]` |
| `16` | 角色 5 星 odds id | 角色池 `pool["1"]` |
| `17` | 普通动画名 | 角色池 `movieName` |
| `18` | 保底动画名 | 角色池 `guaranteeMovieName` |
| `19` | UP 作为试读标记 | 角色池 `toUseOddsUpAsTrialReading` |
| `20` | 通用角色券可用 | 角色池 `wildcardTicketAvailable` |
| `21` | Start Dash 兑换可用 | 角色池 `canBeStartDashExchange` |
| `22` | 装备 3 星 odds id | 装备池 `pool["3"]` |
| `23` | 装备 4 星 odds id | 装备池 `pool["2"]` |
| `24` | 装备 5 星 odds id | 装备池 `pool["1"]` |
| `25` | 装备动画概率 id | 装备池 `equipmentMovieProbabilityId` |
| `26` | 通用装备券可用 | 装备池 `wildcardTicketAvailable` |
| `27` | 单抽券 item id | 写入 `onceTicketItemId` |
| `28` | 十连券 item id | 写入 `tenTicketItemId` |
| `29` | 开始时间 | 写入 `startDate` |
| `30` | 结束时间 | 写入 `endDate` |

卡池类型严格使用 `row[13]` 的 `prize_kind`，不再通过装备名、ID 范围或池名猜测。

### odds 文件

odds 文件逻辑路径为:

```text
master/gacha_odds/<odds_id>.orderedmap
```

真实 CDN 文件路径按客户端资源 hash 规则定位:

```text
sha1(logicalPath + "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy")
```

生成器默认会在仓库根目录和一级子目录中查找:

```text
WorldFlipper/dummy/download/production/upload
```

当前本地包命中的是 `弹国服/WorldFlipper/dummy/download/production/upload`。

`gacha_odds` 是双层 orderedmap。外层 key 是 odds id，内层每行是 CSV 文本:

| 类型 | 行格式 |
| --- | --- |
| 星级 odds | `rarity,weight` |
| 角色 odds | `characterId,rarity,weight,oddsUp,isLimited,isExchangeable,trialReadingForced` |
| 装备 odds | `equipmentId,rarity,weight,oddsUp,isLimited,isExchangeable` |

`tools/gacha_odds_export.cjs` 会完整导出这些字段；`assets/gacha.json` 写入运行时需要的抽取、兑换、券和基础页面类型字段。

## 页面和券规则

生成器会保留反编译 `GachaValues.as` 中的 page kind:

| `pageKind` | 官方枚举 |
| ---: | --- |
| `0` | `Normal` |
| `1` | `TenTimesPerAccount` |
| `2` | `TicketOnly` |
| `3` | `OneTimeTicketOnly` |
| `4` | `TenTimesTicketOnly` |
| `5` | `CrazyTenTimesTicketOnly` |
| `6` | `OneTime` |
| `7` | `TenTimes` |
| `8` | `WithoutDaily` |

运行时规则位于 `src/lib/gacha-rules.ts`:

- 兑换必须命中当前卡池 pool，且对应条目 `isExchangeable=true`。
- 券抽优先使用 `onceTicketItemId` / `tenTicketItemId`。
- 没有专属券时，只有 `wildcardTicketAvailable=true` 才回退到通用券。
- `OneTimeTicketOnly` 只允许单抽券。
- `TenTimesTicketOnly` / `CrazyTenTimesTicketOnly` 只允许十连券。
- `TicketOnly` 系列不允许宝珠抽。
- `WithoutDaily` 不允许每日付费单抽。

## 执行架构

为了后续按官方 `GachaLogic` 逐步补齐特殊池行为，`/gacha/exec` 已拆出执行计划层:

- `src/lib/gacha-exec-plan.ts` 只负责把请求、玩家卡池状态、券数量和 campaign 状态转换为执行计划。
- 执行计划包含抽数、扣除后的免费/付费星导石、券消耗和 campaign 消耗。
- `src/routes/api/gacha.ts` 仍负责数据库读写、发奖、抽卡历史和协议响应。
- `src/lib/gacha.ts` 只负责抽取、发放奖励和抽卡动画结果。
- `src/lib/gacha-rules.ts` / `src/lib/gacha-ticket.ts` 保留 page kind、券类型和兑换基础规则。

当前执行计划层保持既有行为，不新增 Star Heroes、福袋、crazy ticket 等特殊逻辑；这些后续应优先在 `gacha-exec-plan.ts` 和 page kind 策略中补齐，再接入路由副作用。

## 星级权重

`row[11]` 指向星级 odds 表。生成器会把官方 raw weight 归一化到 1000，写入 `rankRates`:

```json
{
  "rarityOddsId": "normal_rarity",
  "guaranteeRarity": 4,
  "rankRates": {
    "normal": [50, 250, 700],
    "multiGuarantee": [50, 950]
  }
}
```

`rankRates.normal` 对应普通抽取的 5/4/3 星概率，顺序固定为:

```text
[5星, 4星, 3星]
```

`rankRates.multiGuarantee` 对应十连保底位，顺序固定为:

```text
[5星, 4星]
```

保底位计算规则来自反编译源码 `decompile/scripts/pinball/common/data/gacha/GachaRarityOddsLogic.as`:

- 低于 `guaranteeRarity` 的星级权重置 0。
- 被置 0 的低星权重累加到 `guaranteeRarity`。
- 分母仍使用原始星级 odds 总权重。

例子:

| odds id | `guaranteeRarity` | `normal` | `multiGuarantee` |
| --- | ---: | --- | --- |
| `normal_rarity` | 4 | `[50,250,700]` | `[50,950]` |
| `equipment_normal_rarity` | 4 | `[50,250,700]` | `[50,950]` |
| `fes_rarity` | 4 | `[75,250,675]` | `[75,925]` |
| `rare_rarity` | 4 | `[50,950,0]` | `[50,950]` |
| `rearity_5_guarantee_rarity` | 4 | `[1000,0,0]` | `[1000,0]` |
| `normal_rarity` | 5 | `[50,250,700]` | `[1000,0]` |

## 输出格式

`assets/gacha.json` 每个池保持现有运行时结构:

```json
{
  "type": 0,
  "paymentType": 0,
  "pageKind": 0,
  "singleCost": 150,
  "multiCost": 1500,
  "discountCost": 50,
  "onceTicketItemId": 20001,
  "tenTicketItemId": 20002,
  "wildcardTicketAvailable": false,
  "rarityOddsId": "normal_rarity",
  "guaranteeRarity": 4,
  "rankRates": {
    "normal": [50, 250, 700],
    "multiGuarantee": [50, 950]
  },
  "movieName": "normal",
  "guaranteeMovieName": "normal_guarantee",
  "startDate": "2000-01-01 00:00:00",
  "endDate": "2099-01-01 00:00:00",
  "name": "开服纪念扭蛋",
  "pool": {
    "1": [{ "id": 111001, "rank": 5, "odds": 1, "isRateUp": false, "isLimited": false, "isExchangeable": false, "trialReadingForced": false, "rarity": 66.67 }],
    "2": [],
    "3": []
  }
}
```

池 key 仍沿用旧运行时约定:

| `pool` key | 星级 |
| --- | ---: |
| `"1"` | 5 星 |
| `"2"` | 4 星 |
| `"3"` | 3 星 |

每个条目的 `rarity` 是同一星级池内的抽取权重，计算方式与旧 converter 保持一致:

```text
rarity = round((entry.weight / totalWeightOfSamePool) * 1000, 2)
```

运行时 `src/lib/gacha.ts` 先用 `rankRates` 抽星级，再在对应 `pool[key]` 中按条目的原始 `odds` 抽具体角色/装备。因此这里的 `rarity` 不是角色本身星级，而是给前端/报告使用的同星级池内 0-1000 展示权重；实际抽取使用未四舍五入的官方 `odds`。

## 生成方法

只导出 odds 解析结果:

```bash
node tools/gacha_odds_export.cjs --out out/gacha_odds_export.json
```

预览重建结果并输出差异，不替换 `assets/gacha.json`:

```bash
node tools/rebuild_gacha_from_odds.cjs --no-write \
  --old-out out/gacha_before_odds.dryrun.json \
  --diff-out out/gacha_odds_diff.dryrun.json
```

正式替换 `assets/gacha.json` 并保留旧快照和差异报告:

```bash
node tools/rebuild_gacha_from_odds.cjs \
  --old-out out/gacha_before_odds.json \
  --diff-out out/gacha_odds_diff.json
```

默认输出:

| 文件 | 含义 |
| --- | --- |
| `assets/gacha.json` | 替换后的运行时卡池 |
| `out/gacha_before_odds.json` | 替换前快照 |
| `out/gacha_odds_diff.json` | 旧/新卡池差异报告 |
| `out/gacha_odds_export.json` | odds 原始解析导出 |

`out/` 已被 `.gitignore` 忽略，属于本地分析产物。

## 差异报告

`tools/rebuild_gacha_from_odds.cjs` 会比较旧 `assets/gacha.json` 和新生成结果:

- banner 数量变化: 新增、删除、比较总数。
- meta 变化: 除 `pool` 外的字段差异。
- pool 变化: 每个星级池的数量、added、removed、changed。
- item 变化: 比较 `rank`, `odds`, `isRateUp`, `rarity`。

2026-07-05 首次按 odds 替换池内容的汇总:

```text
banners old=584 new=584 changed=576 added=0 removed=0
pool changes: banners=576 items added=7647 removed=25919 changed=82362
```

2026-07-05 接入官方星级权重后的汇总:

```text
banners old=584 new=584 changed=584 added=0 removed=0
pool changes: banners=0 items added=0 removed=0 changed=0
```

第二次差异只新增/更新 meta 字段，池成员没有变化。

2026-07-05 接入 page kind、券、兑换字段后的汇总:

```text
banners old=584 new=584 changed=584 added=0 removed=0
pool changes: banners=584 items added=0 removed=0 changed=109263
```

第三次差异没有新增/删除池成员，变化集中在 banner meta 和条目级官方附加字段。

抽样读回:

```text
卡池总数: 584
角色池: 493
装备池: 91
banner 1: 5星 15 / 4星 27 / 3星 49
banner 3: 5星 6 / 4星 14 / 3星 20
banner 52 的 121015: odds=129, isRateUp=true, rarity=300
```

## 严格还原边界

当前链路能严格还原:

- 每个历史池引用的角色/装备 odds id。
- 每个星级池中的成员列表。
- 同星级内每个成员的 weight、UP 标记和归一化权重。
- 每个池的普通星级概率 `rankRates.normal`。
- 每个池的保底位星级概率 `rankRates.multiGuarantee`。
- 每个条目的 `isLimited`, `isExchangeable`, `trialReadingForced`。
- 每个池的 `pageKind`、专属券 item id、通用券可用标记。
- 兑换时的当前池成员和 `isExchangeable` 校验。
- 券抽时的 page kind 和专属/通用券校验。
- 角色池/装备池类型。
- 角色池的普通/保底动画字段。
- 装备抽卡动画概率。`equipment_movie_probability_id` 写入 `equipmentMovieProbabilityId`，执行抽卡时从 `assets/equipment_gacha_movie_probability.json` 读取概率表，按反编译 `GachaExecDummyRemote` 的顺序生成 `is_erupt` 和每件装备的 `treasure_up_type`。

当前链路不处理:

- Star Heroes 等每账号一次十连的完整付费渠道细节。当前已按 `pageKind=1` 做一次性十连限制和成本读取，但官方付费 UI/请求分支仍需实测确认。
- Start Dash / wildcard 交换等特殊 UI 展示行为。字段已保留，服务端只消费券和兑换必要字段。

因此，“严格还原历史池”在当前实现中已经覆盖池内容、同星级内权重、普通星级权重、保底位星级权重、page kind、券 ID、基础兑换限制和装备动画概率；剩余缺口主要是少数特殊 UI/付费分支。

## 验证

生成器测试:

```bash
node tools/gacha_odds_export.test.cjs
node tools/rebuild_gacha_from_odds.test.cjs
node tools/gacha_draw_weights.test.cjs
node tools/gacha_rules.test.cjs
node tools/gacha_exec_plan.test.cjs
node tools/gacha_equipment_movie.test.cjs
```

`rebuild_gacha_from_odds.test.cjs` 覆盖:

- 从 CDN odds 生成 584 个卡池。
- `banner 1` 的角色池数量和首个 5 星条目。
- `banner 3` 的装备池数量和首个 5 星条目。
- `banner 52` 的 UP 角色 `121015` 权重。
- 普通、装备、FES、4 星以上、5 星保底池的 `rankRates`。
- `pageKind`、专属券、通用券、装备动画概率 id。
- 条目级 `isLimited` / `isExchangeable` / `trialReadingForced`。
- `diffGacha` 的 removed 和 changed 项。

`gacha_draw_weights.test.cjs` 覆盖:

- 0 权重不会被边界 roll 抽中。
- FES 7.5%/92.5% 的边界。
- 5 星保底 `[1000,0]` 的边界。
- 10 连和多组 10 连的保底位 metadata。

`gacha_rules.test.cjs` 覆盖:

- 专属券优先于通用券。
- wildcard 关闭时不允许通用券。
- 角色/装备券类型不能串用。
- `isExchangeable=false` 不能兑换。
- `OneTimeTicketOnly` / `TenTimesTicketOnly` / `WithoutDaily` 的基础 page kind 约束。

`gacha_exec_plan.test.cjs` 覆盖:

- 免费星导石不足时使用付费星导石补足。
- 每日付费单抽消耗。
- 专属券消耗和多张十连券抽数。
- 免费 campaign 抽取状态消耗。
- 每账号一次十连的重复抽取限制。

`gacha_equipment_movie.test.cjs` 覆盖:

- `equipmentMovieProbabilityId` 概率表读取。
- 5 星装备触发 `is_erupt` 的概率分支。
- `is_erupt=true` 时所有装备 `treasure_up_type=0`。
- 保底位使用 guarantee treasure-up 概率。

## 按需提取 odds 文件（替代 assets/gacha_odds）

`assets/gacha_odds/` 曾缓存全部 113,367 个 CDN orderedmap 文件(6.5GB)。
`tools/extract_odds_from_cdn.cjs` 改为按需提取,仅生成需要的 ~800 个 odds 文件(<50MB)。

### 使用方法

```bash
# 首次或 cdndata/gacha.json 变更时
node tools/extract_odds_from_cdn.cjs          # 完整流程: 构建索引 + 提取
node tools/extract_odds_from_cdn.cjs --build-index  # 仅重建索引(归档变更时)
node tools/extract_odds_from_cdn.cjs --extract      # 仅提取(需已有索引)

# 重建 gacha.json
node tools/rebuild_gacha_from_odds.cjs --store tmp/gacha_odds
```

### 原理

1. 扫描 `.cdn/cn/` 下全部 677 个 zip 归档, 建立文件路径→归档名映射(缓存为 `.cdn/zip_index.json`)
2. 从 `assets/cdndata/gacha.json` 读取所有引用的 odds ID(~800 个)
3. 计算每个 ID 的 SHA1 hash 定位其在 CDN 归档中的路径
4. 通过 `unzip -p` 从归档中直接提取, 写入 `tmp/gacha_odds/`

### 备份方案

如果 CDN 归档不可用,可保留旧的 `assets/gacha_odds/`(已 gitignore)。
提取工具与旧文件完全兼容 — 对比验证 SHA256 一致。
