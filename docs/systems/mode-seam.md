# 玩法模块装载缝

服务端基座不携带任何玩法逻辑。需要服务端配合的玩法（自定义连战、活动规则等）
以**独立模块**形式交付，由运营者显式安装；未安装时所有挂点都是空操作，
行为与不带本机制的基座逐字节一致。

## 三个组成部分

| 部分 | 位置 | 说明 |
|---|---|---|
| 注册表 | `src/modes/registry.ts` | 模块注册 + 三个 dispatch 函数 + `ModeHost` 契约 |
| 装载器 | `src/modes/loader.ts` | 启动时从 `modes.d/*.mjs` 装载 |
| 挂点 | `cn-server.ts` / `singleBattleQuest.ts` / `lib/rush.ts` | 各一行调用 |

## 装载规则

模块装载是**双重显式**的：文件必须存在于 `modes.d/`，**且**其 sha256 必须登记在
`modes.d/modes-allowlist.json`（形如 `{"rogue.mjs": "<sha256>"}`）。二者缺一或
哈希不符都会跳过并打日志，不会静默加载。

安装模块等同于以服务器权限运行第三方代码，与安装服务端本身是同级别的信任决定，
因此不提供任何自动发现或热加载：装卸模块都要重启。这与内容快照在进程内冻结的
模型一致。

环境变量：

- `MODES_ENABLED=0` —— 整体关闭装载缝
- `MODES_DIR` —— 覆盖模块目录（默认 `<projectRoot>/modes.d`）

## 契约版本

`MODE_API_VERSION`(当前 `1`)。模块必须**静态导出** `modeManifest`,装载器在
**把 host 交给模块之前**就读它校验版本——不兼容的模块因此永远没有机会调用 host。
`host.apiVersion` 让模块自己也能分支。

## 模块契约

模块是一个 ESM 文件，导出 `register(host)`，返回模块定义：

```js
// 静态导出:装载器先读它做版本门禁,再决定是否执行 register
export const modeManifest = {
    apiVersion: 1,
    name: "example",
    capability: "example-settlement@1",
}

export function register(host) {
    return {
        onRushFinish(params, host) { /* 可选 */ },
        onQuestStart(context, host) { /* 可选,抛错即拒绝进本 */ },
        onRushPartiesSerialized(context, host) { /* 可选,可原地改写 */ },
    }
}
```

`host` 分两种,**按事务上下文授予能力**:

| host | 交给谁 | 内容 |
|---|---|---|
| `ModeHost`(只读) | 不在事务里的挂点 | `apiVersion` / `table` / `log` |
| `ModeTransactionHost` | 在显式事务里的挂点 | 以上 + `server` 写入原语 |

不在事务里的挂点**拿不到任何写入原语**,因此无法修改玩家存档——这是类型层面的
保证,不是约定。

- `host.table(name)` —— 只读**基座已注册**的运行表;其他名字一律抛错。
  **模块私有的配置/开关不放在这里**,见下节;
- `host.log(message)`、`host.apiVersion`;
- `host.server`(仅事务 host)—— 精选的服务端原语（角色元素查询、装备写入、
  角色经验授予）,模块不直接 import 服务端内部实现。写入经由它发出,
  自动参与调用方的事务,因而随之回滚。

## 模块自己的配置放哪

**不放在内容注册表里。** 基座的 Content Registry 是基座的,装载缝不会为某个具体
Mod 扩展它,`host.table` 也读不到未注册的表。模块的开关与配置有两个去处:

1. 写进 `modeManifest`(简单开关、版本、能力声明);
2. 放在模块自带的文件里,由模块自己经 `import.meta.url` 定位读取。

## 多模块:顺序与冲突

- **顺序确定**:装载器按文件名的**码点序**排序,注册顺序即分派顺序,同一份
  `modes.d/` 在任何机器上产生相同序列;
- **重名拒绝**:`name` 与已注册模块相同的后来者被拒,先注册者不受影响;
- **capability 不互斥**:多个模块可声明各自的 capability,只用于握手与日志;
- **单模块失败隔离**:被授权的模块若导入/注册失败,只记日志并跳过,启动继续——
  一个坏模块不能让整台服务器拒绝服务。

## 失败模型与事务边界

| 挂点 | 事务上下文 | host | 抛错后果 |
|---|---|---|---|
| `onQuestStart` | 无(进本之前) | 只读 | **有意否决**:传播,首个抛错者拒绝进本,后续模块不执行,错误信息回传客户端 |
| `onRushFinish` | **在结算事务内** | 可写 | **整次结算回滚**:异常向上传播 |
| `onRushPartiesSerialized` | 无(读路径) | 只读 | 记日志跳过该模块,已完成的改写保留 |

