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

`MODE_API_VERSION`(当前 `1`)。模块定义必须声明相同的 `apiVersion`,否则装载器
拒绝该模块并打日志——宁可不装,也不让旧模块撞上变过的 host 形状。
`host.apiVersion` 让模块自己也能分支。

## 模块契约

模块是一个 ESM 文件，导出 `register(host)`，返回模块定义：

```js
export function register(host) {
    return {
        apiVersion: 1,
        name: "example",
        capability: "example-settlement@1",
        onRushFinish(params, host) { /* 可选 */ },
        onQuestStart(context, host) { /* 可选,抛错即拒绝进本 */ },
        onRushPartiesSerialized(context, host) { /* 可选,可原地改写 */ },
    }
}
```

`host` 提供：

- `host.table(name)` —— 读取进程内容快照的运行表;**快照没有该表时返回 `null`**,
  所以激活表尚未下发的模块保持惰性而不是抛错
- `host.requireTable(name)` —— 同上但缺表抛错(用于硬依赖)
- `host.log(message)`
- `host.apiVersion`
- `host.server` —— 精选的服务端原语（角色元素查询、装备写入、角色经验授予），
  模块不直接 import 服务端内部实现

## 多模块:顺序与冲突

- **顺序确定**:装载器按文件名的**码点序**排序,注册顺序即分派顺序,同一份
  `modes.d/` 在任何机器上产生相同序列;
- **重名拒绝**:`name` 与已注册模块相同的后来者被拒,先注册者不受影响;
- **capability 不互斥**:多个模块可声明各自的 capability,只用于握手与日志;
- **单模块失败隔离**:被授权的模块若导入/注册失败,只记日志并跳过,启动继续——
  一个坏模块不能让整台服务器拒绝服务。

## 失败模型与事务边界

| 挂点 | 抛错含义 | 处理 |
|---|---|---|
| `onQuestStart` | **有意否决**(进本规则) | 传播:首个抛错者拒绝进本,后续模块不再执行,错误信息回传客户端 |
| `onRushFinish` | 模块缺陷 | **fail-soft**:记日志、跳过该模块,基座流程继续。结算此时已提交基座奖励,中止请求会把它们丢掉 |
| `onRushPartiesSerialized` | 模块缺陷 | 同上,已完成的改写保留 |

模块在结算期间写玩家数据时,**必须走注入 params 上的 `transaction` 原语**;
在它之外发出的写入不会在后续步骤失败时回滚。

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
- `tools/modes_contract.test.cjs` —— apiVersion 不符拒装、被授权模块加载失败不影响
  其他模块、码点序分派、重名拒绝、`table` 缺表返回 null 而 `requireTable` 抛错、
  进本否决链短路、结算与队伍改写 fail-soft、无模块时全部 no-op;
- `tools/modes_integration.test.cjs` —— 真实接线:装入临时 fixture 模块后,
  生产读路径 `getSerializedPlayerRushEventPlayedPartiesSync` 的返回确实被改写
  (条目数保持不变),以及启动编排中模块在 `listenHttp` 之前完成注册。

三个测试的 fixture 模块都写在临时目录,发行目录 `modes.d/` 始终为空。
