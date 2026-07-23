# 卡池内容生成

当前生产卡池由 Content Sync 从 CDN 主表和其引用的 `gacha_odds` 动态生成，写入 Content Release，再由服务启动时选定的 snapshot 提供给抽卡业务。tracked `assets/gacha.json` 只是 bundled fallback，不是存在 current Release 时的运行时权威。

## 生产数据流

```text
.cdn/cn 官方归档
  -> Content Sync OrderedMap reader
  -> master/gacha/gacha.orderedmap
  -> master/gacha_odds/<odds_id>.orderedmap
  -> src/content/converters/gacha.ts
  -> Content Release 对象
  -> ContentRepository snapshot
  -> src/lib/assets.ts
  -> /gacha/*
```

`src/content/sync/table-registry.ts` 为 `gacha.json` 注册主表和动态 odds 来源。转换器还生成：

- `gacha_campaign.json`；
- `cdndata/gacha.json`；
- `cdndata/gacha_feature_content.json`。

`content:sync` 成功并激活 Release 后，角色与抽卡 API 通过同一个 `ContentRepository` snapshot 读取卡池。手工修改 bundled `assets/gacha.json` 不会改变已经选定的 Release。

## CDN 来源

卡池主表决定 banner 元数据和引用的 odds ID：

- `prize_kind` 区分角色池与装备池；
- rarity odds 决定 5/4/3 星权重；
- 角色或装备 odds 决定每个星级池的成员与原始权重；
- 主表还提供 page kind、成本、保证星级、券 ID、动画名、开放期和装备动画概率 ID。

非空 odds 引用对应逻辑路径：

```text
master/gacha_odds/<odds_id>.orderedmap
```

Content Sync 通过 Catalog/对象读取器从 `.cdn/cn` 归档中解析这些路径，不依赖个人客户端缓存目录。引用的 odds 缺失或不可读时转换失败，Release 不会部分发布，受支持启动入口也不会继续启动服务。

## 运行时卡池结构

每个 banner 的 `pool` 沿用当前运行契约：

| key | 星级 |
|---|---:|
| `"1"` | 5 星 |
| `"2"` | 4 星 |
| `"3"` | 3 星 |

条目保留：

- `id`、`rank` 和原始 `odds`；
- `isRateUp`；
- `isLimited`；
- `isExchangeable`；
- 角色池的 `trialReadingForced`；
- 同星级池内归一化展示权重 `rarity`。

实际抽取先使用 `rankRates` 选择星级，再按对应池的原始 `odds` 选择角色或装备。`rarity` 是展示/报告字段，不替代抽取权重。

十连保证位由主表的 `guaranteeRarity` 和 rarity odds 生成：低于保证星级的权重并入保证档，分母保持原始总权重。角色池和装备池都使用 CDN 的 `rankRates`，不按 ID、属性或名称推测成员。

## page kind、券与兑换

转换器保留客户端 page kind、专属单抽/十连券、通用券可用标记和兑换标记。运行规则由以下模块消费：

- `src/lib/gacha-rules.ts`：page kind 与兑换边界；
- `src/lib/gacha-ticket.ts`：专属券和通用券选择；
- `src/lib/gacha-exec-plan.ts`：抽数、货币、券和 campaign 执行计划；
- `src/lib/gacha-draw.ts`：星级与池内权重抽取；
- `src/lib/gacha.ts`：奖励与动画结果；
- `src/lib/gacha-equipment-movie.ts`：装备动画概率。

Star Heroes、福袋、crazy ticket 和付费 UI 等特殊分支仍需单独实现或验收，字段存在不等于完整玩法已对齐。

## bundled fallback

没有可用 Release 时，`ContentRepository` 可以读取 tracked `assets/gacha.json` 与 `assets/gacha_campaign.json` 作为兼容 fallback。它保证旧部署可启动，不是生产 Content 更新流程。

需要从官方 `.cdn/cn` 重新维护 bundled fallback 时，可以使用离线工具：

```bash
node tools/extract_odds_from_cdn.cjs
node tools/rebuild_gacha_from_odds.cjs --store tmp/gacha_odds
```

这会从项目 CDN 归档按需提取 odds，并重建 tracked fallback。执行前应先 dry run 或在独立工作树检查差异；生成结果只有经过审查、测试和提交后才会影响未来没有 Release 的 fallback 环境。

`tools/gacha_odds_export.cjs` 是独立审计工具。使用时必须显式传入 `--store <production/upload>`；不传 `--store` 的自动发现只兼容旧个人目录布局，不属于受支持项目流程，也不应写入操作文档。

离线工具输出、差异报告和临时 odds 目录不得提交到 Git。

## 更新行为

放入新 CDN 后，受支持的 local 启动会先运行 `content:sync`：

1. 读取目标 CDN 版本和输入摘要；
2. 解析主表及所有动态 odds 引用；
3. 生成完整的 gacha Release 对象；
4. 与其他已注册表一起发布候选 Release；
5. 激活成功后启动服务并固定本次 snapshot。

版本未变化时按同步器规则复用已有对象/Release；需要同版本重建时使用 Content Sync 的 force 入口。卡池表是 Release 的完整快照，不在运行时逐 banner 增量修改。

## 已知边界

- Content Sync 只处理官方、可解析且引用完整的 CDN；
- 当前只对已注册表动态生成，不能由卡池转换推断其他业务表；
- bundled fallback 与 current Release 可能不同，诊断时必须先确认 repository source；
- 部分特殊卡池费用、次数和 UI 仍未完整对齐；
- 卡池成员与权重自动测试不能替代 CN 客户端的页面、券和付费流程验收。

## 验证入口

生产转换与运行接线：

- `tools/content_gacha_converter.test.cjs`；
- `tools/content_registry.test.cjs`；
- `tools/gacha_repository.test.cjs`；
- `tools/content_dynamic_catalog_integration.test.cjs`；
- `tools/content_sync_smoke.test.cjs`。

抽取与执行规则：

- `tools/gacha_draw_weights.test.cjs`；
- `tools/gacha_rules.test.cjs`；
- `tools/gacha_exec_plan.test.cjs`；
- `tools/gacha_equipment_movie.test.cjs`。

维护 bundled fallback 时另行运行 `tools/gacha_odds_export.test.cjs` 与 `tools/rebuild_gacha_from_odds.test.cjs`。模块提交前运行 `npm run verify:full`。