`onRushFinish` 之所以传播而不是 fail-soft:它跑在 finish 事务**内部**
(`executeFinishWrites` 体内),吞掉异常会让模块写了一半的数据随事务一起提交。
回滚整次结算是唯一不会留下撕裂存档的选择。

不在事务里的两个挂点拿的是只读 host,**根本不具备写入能力**,所以跳过它们不会
留下部分状态。

## 三个挂点

| 挂点 | 时机 | 能力 |
|---|---|---|
| `dispatchModeQuestStart` | `/single_battle_quest/start` 校验完关卡存在性后 | 抛错可拒绝进本，错误信息回传客户端 |
| `dispatchModeRushFinish` | `handleRushEventFinish` 之后 | 收到与基座同一份依赖注入参数对象，因此复用同一批领域原语；返回的奖励条目追加进 `rush_battle_reward_list` |
| `dispatchModeRushParties` | 已用队伍序列化返回前 | 可原地改写记录。客户端的角色锁完全由这些列表推导，模块可据此释放锁而保持条目数（客户端 `getRushBattleRound()` = 列表长度 + 1） |

## 激活语义（建议）

模块自身应当由**内容**键控：处理器第一步读取自己的激活表，表缺失或未启用时
直接返回。这样"安装了模块但没有对应内容"与"完全没装模块"表现一致，
运营者可以先装模块再按需下发内容。

## 测试

- `tools/modes_loader.test.cjs` —— allowlist 命中装载、未登记跳过、哈希不符跳过、
  `MODES_ENABLED=0`、目录缺失静默无操作、重复/非法注册被拒;
- `tools/modes_contract.test.cjs` —— 版本不符在 `register()` 执行前即拒装、缺 manifest
  拒装、被授权模块加载失败不影响其他模块、码点序分派、重名拒绝、
  `table` 只服务基座已注册表、进本否决链短路、结算传播、队伍改写 fail-soft、
  无模块时全部 no-op;
- `tools/modes_lifecycle.test.cjs` —— **生产启动顺序**:经
  `createContentLifecycleDependencies()`(cn-server 展开进协调器依赖的同一个组合)
  驱动真实 coordinator,snapshot/HTTP listen/TCP start 用 spy 不占端口,断言顺序为
  **内容快照 → 模块注册完成 → HTTP listen → TCP start**,空目录同序且零注册;
- `tools/modes_wiring.test.cjs` —— **接线契约**:cn-server 导入即自动 `start()`,测试
  无法安全导入它,因此改为对其**真实 AST** 断言:必须 import 该工厂、必须把工厂调用
  **展开进** `createRuntimeCoordinator({...})` 依赖、且展开之后不得再出现会覆盖它的
  `initializeContent` 键;并自带一项"守卫的守卫"——按 AST 区间删掉该展开后,前述断言
  必须失败。已用真实变异验证:移除生产接线后本套件转红,而仅有顺序断言的
  lifecycle 套件仍全绿,正是这条契约要堵的盲区;
- `tools/modes_routes.test.cjs` —— **路由级**:真实 fastify handler 上,模块否决
  `/start` 返回 400 且消息即模块所抛;**无模块时 `/start` 精确断言 200 + 解码响应
  结构 + active quest 已创建**;`/finish` 结算故障时响应可追溯到 fixture 的唯一错误
  (证明确实执行到挂点)、**正常结算必改的持久状态(total_mana_obtained/free_mana/
  关卡进度行数)保持原值**、active quest 未被误删;并有**对照组**证明同一结算在无
  模块时确实会改动这些状态(断言非空洞);
- `tools/modes_integration.test.cjs` —— **真实接线**:全部经 `initializeContentAndModes()`
  (cn-server 交给运行时协调器的同一个组合函数,不是测试自己拼的顺序)驱动:
  快照先于模块注册、空目录干净启动且响应不被改动、装入模块后生产读路径
  `getSerializedPlayerRushEventPlayedPartiesSync` 的返回确实被改写(条目数不变)、
  以及**结算模块抛错时同一事务内的基座写入一并回滚**。

三个测试的 fixture 模块都写在临时目录,发行目录 `modes.d/` 始终为空。
CI(`.github/workflows/modes.yml`)跑 typecheck + 三个套件,并硬性断言
`modes.d/` 不含任何文件;`quick:modes` 分组让它们同时进入 `npm run test:quick`。
