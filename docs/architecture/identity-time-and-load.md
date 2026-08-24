# 身份、时间与存档当前架构

本文描述设备注册、账号与 session、双时钟、CN `/load` 和 V2 存档恢复的当前边界。账号管理规则见[账号管理与继承](../systems/account-management-and-takeover.md)，存档格式和校验规则见[存档与输入校验](../systems/save-validation.md)。

## D6 当前账号、设备绑定与 session

```mermaid
sequenceDiagram
    participant C as CN 客户端
    participant S as /tool/signup
    participant I as AccountIdentityProvider
    participant D as device_bindings
    participant A as accounts
    participant P as players / 默认 player
    participant V as sessions
    participant L as 后续 /load

    C->>S: device_id
    S->>D: 查询设备绑定
    alt 已绑定且账号存在
        D-->>S: account_id
        S->>A: 刷新 last_login_time
        S->>V: 清理旧 VIEWER session
    else 新设备或陈旧绑定
        S->>I: 解析外部身份
        I-->>S: AccountIdentity
        S->>A: 创建账号
        S->>P: 创建默认存档并关联账号
        S->>D: 写入设备绑定
    end
    S->>V: 建立 VIEWER session
    S-->>C: viewer_id + login_token
    C->>L: viewer_id
    L->>V: 优先查询 session
    alt session 存在
        V-->>L: account_id
    else session 缺失（当前兼容回退）
        L->>L: viewer_id / keychain 作为 account_id
    end
    L->>P: 解析账号级默认 player
    P-->>L: player_id
    Note over S,L: 游戏身份不依赖全局 active player
    Note over C,A: 继承码迁移是独立事务：验证目标后重绑设备与 session，并记录审计
```

设备注册的身份提供者只负责解析外部身份；账号、默认 player、设备绑定和 VIEWER session 仍由路由与领域层持有。当前 `/load` 保留 session 缺失时的兼容回退，这属于现状而不是推荐给新身份提供者的主路径。

| 事实 | 证据 |
|---|---|
| 已知设备复用账号，新设备创建账号和默认 player | `src/routes/cn/tool.ts` |
| 身份提供者与账号/session/player 存储解耦 | `src/lib/account-identity-provider.ts` |
| `/load` 使用 session 优先和 viewer/keychain 兼容回退 | `src/routes/cn/load.ts` |
| account 再解析账号级默认 player | `src/data/activeAccount.ts` |
| 继承事务重绑设备与 session 并记录审计 | `src/routes/cn/takeOver.ts` |

本图不把只写不读的 `viewerIdToAccountId` Map 表达为身份权威，也不展开继承密码、账号清理和后台管理界面。

## D7 当前全局服务器时间与双时钟

```mermaid
flowchart LR
    FILE[("Data Volume<br/>server-time.json")]
    CLOCK["真实系统时钟"]
    STORE["ServerTimeStore"]
    SERVICE["ServerTimeService<br/>全局 offset"]
    CONTEXT["请求级 GameTimeContext<br/>一次捕获 realNow / virtualNow"]
    VIRTUAL["虚拟业务时间<br/>卡池 / 活动 / 商店 / 客户端 servertime"]
    REAL["真实经过时间资源<br/>体力 / 经验池"]
    CONVERT["客户端时间转换<br/>真实 DB 时间 ↔ 虚拟时间戳"]
    INFRA["基础设施运行时计时<br/>TCP 心跳 / 租约 / 超时"]

    FILE -->|"启动恢复 / 管理修改"| STORE
    STORE --> SERVICE
    SERVICE -->|"默认基准或已保存 offset"| CONTEXT
    CLOCK -->|"捕获真实当前时间"| CONTEXT
    CONTEXT -->|"virtualNow"| VIRTUAL
    CONTEXT -->|"realNow"| REAL
    CONTEXT --> CONVERT
    REAL --> CONVERT
    CLOCK -->|"不经过游戏时间偏移"| INFRA
```

同一个业务操作应捕获一次 `GameTimeContext`，再按业务语义选择虚拟时间或真实经过时间。TCP 心跳、租约和超时属于基础设施计时，不受游戏时间偏移影响。

