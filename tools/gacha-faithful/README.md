# Faithful 抽卡动画种子目录

本目录负责离线生成与校验角色抽卡动画 seed。它不决定抽中角色、稀有度或概率；角色结果仍由 CDN 卡池权重先行确定，seed 只需让客户端演出的最终稀有度与该结果一致。

## 问题来源

客户端会用响应中的 `movie_id` 和 `seed` 重放落球物理。物理结果与角色稀有度不一致时会抛出 C3032。

旧实现先用简化模拟器生成池，再依靠客户端信标逐步净化。这个流程存在两个结构性问题：

1. 简化模拟器会把合法 seed 放错桶；后续过滤只能删除错误项，不能把它移回正确桶。
2. 官方客户端不发送项目自定义的 PLAY 信标，在线学习不是受支持客户端的可靠数据源。

`world.cjs` 是当前唯一权威预测器。它按国服客户端物理实现重放 MT19937、碰撞求解和稀有度变化；历史真实客户端语料为 759/760，唯一不一致项是保证动画中机械上不可能出现的三星历史记录。所有实际播放物理的 552 条语料均一致。

## 目录产物

默认扫描 `10,000,000..10,099,999` 共 10 万个唯一 seed，并分别在以下四种 movie 配置下分类：

```text
normal
normal_guarantee
fes
fes_guarantee
```

因此 manifest 中是 40 万条分类记录，不是 40 万个不同 seed。默认产物约 3.4 MB，最小五星桶仍有 5,000 个候选，足以支持请求内去重和动画多样性。扩大范围不会提高物理正确性；确需扩大时显式传入 `--seed-end`。

产物位于 `assets/gacha-seed-catalog/`：

```text
manifest.json
normal.json
normal_guarantee.json
fes.json
fes_guarantee.json
audit.json
```

manifest 记录客户端/CDN 版本、配置摘要、预测器摘要、seed 范围、各桶数量和文件摘要。相同输入必须生成相同 catalog；文件不记录生成时间。

## 离线命令

```bash
npm run gacha:seeds:build
npm run gacha:seeds:verify
npm run gacha:seeds:audit
```

- `build`：从指定范围直接按 faithful 最终稀有度落桶，不读取旧 seed 池，也不执行“错误即删除”。默认最多使用 4 个 worker。
- `verify`：重新模拟 catalog 中的每个 seed，同时检查范围完整、无重复、桶分类与 SHA256 摘要。
- `audit`：输出播放比例、初始/最终稀有度、帧数、Pin/Amulet 接触数和升星步数分布。

小范围复现示例：

```bash
node tools/gacha-faithful/build_catalog.cjs \
  --output /tmp/gacha-seeds \
  --seed-start 10000000 \
  --seed-end 10000999 \
  --workers 2
node tools/gacha-faithful/verify_catalog.cjs --catalog /tmp/gacha-seeds
node tools/gacha-faithful/audit_catalog.cjs --catalog /tmp/gacha-seeds
```

## 配置来源

物理参数来自官方 CN 1.8.1 客户端使用的 1.4.54 CDN gacha AMF3 配置。`world.cjs` 暴露确定性配置快照，builder 将其 SHA256 写入 manifest；预测器源码摘要同时覆盖 `world.cjs` 和 `native_hotpath.cjs`。

`amf3_decode.cjs` 只用于对已经解压的 AMF3 文件进行离线取证，不参与服务启动，也不从非官方 CDN 自动修复配置。配置或预测器发生变化时必须重新 build、verify 和 audit。
