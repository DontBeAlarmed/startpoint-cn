# 联机 NPC 贡献者昵称池设计

> 状态：已实现，待客户端验收
> 范围：单人房主招募 NPC 时的显示昵称、房间内昵称稳定性、公开 PR 校验
> 不包含：真实玩家身份导入、玩家存档绑定、服务重启后的房间恢复、自动合并公开 PR

## 目标

允许贡献者通过简单 PR 向服务端提交一个游戏昵称。服务端在创建 NPC 联机队友时从名单中随机选择昵称，同时继续使用服务端保留的虚拟 `viewer_id` 和 `com_id` 作为协议身份。

贡献数据不包含玩家 ID、账号信息或其他归属字段。贡献记录由 Git 提交和 PR 历史追溯，不进入运行时数据。

## 客户端依据

国服 1.8.1 客户端的普通玩家昵称上限来自主数据 `max_player_name_length`，当前 1.4.54 运行表 `assets/config.json` 中的值为 `12`。客户端使用 AS3 `String.length` 判断，因此长度单位是 UTF-16 code unit；JavaScript 的 `String.length` 与之相同。

联机 `Mate.name` 只是 TypePacker 字符串字段。客户端收到后直接用于房间和战斗显示，不把昵称作为玩家身份，也没有额外的联机昵称长度限制。国服客户端会在显示时调用雷霆 SDK 的敏感词过滤；服务端仓库没有对应词库，不推测或复制一套不准确的敏感词规则。

当前客户端会在招募时生成两个默认名称并通过 `EnterComs` 上送。服务端为了提供贡献者昵称池，将忽略这些临时名称，使用房间已经确定的 NPC 名册。

## 数据契约

服务端自有资产位于：

```text
assets/server/npc_contributor_names.json
```

格式保持最小化：

```json
{
  "schemaVersion": 1,
  "names": [
    "开心超人",
    "名字真难取"
  ]
}
```

每个贡献 PR 只需要向 `names` 增加一个字符串。文件不接受 `playerId`、邮箱、社交账号、备注或贡献者对象。

### 校验规则

自动检查执行以下规则：

1. 根对象只包含 `schemaVersion` 和 `names`，版本必须为 `1`。
2. `names` 必须是非空字符串数组。
3. 昵称长度不得超过当前 `assets/config.json` 的 `max_player_name_length`，按 JavaScript `String.length` 计算。
4. 昵称不得为空、纯空白、带首尾空白，且不得包含 C0 控制字符或 DEL。
5. 完全相同的字符串不得重复；不做 Unicode 归一化或大小写转换。

第 4 条是公开仓库的数据质量规则，不是对客户端能力的推测。中文、拉丁字母、日文、韩文、Emoji 和常用标点不设置字符白名单。敏感内容继续由维护者审查和客户端现有显示过滤处理。

## 房间状态

NPC 协议身份与昵称分离：

```ts
interface RoomNpcAssignment {
    com_id: 1 | 2
    name: string
}

interface MultiRoom {
    npc_count: number
    npc_roster: RoomNpcAssignment[]
}
```

`viewer_id` 不写入贡献文件或房间名册。运行时继续按 `com_id` 派生保留 ID：`com_id=1` 对应 `900000001`，`com_id=2` 对应 `900000002`。

`npc_roster` 属于内存房间状态：

- 首次招募时一次性无放回抽取所需昵称，并绑定到稳定的 `com_id`。
- 重复 `EnterComs`、同一房间重赛和房间仍存活时的恢复都复用原绑定。
- 真人加入并替换一个 NPC 时，剩余 NPC 按 `com_id` 取回原昵称，不按数组下标重新命名。
- 房间解散或过期时，名册随房间一起删除；新房间重新抽样。
- 服务进程重启后现有内存房间本来就不会恢复，因此本功能不新增数据库持久化。

## 抽样和回退

昵称池提供一个无副作用的无放回抽样函数。默认随机源使用 `crypto.randomInt`，测试可注入 `(upperExclusive) => index`，不替换全局 `Math.random`。

首次分配通过同步且幂等的 `ensureNpcRoster` 完成，再进入现有异步招募流程，避免并发 `EnterComs` 为同一房间生成两套昵称。

活跃 NPC 数量按以下规则计算：

```text
min(room.npc_count, 3 - 当前真实玩家数)
```

这样真人已连接而延迟招募回调随后触发时，房间仍最多三人。名单数量不足属于异常部署状态，服务端使用现有内置默认名称补齐，不因昵称配置阻断联机。

## 模块边界

建议拆为三个职责：

| 模块 | 职责 |
|---|---|
| `assets/server/npc_contributor_names.json` | 公开贡献数据，只保存昵称 |
| `src/multi/npc/nickname-pool.ts` | 读取候选池、无放回抽样、幂等生成房间名册 |
| `src/multi/tcp/lobby.ts` | 按 `com_id` 组装 NPC mate，不再硬编码或信任客户端临时名称 |

`NpcMateProvider` 继续负责虚拟队友身份和队伍提供，不承担贡献者身份映射。昵称池不进入 CDN 内容同步，也不与玩家数据库耦合。

## 贡献步骤

1. 只编辑 `assets/server/npc_contributor_names.json` 的 `names` 数组，增加一个昵称字符串。
2. 运行 `node tools/npc_contributor_names.cjs`。
3. 运行 `node --test tools/npc_contributor_names.test.cjs`。
4. 提交 PR，等待 CI 全部通过和维护者人工审查。

贡献文件不得提交 `playerId` 或其他身份信息。CI 通过只表示数据结构和基础质量符合规则，昵称内容仍需人工审查后才能合并。

## PR 校验与合并

新增无第三方依赖的 Node 校验脚本，并把它加入现有 GitHub Actions。公开 PR 会自动检查 JSON 结构、UTF-16 长度、空白和重复项。

初期只自动校验，不自动合并。原因是昵称内容仍需要人工判断是否冒充他人、包含攻击性内容或使用视觉混淆字符。校验通过后由维护者合并；若未来贡献量明显增加，再单独设计受保护分支下的自动合并规则。

## 自动与构建验证

自动测试覆盖：

1. 合法文件通过，错误 schema、超长、空白、控制字符和重复昵称被拒绝。
2. 固定随机序列下无放回抽取，且不修改原数组。
3. 首次招募后 `com_id → name` 固定，重复招募和重赛不改变。
4. 真人替换一个 NPC 后，剩余 NPC 的昵称不改变。
5. 延迟招募与真人进入交错时，房间不会超过三人。
6. 房间解散后，新房间不会继承旧名册。

构建验证运行 `npm run build:server`、`npm run build:bundle` 和 `npm run verify:bundle -- --data-schema 10`，确认服务端产物包含昵称池实现，且 Server Bundle manifest 包含昵称资产。

## 客户端验收步骤

1. 首次招募 NPC，确认房间和战斗显示贡献者名单中的昵称。
2. 在同一房间发起重赛，确认每个 `com_id` 仍绑定原昵称。
3. 解散房间并重新创建，确认新房间能重新抽样且联机流程正常。
