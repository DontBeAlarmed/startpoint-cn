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

## 客户端可达性与测试深度

协议和游戏功能测试在设计时必须先标注场景如何到达服务端，测试深度由真实可达性与风险决定：

| 分类 | 含义 | 默认验证方式 |
|---|---|---|
| `CN-reachable` | 官方 CN 1.8.1 客户端正常流程会发送 | 真实协议、路由、数据库、响应和必要的 `/load` 端到端 |
| `transport-replay` | UI 不主动产生，但响应丢失、超时或重试可能重复发送 | 真实路由、事务、幂等与重复写入检查 |
| `server-boundary` | 只能绕过官方客户端直接构造 | 纯 validator/command 完整边界，加少量代表 HTTP 映射 |
| `save-integrity` | 存档导入、管理操作或数据库损坏可达 | 输入边界、事务回滚和有限错误，不模拟客户端流程 |
| `client-characterization` | 用反编译证据锁定客户端解析或合并语义 | 最小行为表征，不复制整套客户端实现 |

官方客户端不可能产生的状态仍需在服务端 fail closed，但不得伪装成客户端功能场景，也不得默认与每个 endpoint、每个非法值组成完整集成测试笛卡尔积。纯逻辑已经穷举同一不变量时，HTTP 层只保留能证明 adapter 未绕过校验的代表用例。自动边界测试通过不等于官方客户端路径可达或已完成实机验收。

设计测试前先查 CN 1.8.1 反编译请求条件、按钮/场景门控、请求字段和响应合并语义；无法由客户端证据证明可达时，必须标为 `server-boundary` 或待抓包，而不是扩写假想功能流程。

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

## 多人 Hub 专项

修改 `src/multi/runtime/`、Hub 管理、active quest 来源或远程结算时，至少运行：

```bash
node tools/test-workflow/run.cjs --files \
  tools/multi_client_fallback.test.cjs \
  tools/multi_coordinator_router.test.cjs \
  tools/multi_load_recovery.test.cjs \
  tools/multi_remote_settlement.test.cjs \
  tools/multi_runtime_config.test.cjs

node --test \
  tests/multi-hub-process-harness.test.js \
  tests/multi-hub-process.test.js
```

专项回归必须证明：Host 本地玩家不经过自己的 Hub；Client 只为后续新房间自动降级或升级；已有 active quest 固定原协调来源；网络不可用不等同于房间不存在；远程写响应不确定时不在本地重放；本地 fallback 使用当前 Client 自己的 TCP 绑定和公开地址。专项通过后仍需执行模块提交前总门禁。
