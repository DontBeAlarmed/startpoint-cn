# 抽卡动画种子验证

角色抽卡先由 CDN 卡池权重确定角色和稀有度，再选择只负责客户端演出的 seed。seed 不参与中奖概率。C3032 的客户端校验与响应字段见[抽卡动画与 C3032](./gacha-c3032.md)。

## 权威来源

生产环境的只读产物位于 `assets/gacha-seed-catalog/`：

```text
manifest.json
normal.json
normal_guarantee.json
fes.json
fes_guarantee.json
audit.json
```

服务启动只读取 manifest 和四个 movie 池；`audit.json` 是离线审计报告。catalog 由 `tools/gacha-faithful/world.cjs` 离线从连续 seed 范围直接分类。manifest 固定记录客户端/CDN 版本、配置与预测器 SHA256、seed 范围、稀有度数量及每个池的摘要。

服务初始化时读取并校验一次 manifest 和四个池，严格要求 CN 客户端 `1.8.1`、CDN `1.4.54`、四种官方 movie、完整连续范围、稀有度计数和 SHA256 闭包一致；后续抽卡只访问内存缓存。每次角色抽卡请求维护一个 `usedSeeds` 集合，从对应 `movie_id + rarity` 桶中均匀无放回选择。普通物理桶为空、摘要不符或 movie 未知时明确失败，不使用未经验证的占位回退。

`rarity_5_guarantee` 是客户端明确强制五星且跳过物理的特殊分支，不进入四个物理 catalog。

## 离线验证

```bash
npm run gacha:seeds:extract-config -- <decompressed-config.amf3>
npm run gacha:seeds:build
npm run gacha:seeds:verify
npm run gacha:seeds:audit
```

- `build`：默认扫描 2 万个唯一 seed，并在四种 movie 下生成 8 万条分类记录；
- `verify`：使用同一 faithful 预测器重新模拟每条记录，检查范围完整、无重复、稀有度、manifest 与摘要；
- `audit`：汇总播放率、帧数、碰撞数和升星步数；
- `extract-config`：仅用于已经解压的官方 AMF3 配置取证，不参与服务启动。

真实客户端历史语料位于 `tools/gacha-faithful/fixtures/verified_seeds.json`，只用于预测器离线回归，不是生产 seed 池。当前原始记录为 `759/760` 一致，唯一差异是保证动画中结构上不可能出现的三星记录；这项证据不等同于当前 8 万条记录都经过真实客户端逐条执行。

## 最小 Quarantine

运行时只保留一个可选兜底文件：

```text
<DATA_DIR>/state/seeds/quarantine.json
```

服务在内存中短暂关联最近 10 分钟发送的 `movie_id + seed`。`/debug` 或 `/crash` 收到 C3032 时，只有精确匹配且未过期的记录才加入本机 quarantine；任意上报、错 movie、过期和重复上报都不改变状态。

quarantine 的权限只有“从选择中排除”：

- 不能增加 catalog seed；
- 不能改变 seed 稀有度；
- 不能跨 movie 注入；
- 不处理 PLAY 信标；
- 不参与卡池概率。

写入采用临时文件加原子 `rename`。写入失败会同时回滚 quarantine 和最近发送关联。文件损坏时告警并以空 quarantine 启动；该可选兜底状态不会阻止游戏服务。

## 后台边界

`GET /api/seeds/status` 只读返回：

- catalog 客户端/CDN 版本、seed 范围与四种 movie 的稀有度数量；
- 本机 quarantine 全量计数，以及每种 movie 排序后的前 20 个 seed 样本。

后台不再提供模式切换、标签、test seed、人工提升或在线净化接口。`/seeds` 页面只展示上述状态。

## 已删除的旧架构

以下内容不再属于运行时：

- `confirmed/pending/play/verified` 多层池；
- `natural/play/test` 选择模式；
- test seed 与人工标签；
- PLAY 信标学习；
- 每次抽卡重读 JSON；
- 简化版 TypeScript 物理生成器；
- 以客户端反馈净化错误池的 baseline 文件。

离线 faithful 预测器是唯一物理分类实现，quarantine 只作为异常隔离兜底。
