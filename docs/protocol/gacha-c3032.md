# 抽卡动画与 C3032

C3032 表示客户端根据 `movie_id` 和 `seed` 计算出的球稀有度，与服务端下发角色的真实稀有度不一致。本文只描述当前服务端的动画选择、种子选择和已知边界；种子状态机与持久化契约见[种子验证](./seed-verification.md)。

## 客户端校验

角色抽卡结果包含：

```text
character_id
movie_id
seed
entry_count
```

客户端用 `movie_id` 选择对应物理配置，以 `seed` 初始化随机数与落球过程，最后校验物理结果的稀有度是否等于角色主数据中的稀有度。不匹配时抛出 C3032。

因此，角色 ID 正确并不代表动画结果一定合法；`movie_id`、种子池分类和角色稀有度必须保持一致。

## 当前服务端流程

`src/lib/gacha.ts` 在模块初始化时加载并校验一次 `assets/gacha-seed-catalog/`，后续抽取只访问内存缓存。每次角色抽取执行：

1. 从当前角色内容仓库读取真实稀有度；
2. ★3 只选择普通动画类型；★4、★5 按当前 `rankMovieRates` 在普通与保证动画间选择；
3. 从卡池的 `movieName` 或 `guaranteeMovieName` 得到 `movie_id`，缺失时回退到 `normal`；
4. 在门票、活动次数和角色存档写入前，为整批结果完成动画规划；
5. 从 faithful catalog 的 `movie_id + rarity` 桶中均匀选择 seed；
6. 使用本次请求内的 `usedSeeds` 集合避免十连重复 seed；
7. 在进程内登记最近发送的 `movie_id + seed`，再把结果发送给客户端。

`rarity_5_guarantee` 的配置包含 `isRarity5`，客户端会直接强制 ★5 并跳过普通物理校验。该路径以 `characterId * 1000` 为占位 seed 起点；同一请求重复角色时顺延到下一个未使用值，只适用于这一明确分支。

普通物理分支找不到对应 seed 时会明确失败，不再回退到未经验证的 `characterId * 1000`。该占位值只允许用于 `rarity_5_guarantee` 的客户端强制五星分支。

## 本机 Quarantine

运行时不再学习或重分类 seed。`src/lib/gacha-seed-quarantine.ts` 只维护：

- 进程内最近 10 分钟发送记录；
- `<DATA_DIR>/state/seeds/quarantine.json` 中的本机禁用集合。

C3032 上报必须同时匹配最近发送的 `movie_id + seed` 才能进入 quarantine。任意上报、过期上报、错 movie 上报和重复上报都不会改变状态。quarantine 只能从 catalog 选择中排除 seed，不能增加、提升、重分类或跨 movie 注入 seed。

quarantine 属于本机 Runtime Data，不应提交到 Git。完整状态与恢复边界见[种子验证](./seed-verification.md)。
该可选文件损坏时服务端会告警并以空 quarantine 启动，不让兜底状态阻断游戏服务；收到新的可信 C3032 后才会发布新快照。

## 信标与错误反馈

服务端的 `/debug` 与 `/crash` 兼容端点可以解析客户端补丁上报的 C3032：

- 匹配最近发送记录：加入本机 quarantine，并从后续 catalog 选择中排除；
- 不匹配最近发送记录：忽略；
- PLAY 信标：不再处理。

官方客户端不发送项目自定义信标，但仍直接使用离线完整验证过的 catalog。quarantine 只是异常兜底，不是 seed 正确性的来源。

## 排查顺序

出现 C3032 时按以下顺序核对：

1. 记录角色 ID、真实稀有度、`movie_id` 和 `seed`；
2. 确认角色稀有度来自当前 Content snapshot，而不是由 ID 位数推测；
3. 确认卡池的普通/保证动画名与客户端实际配置一致；
4. 检查 `assets/gacha-seed-catalog/manifest.json` 的版本和摘要；
5. 运行 `npm run gacha:seeds:verify` 全量复算对应 catalog；
6. 确认对应 `movie_id + rarity` 桶非空；
7. 有信标时核对发送记录与 C3032 反馈是否属于同一次抽取。

不要通过把全部 `movie_id` 固定为 `normal` 来掩盖错误，也不要把固定角色种子当作普通动画的永久方案。

## 自动测试

主要回归入口：

| 测试 | 覆盖 |
|---|---|
| `tools/gacha_draw_weights.test.cjs` | 角色/装备权重与十连保证位 |
| `tools/gacha_rules.test.cjs` | 抽卡规则和结果构造 |
| `tools/gacha_seed_catalog_runtime.test.cjs` | catalog 启动缓存、摘要、选择与空桶失败 |
| `tools/gacha_seed_catalog_builder.test.cjs` | 离线范围完整性与 manifest |
| `tools/seed_state.test.cjs` | seed 状态存储与数据契约 |
| `tools/seed_api.test.cjs` | 管理 API 与模式切换 |

模块提交前仍运行 `npm run verify:full`。自动测试无法替代客户端物理动画的人工验收。