| 事实 | 证据 |
|---|---|
| `server-time.json` 保存全局 offset | `src/runtime/server-time/store.ts` |
| 默认服务器时间基准为 `2024-08-14T12:00:00Z` | `src/runtime/server-time/service.ts` |
| `GameTimeContext` 同时捕获真实与虚拟时间 | `src/runtime/time/game-time.ts` |
| 客户端时间转换使用同一个全局 offset | `src/utils.ts` |

本图不把 `players.time_offset` 连入运行时，也不把所有 `Date.now()` 自动解释为虚拟业务时间。

## D8 当前 CN `/load`

```mermaid
sequenceDiagram
    participant C as CN 客户端
    participant L as CN /load
    participant ID as session / account / player
    participant PRE as 日切、经验池、永久校验
    participant AQ as active quest 恢复或中止
    participant AM as Active Mission reconcile
    participant DB as SQLite 领域读取
    participant SER as Player serializer
    participant R as MsgPack 响应

    C->>L: viewer_id + load 请求
    L->>ID: session 优先；缺失时 viewer_id / keychain 兼容回退
    ID-->>L: player_id
    L->>PRE: 日切、真实经过时间资源结算、永久修复
    L->>AQ: 检查数据库 active quest
    alt 可恢复记录
        AQ-->>L: 重建本次 unfinished quest 投影
    else 不可恢复多人记录
        AQ->>DB: 中止并退款预扣资源
        AQ-->>L: 清除 unfinished 状态
    end
    L->>AM: 对账 Active Mission 事实
    L->>DB: 批量读取玩家领域
    DB-->>SER: 角色、装备、库存、任务、队伍、活动等
    SER-->>L: 完整客户端存档
    L->>R: 追加资源版本、邮件计数和 unfinished 列表
    R->>R: 响应成功编码
    R->>AM: 记录本次登录任务事实
    R-->>C: 返回 Base64(MsgPack)
    Note over L,R: /load 是恢复与完整快照聚合入口，不是所有任务完成时点的通用兜底
    Note over DB,SER: V2 存档恢复见 D8b：registry 校验与单事务替换
```

`/load` 是职责较宽的恢复与完整快照入口，但整体不是一个覆盖所有步骤的大事务。日切、校验、active quest 处理和任务对账各自使用已有的短事务或写入边界；登录任务事实只在 MsgPack 成功编码后提交。

| 事实 | 证据 |
|---|---|
| 身份解析、登录维护和永久校验 | `src/routes/cn/load.ts` |
| active quest 检查、恢复或中止退款 | `src/routes/cn/load.ts` |
| Active Mission 对账与完整玩家领域聚合 | `src/routes/cn/load.ts`、`src/data/utils/player-data.ts` |
| 登录事实使用响应 pending commit | `src/routes/cn/load.ts`、`src/routes/cn/msgpack.ts` |

本图不表示房间、TCP 或 BattleFact 可以跨进程重启恢复，也不把 `/load` 当作普通任务必须重启后才完成的设计时点。

## D8b 当前 V2 存档恢复

```mermaid
flowchart LR
    FILE["V2 存档输入"]
    PARSE["解析 schema / format"]
    REGISTRY["Player Save Registry<br/>领域表与排除域"]
    VALIDATE["全量结构、表、列与版本校验"]
    TX["单个 SQLite 事务<br/>清理目标领域并按依赖顺序替换"]
    PRESERVE["保留目标 player.id / account_id"]
    EXCLUDE["排除 account / session / serverConfig<br/>清理 active quest"]
    MEMORY["提交后清除进程内 active quest"]
    RESULT["恢复或克隆结果"]

    FILE --> PARSE --> REGISTRY --> VALIDATE --> TX
    PRESERVE --> TX
    EXCLUDE --> TX
    TX --> MEMORY --> RESULT
```

V2 存档只迁移声明在 registry 中的玩家业务领域。账号身份、session、服务器配置和进行中战斗不属于可迁移域；目标 `player.id` 与 `account_id` 保留。

| 事实 | 证据 |
|---|---|
| V2 schema、格式和排除域固定 | `src/data/player-save/types.ts` |
| Registry 声明领域表、依赖与 active quest 排除域 | `src/data/player-save/registry.ts` |
| 写入前完成结构、版本、表和列校验 | `src/data/player-save/v2.ts` |
| 单事务替换并在提交后清除进程内 active quest | `src/data/player-save/v2.ts` |

本图不展开旧 V1 部分恢复路径，也不把运行时 `/load` 响应当作 V2 备份文件。
