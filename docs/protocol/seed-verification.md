# 抽卡种子验证

本文描述 `src/lib/seed-validator.ts` 当前的种子状态、选择模式、持久化和客户端信标反馈。C3032 与抽卡结果构造见[抽卡动画与 C3032](./gacha-c3032.md)。

## 状态分层

每个 `movie_id` 维护独立的种子池：

| 池 | 当前含义 |
|---|---|
| `verifiedPool` | 客户端证据已确认稀有度；同 movie 中优先级最高 |
| `playPool` | 客户端报告 `play=1`，保存稀有度和人工标签 |
| `confirmPool` | 客户端报告 `play=0` 或其他路径确认稀有度 |
| `pendingPool` | 已发送但缺少完整反馈，等待后续重测 |
| `sentSeeds` | 本进程刚发送、尚未结算反馈的临时关联 |

持久池在同一个 movie 内按 `verified > play > confirmed > pending` 去重；不同 movie 可以保存相同数字 seed，因为客户端物理配置不同。

允许的 movie ID 固定为：

```text
normal
normal_guarantee
fes
fes_guarantee
rarity_5_guarantee
```

运行时 seed 必须是 `0..2147483647` 的安全整数。后台 test seed 进一步限制在当前 CN 动画语料范围 `10000000..10399999`。

## 选择模式

| 模式 | 当前选择行为 |
|---|---|
| `natural` | 第一抽优先匹配稀有度的 verified seed；后续按当前概率使用 verified，再依次尝试 confirmed、pending、unknown |
| `play` | 优先匹配 `playPool` 中对应稀有度的种子，再走通用回退链 |
| `test` | 优先测试 seed，其次未 verified 的 play、pending、unknown |

三种模式都优先使用为目标稀有度设置的 test seed。运行模式本身重启后回到 `natural`；selected movie、test seed 和各持久池由运行时快照保存。

所有候选都不可用时，`getSeed()` 返回 `characterId * 1000`。该值只是最后回退，不代表通过物理验证。

## 反馈流程

`gacha.ts` 发送结果前调用 `markSent(movieId, seed, rarity)`。带信标的客户端补丁可以向 `/debug` 上报：

```text
PLAY|play=0|seed=...|movie_id=...
PLAY|play=1|seed=...|movie_id=...
C3032 ... seed=... movie_id=... play=...
```

服务端当前处理：

- `play=0`：把发送时记录的稀有度写入 `confirmPool`；
- `play=1`：有发送稀有度时进入 verified；只有播放信息时保留相应 play 证据；
- C3032：客户端报告的球稀有度写入 `verifiedPool`，并清理同 movie 的低优先级状态；
- 下一次角色抽取开始时，`flushAll()` 将仍未收敛的发送记录按已有 `play` 标志归类，无反馈的进入 pending。

信标关联依赖同一进程中的 `sentSeeds`。服务重启、反馈丢失或客户端不带补丁时，不会凭空推断本次动画结果。

## 基线与运行时快照

以下 tracked JSON 只作为首次部署 baseline：

- `assets/confirmed_seeds.json`；
- `assets/purified_seeds.json`；
- `assets/verified_seeds.json`；
- `assets/pool_config.json`；
- `assets/test_seeds.json`。

当 `<DATA_DIR>/state/seeds/seed-state.json` 已存在时，运行时只从该快照加载持久状态，不再把已删除的 baseline seed 合并回来。

状态保存使用同目录临时文件、文件 `fsync` 和原子 `rename` 发布。保存失败时回滚本次内存修改；损坏或结构不合法的权威快照会阻止启动，不会自动覆盖。目录 `fsync` 当前未实现，因此不承诺存储设备突然掉电后的绝对持久性。

运行时状态不得提交到 Git。管理后台修改模式、标签或 test seed 时操作的是 Runtime Data，不回写 `assets/` baseline。

## 输入边界

- movie ID、seed、rarity、标签和 test seed 都在 schema/store 边界校验；
- 未知 movie 的只读查询返回空结果，不创建新池；
- 状态文件、临时文件和目录为符号链接或错误文件类型时保存失败；
- 基线任一文件损坏时记录告警，并禁止发布由不完整基线生成的快照；
- `gacha_movie_seeds*.json` 是只读动画语料，不迁移到运行时状态。

## 验证入口

主要自动测试：

- `tools/seed_state.test.cjs`；
- `tools/seed_api.test.cjs`；
- `tools/gacha_rules.test.cjs`。

自动测试验证选择和持久化契约，但不能证明每个 seed 在真实客户端物理中的动画结果。涉及种子语料或信标解析的修改仍需客户端抽卡回归。
