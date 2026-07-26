# 开发验证工作流

本文只记录当前可执行的验证入口、测试分组和提交门禁。单次性能测量、临时报告与历史优化过程不进入 current 文档。

## 日常命令

| 场景 | 命令 | 作用 |
|---|---|---|
| 修改少量源码 | `npm run test:changed` | 按 Git 变更选择相关测试；未知路径自动提升到 `full` |
| 修改纯逻辑或工具 | `npm run test:quick` | 运行可并行、无共享运行时状态的快速测试 |
| 修改数据库、路由、CDN 或运行时 | `npm run test:integration` | 运行需要编译产物、临时数据库或回环端口的集成测试 |
| 发布运行资产 | `npm run content:audit -- --source-root <WF_ASSETS_CN_ROOT>` | 只读检查 Registry 表、任务关键表来源一致性与奖励引用闭包 |
| 修改文档 | `npm run docs:check` | 检查链接、目录入口、current 索引和禁止提交的文档路径 |
| 修改 TypeScript | `npm run typecheck` | 执行严格类型检查，不生成构建产物 |
| 模块提交前 | `npm run verify:full` | 类型、文档、全量测试、卫生检查和 CN build 总门禁 |

需要稳定复测单个测试文件时，使用：

```bash
node tools/test-workflow/run.cjs --files tools/example.test.cjs
```

需要验证某个源码路径会选择哪些测试时，优先查看 `tools/test-workflow/select-tests.cjs` 及其单测，不手工复制一份映射表到文档。

## 测试分组

测试清单定义在 `tools/test-workflow/groups.cjs`：

- `quick:*`：工作流、运行时纯逻辑、seed、抽卡、关卡、联机协议、CDN 与 Content 单元测试；
- `integration:*`：编译路由、运行时生命周期、内容快照、数据库、活动、任务、关卡和 CDN 集成测试；
- `admin`：管理后台源码与接口契约测试；
- `generator:mission-event`：完全使用 tracked 资产、可快速复现的活动任务规则生成器测试，属于普通 `full`；
- `TEST_GROUPS.generator`：依赖仓库外原始数据的旧 external generator 叶组，不进入 `full`；
- `AGGREGATE_GROUPS.generator`：显式运行生成器总组时同时展开旧 external 叶组和 `generator:mission-event`；
- `full`：全部 quick、integration、admin 以及自包含的 `generator:mission-event`，仍不包含旧 external generator。

并行只用于已经确认使用独立进程、内存状态或唯一临时数据库的分组。依赖回环端口、共享生命周期或顺序状态的测试保持串行。测试必须使用临时数据目录，不得修改真实 `.database/`、Content Release、seed 状态或玩家存档。

## 变更选择规则

`npm run test:changed` 读取当前 Git 变更，并通过 `tools/test-workflow/select-tests.cjs` 选择测试组。规则遵循以下边界：

1. 命中明确映射时运行对应 quick 或 integration 组；
2. 一个文件可以选择多个组，例如路由同时覆盖纯逻辑、Fastify 和数据库行为；
3. 测试基础设施或无法识别的文件进入 `full`；
4. 文档门禁自身的改动至少运行 `quick:workflow`；
5. changed 通过不代替模块提交前的 `verify:full`。

## 性能基准

工作流基准入口为：

```bash
npm run benchmark:workflow
```

默认模式会预热后正式运行三次并取中位数，超过代码中定义的阈值时非零退出。只采集数据、不因性能阈值失败时使用：

```bash
node tools/test-workflow/benchmark.cjs \
  --report-only \
  --output /tmp/starpoint-cn-workflow-benchmark.json
```

`--report-only` 只豁免性能阈值；被测命令失败、超时或无法启动仍会失败。阈值和代表样本以 `tools/test-workflow/benchmark.cjs` 为唯一事实来源，避免文档中的历史数字长期失真。

## 提交门禁

提交前执行：

```bash
npm run verify:full
git diff --check
git status --short
```

`verify:full` 当前依次运行：

1. `typecheck`；
2. `docs:check`；
3. `test:full`；
4. `hygiene`；
5. `build:server`。

其中部分测试需要临时监听 `127.0.0.1`。受限沙箱出现 `listen EPERM` 时，应在允许本机回环端口的环境重新运行同一命令，不能把权限失败记作代码通过或跳过测试。

运行时 seed、扫描结果、临时 benchmark JSON、真实数据库、CDN 归档和抓包都不得进入普通提交。计划书与一次性执行步骤保存在仓库外；长期有效的架构、协议和系统边界才进入 tracked 文档。
