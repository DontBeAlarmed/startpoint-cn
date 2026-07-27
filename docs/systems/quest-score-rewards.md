# 关卡普通与稀有掉落

## 普通掉落

`score_reward` 中 type 0 行的 `field5` 是抽取权重，不是附加数量。服务端按官方顺序执行：

1. 根据关卡结算评级读取 C、B、A、S、SS 对应抽取次数；无评级关卡读取固定次数。
2. 联机模式只对抽取次数应用 `common_reward_multiplier_by_multi_play_mode`，并向上取整。
3. 每次在按权重降序、同权重按 OrderedMap 原始 index 升序的列表中独立抽取，可重复命中同一行。
4. 响应的 `drop_score_reward_ids[].index` 保留原始 OrderedMap index。

20 张关卡表转换器会从官方 CDN 导出 `commonRewardCount` 或五档 `commonRewardCounts`。对应 Quest/Reward 的转换器版本与输出结构版本均已提升，普通 `content:sync` 会在同 CDN 版本下自动重建旧快照及单表对象，不需要手动 `--force`。

## 稀有掉落

稀有掉落分两阶段：

1. `score_reward` type 1 行的 `rarity` 是该稀有组的独立出现概率，使用严格的 `roll < probability`。
2. 出现后，`rare_score_reward` 每行的 `rarity` 是组内条件概率。按概率降序、相同概率按原始 index 升序计算累计概率，再以严格 `<` 选择一项。

组内不是均匀随机。服务端保留 `rare_score_reward` 的原始 index，并将它写入 `drop_rare_reward_ids`；不再把排序后位置误当作协议 index。随机数使用 32 位单位区间，不再把概率压缩为百分之一精度。

Rare 的 ELEMENT/AETHER 行中 `id` 表示素材稀有度，不是背包物品 ID；发奖前会结合关卡属性转换为实际素材 ID，与普通掉落保持一致。

## 仍独立处理的机制

`additional_reward` 不是本模块的抽取概率。固定关卡 Mana、角色战斗 EXP 和 campaign 倍率由 [奖励活动倍率](./reward-campaign.md) 在结算链路处理，不能与 Rare Score Reward 的 `rarity` 混用。
