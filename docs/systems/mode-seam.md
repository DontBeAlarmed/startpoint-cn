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

## 模块契约

模块是一个 ESM 文件，导出 `register(host)`，返回模块定义：

```js
export function register(host) {
    return {
        name: "example",
        capability: "example-settlement@1",
        onRushFinish(params, host) { /* 可选 */ },
        onQuestStart(context, host) { /* 可选,抛错即拒绝进本 */ },
        onRushPartiesSerialized(context, host) { /* 可选,可原地改写 */ },
    }
}
```

`host` 提供：

- `host.table(name)` —— 读取进程内容快照的运行表
- `host.log(message)`
- `host.server` —— 精选的服务端原语（角色元素查询、装备写入、角色经验授予），
  模块不直接 import 服务端内部实现

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

`tools/modes_loader.test.cjs` 覆盖：allowlist 命中装载、未登记跳过、哈希不符跳过、
`MODES_ENABLED=0`、目录缺失静默无操作、重复/非法注册被拒。
