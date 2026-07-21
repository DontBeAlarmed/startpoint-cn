# 内容发布层与开发提速设计

> 日期：2026-07-20
> 状态：已被 `2026-07-22-content-sync-design.md` 取代；仅保留历史背景和开发提速决策
> 范围：国服 CDN 版本更新、自制补丁、服务端主数据生成、新后台 CDN 管理、Android 启动器契约、开发测试提速
> 实施约束：按阶段独立提交，不推送远程仓库；客户端验收由用户确认后再决定后续动作

## 一、目标

本设计解决两个相互关联的问题：

1. 缩短服务端开发、测试、构建和重启的反馈时间。
2. 建立统一的内容发布层，使客户端 CDN 补丁和服务端业务主数据由同一次发布生成，避免角色、卡池、商店等内容发生漂移。

最终希望形成以下关系：

```text
国服最终 CDN 1.4.54 + 受版本控制的修复 Overlay
                         │
                         ▼
                Content Builder
                         │
                         ▼
              不可变 Content Release
              ├── 客户端 CDN 版本图和归档清单
              ├── 服务端归一化 runtime 数据
              ├── 来源与摘要信息
              └── 校验报告
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
          CDN Planner  游戏服务端   管理后台/启动器
```

## 二、不在本设计范围内

- 不把约 10GB 的 CDN ZIP 提交到 Git 仓库。
- 不在服务端请求过程中实时解压、解析大型 CDN ZIP。
- 不立即创建独立 CDN 仓库或独立网络服务。
- 不在第一阶段实现 Android 启动器 UI 或 APK 补丁器。
- 不在第一阶段实现服务端主数据热切换；内容版本切换后先通过受控重启生效。
- 不修改客户端来修正 CDN 协议问题。

## 三、现状与根因

### 3.1 当前存在三套独立数据

| 数据层 | 当前来源 | 当前更新方式 |
|---|---|---|
| 客户端 CDN | `.cdn/cn/archive-*`、`assets/asset-patch` | 手工放入 ZIP、修改 manifest、重启服务 |
| 服务端业务主数据 | `assets/*.json`、`assets/cdndata/*.json` | 手工运行多个转换脚本并复制结果 |
| 玩家状态 | SQLite `players_*` | 玩家操作时写入，不保存完整主数据 |

只新增客户端 CDN 补丁不会更新服务端 JSON。新角色、卡池和商店即使已能在客户端显示，服务端仍可能因缺少定义、赔率、商品映射或关联数据而拒绝请求。

SQLite 主要保存玩家拥有物、抽卡进度和购买次数。新增内容通常不要求数据库结构迁移，但必须检查以下兼容问题：

- 新 ID 是否与历史 ID 冲突。
- 删除或替换定义后，现有玩家记录是否成为孤立数据。
- 商品 ID 复用是否错误继承历史购买次数。
- 卡池 ID 复用是否错误继承历史抽取状态。

### 3.2 当前 CDN 与服务端的耦合性质

当前不是“服务端运行时从 CDN 取值”，而是“服务端 JSON 曾经由 CDN 离线提取”。因此两者属于：

- 运行时弱耦合：服务端启动后不依赖 CDN 主数据解析。
- 发布时强耦合：客户端内容和服务端定义必须人工同步，却没有共同版本和校验结果。

### 3.3 约 700M 显示错误

当前 `get_path` 对已有资源的客户端仍返回全部历史差分。当前三个 Android 差分目录合计约 711.7MiB，因此客户端弹窗显示约 700M。

客户端弹窗会累加响应内所有 `diff[].archive[].size`；实际下载器只从当前 `res_ver` 沿版本链下载可达节点。由此产生“显示约 700M，但实际只下载新补丁”的现象。

修复原则：服务端必须先计算从当前版本到目标版本的唯一可达路径，再只返回该路径上的差分归档。

### 3.4 当前协议与版本实现的风险

1. `version_info.total_size` 当前统计 full ZIP 加历史 diff ZIP 的压缩体积，但客户端把它作为安装后资源体积和存储空间检查依据。
2. `delayed_assets_size=0`，没有真正区分 shortened 与 fulfill。
3. 有效版本读取 manifest，下载列表却独立扫描 `active/`，两者可能不一致。
4. `detectCDNVersion()` 没有统一使用解析后的 `CDN_DIR`。
5. 版本和 manifest 存在进程缓存，后台修改后不能形成完整、安全的发布动作。
6. Recovery 的文件清单、下载基址和单文件供给尚未形成闭环。
7. 当前 CN 资源下载主要按 Android medium 固定处理；平台和资源尺寸模式没有成为正式规划输入。
8. `routes/cn/asset.ts` 与旧的 `routes/api/asset.ts` 同时存在，职责容易混淆；CN 入口实际使用前者。

### 3.5 当前开发慢点

现状测量：

| 操作 | 当前耗时 |
|---|---:|
| `gacha_draw_weights` 使用 `ts-node/register` | 93.84 秒 |
| 同一测试强制 transpile-only | 3.75 秒 |
| 4GB 堆完整 TypeScript `--noEmit` | 约 25.76 秒 |
| 新后台生产构建 | 约 34 秒 |

主要原因：

- 多个测试使用 `ts-node/register` 重复进行类型检查。
- 31 个工具测试分别启动 Node，并重复解析大型 JSON 和模块图。
- 纯计算模块与数据库、种子验证、全部主数据发生导入耦合。
- `build:admin` 每次都执行 `npm install`。
- 后端改动和后台构建没有明确分开。
- TypeScript 直接推导大量 JSON；当前 `assets` 约 82MB，源码约有 127 处 JSON import。

## 四、架构决策

### 4.1 使用“内容发布层”，不只抽离静态 CDN

推荐在 `starpoint-cn` 仓库内建立独立内容发布模块。它同时负责：

- 客户端所需的 CDN 版本图和差分归档元数据。
- 服务端所需的归一化 runtime 数据。
- 两侧共同的版本、来源、摘要和校验报告。

第一阶段不拆独立仓库。待 manifest、管理 API 和启动器契约稳定后，再评估独立发布。

### 4.2 内容发布必须是显式动作

不采用“监视目录后自动覆盖线上数据”的方式。完整发布流程为：

```text
导入/选择来源
  → 构建 staging release
  → 结构校验
  → 跨表引用校验
  → CDN 版本图校验
  → 差异与删除审计
  → 用户确认 candidate
  → Runtime Supervisor 候选启动
  → 启动成功后原子提升为 configured
  → 启动失败则恢复原 configured release
```

这样既能实现自动生成，又不会让半完成补丁自动进入运行环境。

### 4.3 发布产物不可变

已生成的 release 不允许原地修改。修复同一客户端资产版本下的服务端数据时，创建新的 `contentRevision`；需要改变客户端资源时，创建新的 `assetVersion`。

大型归档进入内容寻址对象库：

```text
CDN_DIR/cn/objects/sha256/<digest>.zip
CDN_DIR/cn/releases/<bundleId>/archive-catalog.json
```

release catalog 只引用对象摘要，不引用可被覆盖的 `active/文件名.zip`。相同归档由多个 release 共享，不重复占用空间。对象一旦导入便只读；删除只能通过显式垃圾回收完成，而且只有在没有任何保留 release 引用时才允许。

迁移现有 10GB 基线时不要求立即复制全部文件。导入器可以为现有归档建立摘要索引并登记只读位置，但激活和启动必须验证文件存在、大小及摘要缓存。新增或发生变化的归档必须进行完整 SHA256 校验；后台任务定期重新校验基线对象，发现篡改后立即把相关 release 标记为 invalid。

## 五、版本模型

一个内容发布包含三个不同标识：

| 标识 | 示例 | 用途 |
|---|---|---|
| `assetVersion` | `1.4.55` | 客户端 `res_ver` 和 CDN 差分链 |
| `contentRevision` | `cn-1.4.55+r2` | 服务端归一化数据修订 |
| `bundleId` | 内容摘要 | 唯一标识完整 release、校验和回滚 |

规则：

- 只修改服务端修复 Overlay 时，不虚增客户端 `assetVersion`。
- 修改客户端 orderedmap、图片、音频或其他资源时，必须产生新的 `assetVersion`。
- `bundleId` 由规范化后的 manifest 内容计算，不包含构建时间等非确定字段。
- 服务器启动日志、管理后台和启动器必须同时显示这三个标识。

### 5.1 `bundleId` 计算规则

构建器先生成不含 `bundleId` 的 `contentRoot`，使用 UTF-8、稳定键排序、无多余空白的规范 JSON 编码，再计算：

```text
bundleId = "sha256:" + SHA256(canonicalJson(contentRoot))
```

`contentRoot` 必须包含完整摘要闭包：

- schema、构建器和校验规则版本。
- baseline、`assetVersion`、`contentRevision`。
- source 与 Overlay 摘要。
- 每个 runtime 文件的相对路径、字节数和 SHA256。
- EntityLists、archive catalog 和 patch graph 摘要。
- 所有归档对象的 SHA256 和字节数。
- 确定性 validation report 和 diff report 摘要。

构建时间、激活时间、操作人和日志等非确定信息放入独立 `build-metadata.json`，不参与 `bundleId`。针对某个玩家数据库生成的删除引用检查属于 deployment activation report，也不参与 `bundleId`。重新使用相同输入构建必须得到相同 `bundleId`。

## 六、Content Release 格式

建议的逻辑结构：

```text
content-release/
├── manifest.json
├── runtime/
│   ├── characters.json
│   ├── gachas.json
│   ├── shops.json
│   ├── quests.json
│   └── indexes.json
├── client/
│   ├── entity-lists.json
│   ├── archive-catalog.json
│   └── patch-graph.json
└── reports/
    ├── build-validation.json
    ├── diff-summary.json
    └── references.json
```

实际 10GB ZIP 继续位于 `CDN_DIR`。release 只保存位置、大小、摘要和版本边，不复制大型归档。

### 6.1 manifest 必需字段

```json
{
  "schemaVersion": 1,
  "bundleId": "sha256:...",
  "baseline": "cn-final-1.4.54",
  "assetVersion": "1.4.55",
  "contentRevision": "cn-1.4.55+r1",
  "sourceDigest": "sha256:...",
  "overlayDigest": "sha256:...",
  "runtime": {
    "characters": { "count": 506, "sha256": "..." },
    "gachas": { "count": 585, "sha256": "..." },
    "shopItems": { "count": 3600, "sha256": "..." }
  },
  "client": {
    "platforms": ["android"],
    "fullBase": "1.4.0",
    "patchGraphDigest": "sha256:..."
  }
}
```

manifest 中的 `runtime` 示例只是摘要展示。实际文件清单必须枚举 release 拥有的全部 runtime 文件，不能只记录角色、卡池和商品三个计数。

## 七、内容构建器

### 7.1 输入

- `wf-assets-cn/orderedmap` 国服最终主数据。
- `.cdn/cn` 中的归档和 EntityLists。
- 受版本控制的 Overlay。
- 新角色、卡池、商店等补丁附带的资源和主数据定义。

### 7.2 Overlay 规则

Overlay 必须使用结构化数据，不允许依赖手工修改旧生成结果。推荐分类：

```text
content/overlays/
├── server/
│   ├── rush-constant-shop.json
│   └── server-data-fixes.json
├── client/
│   └── orderedmap-patches.json
└── shared/
    ├── custom-characters.json
    ├── custom-gachas.json
    └── custom-shops.json
```

共享 Overlay 同时生成客户端和服务端产物。仅客户端或仅服务端的修复必须明确标注作用域。

现有 Rush 常驻商店回退等推测性兼容逻辑，后续应评估迁入显式 Overlay，避免隐藏在通用资产查询函数中。

### 7.3 生成边界

构建器负责：

- 统一处理 orderedmap 的数组包装和字段映射。
- 生成角色、装备、卡池、赔率、商店、关卡、任务和各类索引。
- 生成客户端补丁 orderedmap 和差分 ZIP。
- 生成商品 ID 映射、查找表和跨表引用索引。
- 输出稳定排序、稳定 JSON 格式和确定性摘要。

构建器不负责：

- 修改玩家 SQLite。
- 启动服务端。
- 自动激活未通过校验的 release。

### 7.4 数据权威清单

以下内容必须由 release 拥有并出现在 runtime 文件清单中：

- 角色、角色文本、种族、玛纳板、能力、EX 数据和角色任务。
- 装备、物品、分解、强化、制作和查找索引。
- 卡池定义、角色/装备赔率、campaign、box gacha 和客户端 feature content。
- 通用商店、活动商店、Boss 币、星之粒、追忆强化及所有商品 ID 映射。
- 主线、活动、特殊关卡、体力成本、掉落、通关奖励和排名奖励。
- 常规、每日、活动、觉醒等任务定义、阶段、奖励及关卡映射。
- 活动配置、时间表、挑战点、百科、文本和其他由 CDN/Overlay 决定的配置。
- 客户端 orderedmap、EntityLists、资源归档和补丁版本图。

以下内容继续由服务端代码拥有：

- HTTP/MsgPack/TCP 协议和序列化规则。
- 数据库事务、库存防重、权限和防作弊规则。
- 不能从主数据表达的算法及明确记录的兼容策略。

以下内容属于部署运行状态，不进入 Content Release：

- 玩家 SQLite、账号绑定、邮件和购买记录。
- `confirmed_seeds.json` 等会随客户端验证过程变化的本地种子状态。
- 服务日志、job 状态、控制令牌和 configured/loaded/previous 指针。

客户端物理配置生成的默认 seed pool 可以属于 release；运行中积累的验证结果不能参与 `bundleId`。

构建器维护机器可读的数据权威清单。出现未声明生成文件、运行时直接读取 `wf-assets-cn`、或新增直接 `assets/*.json` import 时，验证失败。兼容策略若能表示为数据，应迁入 Overlay；确需留在代码中的策略必须引用明确的策略 ID 和适用 contentRevision 范围。

## 八、校验器

release 激活前必须通过以下校验：

### 8.1 结构校验

- JSON 和 manifest schema 正确。
- 必填字段存在，数值范围合法。
- 版本号和平台标识合法。
- ZIP 内路径没有绝对路径、`..` 或重复覆盖歧义。

### 8.2 ID 与引用校验

- 角色、装备、物品、卡池、商品和关卡 ID 唯一。
- 卡池角色和装备均存在于 runtime 定义。
- 商品成本和奖励引用有效。
- 玛纳板、角色任务、文本和角色定义相互对应。
- 关卡奖励、活动代币和商店形成可完成流程。
- 新商品 ID 不与已有购买记录语义冲突。

### 8.3 CDN 校验

- 每个 archive 文件存在，大小和 SHA256 匹配。
- 差分图不存在环和冲突边。
- 每个受支持起始版本到目标版本至多存在一条有效路径。
- 启用的 patch、有效目标版本和实际 active archive 完全一致。
- 初始安装路径包含 full base 和到目标版本的连续差分。

### 8.4 差异审计

- 汇总新增、修改、删除的角色、卡池、商品和关卡。
- 删除定义默认阻断激活，必须显式确认。
- 检查现有 SQLite 中引用了即将删除 ID 的记录。
- 对超过阈值的数量变化给出警告，防止字段错位造成大面积空数据。

前后 release 的内容差异报告是确定性构建产物。SQLite 引用检查在 candidate 激活前针对当前部署单独执行，写入 activation report；两者不能混成影响 `bundleId` 的同一报告。

## 九、CDN Catalog 与 Planner

### 9.1 Catalog

Catalog 是归档元数据的唯一来源，每条版本边包含：

```text
fromVersion
toVersion
platform
assetSizeKind
archives[{ location, compressedBytes, sha256 }]
```

不再由版本模块和下载路由分别扫描不同目录。

一条逻辑版本边可包含多个有序层：`common → quality → platform`。Planner 先选择与平台和资源模式匹配的层，再按该顺序展平归档，避免只过滤 Android 包而漏掉 common 数据。第一阶段正式支持 Android；收到其他平台请求时返回明确的不支持错误，不静默复用 Android 清单。

第一阶段 shortened 与 fulfill 使用相同归档集合并保持 `delayed_assets_size=0`，明确表示“仅支持完整资源模式”。只有构建器能生成经过验证的 shortened 子集后，才能启用两种不同计划。

### 9.2 Planner 输入

```text
currentVersion
targetVersion
platform
assetSizeKind
isInitial
```

### 9.3 Planner 输出

- 初始安装：`full` 为目标平台 full base，`diff` 只包含从 full base 到目标版本的连续差分。
- 增量更新：`full=null`，`diff` 只包含从 `currentVersion` 到目标版本的可达差分。
- 已是最新：`full=null` 且 `diff=null`。国服客户端将 `null` 或缺失字段解析为 `Option.None`，只有两者均为 None 才进入无需下载分支；空数组会被解析为 `Option.Some([])`，不能替代 `null`。
- 路径缺失、分叉或归档缺失：拒绝生成响应并记录可诊断错误。

客户端弹窗所显示的下载大小必须等于 Planner 输出归档的 `compressedBytes` 之和。

### 9.4 `version_info` 大小语义

- `total_size`：目标 release 安装后的预计资源体积。
- `delayed_assets_size`：fulfill 相比 shortened 额外安装的资源体积。
- `downloadBytes`：不放入旧协议字段，由 Planner 根据当前客户端动态计算，后台和启动器可单独展示。

安装体积应由最终 EntityLists 或构建产物索引计算，不能继续用“full ZIP 加全部历史 diff ZIP”代替。

### 9.5 Recovery 策略

第一阶段明确使用构建器生成的空检查清单，暂时关闭单文件完整性检查，禁止返回客户端无法实际下载的 Recovery 文件。

后续只有在独立文件索引和供给端点完成后才能重新启用正式检查。启用时必须保证 `base_url + hash` 能读取目标 release 中对应文件，并校验大小和摘要。

系统不能继续处于“正式 CSV 已启用，但 Recovery 地址无法完整供给”的中间状态。

## 十、服务端 ContentRepository

业务代码不再直接 import 大型 JSON，而通过只读接口访问当前 release：

```text
ContentRepository
├── getCharacter(id)
├── getGacha(id)
├── getEventShop(eventType, eventId)
├── getShopItem(shopItemId)
├── getQuest(category, questId)
├── getMission(id)
└── getReleaseInfo()
```

第一阶段保留 `src/lib/assets.ts` 作为兼容门面，内部逐步改为调用 `ContentRepository`，避免一次性重写全部路由。

服务端启动时：

1. 读取 `configuredBundleId` 对应的 release manifest。
2. 校验 runtime 文件摘要。
3. 构建只读索引。
4. 输出 bundle/version 信息。
5. 校验失败则拒绝启动，而不是回退到混合版本。

第一版切换 release 后要求重启，确保一次请求不会跨越两个内容快照。

### 10.1 配置版本与已加载版本

第一版不允许管理 API 在当前进程内热替换 ContentRepository。服务状态必须同时返回：

```text
candidateBundleId   已通过预校验、等待候选启动的 release
configuredBundleId  最近一次成功启动并被设为默认的 release
loadedBundleId      当前服务进程实际加载的 release
restartRequired     两者是否不一致
previousBundleId    configured 之前最近一次成功启动的 release
```

激活动作采用两阶段状态机：

1. Release Manager 完成预校验并写入 `candidateBundleId`，不修改 `configuredBundleId`。
2. Runtime Supervisor 停止当前游戏服务，使用 candidate 执行候选启动。
3. candidate 完成主数据、全部归档和端口前置校验后写出 boot receipt。
4. Supervisor 收到成功 receipt 后原子提升 candidate 为 configured，并完成正式启动。
5. candidate 启动失败时 configured 从未改变；Supervisor 使用 previous/configured release 恢复旧服务。

后台不得把 candidate 标记为“已激活”或“已加载”。不得静默混用旧 runtime 数据和新 CDN manifest。

Runtime Supervisor 是独立于游戏服务进程的生命周期管理者。桌面阶段由本地 CLI/轻量守护进程承担；Android 阶段由启动器内的 Server Runtime Supervisor 承担。游戏服务不能负责重启自身。

## 十一、管理后台 CDN 模块

新后台应增加独立 CDN/内容发布页面，旧后台不扩展。

### 11.1 页面能力

- 当前 release：三个版本标识、来源、摘要和激活时间。
- 同时显示 configured/loaded release；不一致时明确提示需要重启。
- CDN 存储：目录、平台、ZIP 数量、体积和缺失项。
- Release 列表：staging、validated、active、archived、invalid。
- 导入补丁：选择补丁包，显示预计变更。
- 校验报告：结构、引用、版本图、SQLite 兼容性。
- 更新预览：输入客户端版本后显示真实下载路径和大小。
- 激活与回滚：二次确认，记录操作结果。
- 构建任务：进度、日志和失败原因。

### 11.2 管理 API

建议接口：

```text
GET  /api/server/content/current
GET  /api/server/content/releases
GET  /api/server/content/releases/:id
GET  /api/server/content/releases/:id/validation
POST /api/server/content/import
POST /api/server/content/releases/:id/validate
POST /api/server/content/releases/:id/activate
POST /api/server/content/releases/:id/archive
POST /api/server/content/rollback
POST /api/server/cdn/plan
```

导入、构建和校验属于长任务，接口返回 job ID；后台通过轮询读取状态。不得让 HTTP 请求同步等待完整 CDN 扫描或 ZIP 构建。

### 11.3 操作所有权与并发

- Release Manager 拥有导入、构建、校验、candidate 和发布状态机。
- Runtime Supervisor 独占停止、候选启动、正式启动和失败恢复。
- 管理后台和 Android 启动器只是客户端，不各自实现发布逻辑。
- 同一个 content store 同时只允许一个写任务；第二个导入、激活或回滚请求返回冲突状态。
- job 和锁状态持久化在独立内容状态库，不写入玩家数据库；进程重启后可恢复或明确标记中断。
- 破坏性管理接口默认只绑定本机控制面，并使用独立控制令牌；普通游戏 API 凭据不能调用发布操作。

### 11.4 安全边界

- 只允许导入声明格式的补丁包。
- 解压前检查路径穿越、文件数、单文件大小和总大小。
- 归档摘要不匹配时拒绝激活。
- 激活操作必须留下本地审计记录。
- 后台不允许直接编辑任意服务器文件路径。

## 十二、Android 启动器契约

启动器不解析 orderedmap，也不复制服务端构建逻辑。它通过 manifest 和管理 API 完成：

- 显示当前 release 和 CDN 完整性。
- 导入已经生成的内容/补丁包。
- 请求服务端校验和激活。
- 在激活后受控重启 Server Runtime。
- 若新 release 启动失败，使用 previous 指针回滚并重新启动。
- 输入游戏客户端本地版本，预览真实更新大小。
- 判断客户端补丁 profile 是否与当前服务端/CDN release 匹配。

CDN 文件仍存放在外部目录，不打入启动器 APK。

## 十三、开发测试提速设计

### 13.1 命令分层

建议形成以下入口：

| 命令 | 用途 | 目标时间 |
|---|---|---:|
| `test:quick` | 当前模块纯单元测试，transpile-only | 5 秒内 |
| `test:changed` | 根据改动文件运行关联测试 | 20 秒内 |
| `typecheck` | 单次严格 TypeScript 校验 | 阶段 0 为 30 秒内；ContentRepository 完成后为 15 秒内 |
| `test:integration` | Fastify + SQLite 集成测试 | 30 秒内 |
| `test:full` | 全部服务端回归 | 60 秒内 |
| `verify:full` | 类型、测试、卫生、服务端构建 | 提交前执行 |
| `build:server` | 只构建 CN 服务端 | 不构建后台 |
| `build:admin` | 只构建后台 | 不执行依赖安装 |

时间验收使用当前默认 Node.js、依赖已安装、文件系统缓存已预热的本机环境；每个命令连续运行三次并取中位数。测试报告记录用例数、跳过数、失败数和总耗时。

### 13.2 测试执行原则

- 测试统一使用 transpile-only；严格类型检查由单独 `typecheck` 保证。
- 纯测试允许有限并行。
- 使用共享真实数据库、端口或进程全局状态的集成测试必须串行。
- 每个测试必须主动关闭 SQLite、Fastify、TCP 和定时器句柄。
- 不能依赖主进程被 Ctrl-C 才退出。
- 数据生成和物理 seed 扫描不进入普通回归，单独归为生成器校验。

`test:changed` 使用受版本控制的测试映射表，把源码目录/文件 glob 映射到测试组；无法识别的改动自动升级为 integration 或 full，不能静默跳过。纯测试组可限并发运行，数据库和端口测试组保持串行。

### 13.3 模块解耦

优先拆出纯逻辑模块，例如：

- 扭蛋权重选择不应导入种子验证、SQLite、奖励发放和全部资产。
- CDN 版本路径规划不应启动 Fastify。
- Content Builder 字段转换不应读取玩家数据库。
- 管理后台状态格式化不应扫描真实 10GB 目录。

纯逻辑模块使用小型 fixture 测试；集成测试只验证边界接线。

### 13.4 TypeScript 与 JSON

内容发布层完成后，TypeScript 不再直接推导全部大型 JSON。构建期校验生成符合明确接口的 runtime 文件，服务端通过 loader 和稳定类型读取。

同时增加 CN 专用 TypeScript 构建入口，只编译 `cn-server` 及其依赖，避免旧全球服入口和未使用资产路由进入日常构建。

### 13.5 后台构建

- 依赖安装拆成单独 `install:admin`。
- `build:admin` 只运行 `tsc -b` 和 Vite build。
- 纯后端改动不构建后台。
- 后台开发使用 Vite 开发服务器；只有需要 8001 提供生产产物时才执行生产构建。

## 十四、迁移策略

采用渐进迁移，不进行一次性重写。

### 阶段 0：开发反馈提速

- 统一 transpile-only 测试入口。
- 拆分 server/admin 安装与构建。
- 修复测试进程不退出问题。
- 建立 quick、changed、integration、full、verify 分层。

### 阶段 1：CDN Catalog 与 Planner

- 统一 `CDN_DIR` 解析。
- 从归档生成确定性 catalog。
- 建立版本图校验和路径规划器。
- 修复约 700M 的显示错误。
- 明确 `total_size`、shortened 和 Recovery 策略。

### 阶段 2：Content Builder 与 Release Manifest

- 导入现有 1.4.54 作为基线 release。
- 统一现有分散的 Python、TS、CJS 生成器入口。
- 建立 Overlay、provenance、差异报告和引用校验。
- 保持现有 runtime JSON 内容等价。
- 本阶段 release 只能构建和验证，不能激活自定义版本。

### 阶段 3：ContentRepository

- 先建立兼容 loader，把全部直接 runtime JSON import 改为从 `CONTENT_RUNTIME_DIR` 读取。
- 加入覆盖审计；仍存在未声明的直接 `assets/*.json` import 时禁止激活 release。
- 建立桌面 Release Manager 状态库和本地 Runtime Supervisor CLI，完成 candidate 启动、成功提升和失败恢复。
- 兼容 loader 覆盖全部现有 runtime 文件后，才允许激活第一份自定义 release。
- 服务端加载 release manifest 并验证摘要闭包。
- `assets.ts` 再改为 ContentRepository 兼容门面。
- 按角色、卡池、商店、关卡、任务逐域迁移。
- 去除运行时直接读取 `wf-assets-cn` 的例外路径。

### 阶段 4：新后台 CDN 页面

- 先实现只读 release、校验和更新预览。
- 再实现导入、构建、激活和回滚。
- 所有危险动作均要求二次确认并记录审计结果。

### 阶段 5：Android 启动器接入

- 启动器消费同一 manifest 和管理 API。
- 增加 CDN 完整性、release 匹配和真实下载大小展示。
- 激活新 release 后受控重启服务端并启动游戏。

## 十五、提交边界

每个阶段至少独立提交一次，禁止把全部架构调整压成单个提交：

1. 开发测试提速。
2. CDN Catalog 与 Planner。
3. Content Builder 与校验器。
4. Release manifest 与基线导入。
5. Release Manager 与桌面 Runtime Supervisor。
6. ContentRepository 各领域迁移。
7. 新后台 CDN API。
8. 新后台 CDN 页面。
9. Android 启动器契约或实现。

所有提交仅保留本地，用户验收后再决定是否 push。

## 十六、验收标准

### 开发提速

- 同一扭蛋权重测试不再触发完整类型检查和数据库初始化。
- `test:quick`、`test:changed`、`test:integration`、`test:full` 可独立运行。
- 全部测试完成后进程自行退出。
- 后端改动无需执行 `npm install` 或构建管理后台。
- 阶段 0 的三次中位数满足：quick 不超过 5 秒、changed 不超过 20 秒、integration 不超过 30 秒、full 不超过 60 秒、typecheck 不超过 30 秒。
- ContentRepository 迁移后 typecheck 三次中位数不超过 15 秒。

### CDN 更新

- 从 `1.4.54` 更新到单个新补丁时，客户端显示大小等于该补丁实际归档大小。
- 初次安装仍能得到 full base 加完整连续差分链。
- 已是最新版本时不会弹出错误的历史差分下载提示。
- manifest 启用状态、目标版本和实际归档不存在分歧。
- 未知客户端版本和断裂版本图会被明确拒绝，不返回不完整下载计划。
- Android fulfill 和当前等价的 shortened 计划分别通过协议测试；未支持平台不会收到 Android 清单。
- 第一阶段 Recovery 返回空检查清单；重新启用前必须通过单文件下载闭环测试。

### 内容一致性

- 新增角色时，客户端资源和服务端角色、文本、玛纳板等定义来自同一 release。
- 新增卡池时，客户端 banner、服务端卡池、赔率和角色引用同时通过校验。
- 新增商店时，商品列表、成本、奖励和 ID 映射同时生成。
- 激活失败不会改变当前 release。
- 可以回滚到上一份已验证 release。
- 相同输入重复构建得到相同 `bundleId`。
- 任一归档被替换或删除后，相关 release 无法激活且运行状态显示 invalid。
- 候选启动失败时 configured 指针不变，Supervisor 自动恢复上一服务版本。
- 渐进迁移期间只允许验证 release，不允许在直接 JSON import 覆盖审计通过前激活。
- 删除仍被 SQLite 玩家记录引用的 ID 时，激活默认被阻断并要求显式确认。

### 后台与启动器

- 新后台能显示当前 release、校验报告和真实更新计划。
- 后台导入补丁后必须先验证，不能直接覆盖 active 内容。
- Android 启动器不复制内容生成逻辑，只消费公开 manifest 和管理 API。
- 两个并发写任务中只有一个能获得发布锁；另一个得到可识别的冲突响应。
- Release Manager、Runtime Supervisor、后台和启动器的状态在进程重启后保持一致。

## 十七、设计结论

项目需要抽离的不是单一静态 CDN 路由，而是“内容构建、校验、版本规划和发布”这一完整边界。客户端 CDN 和服务端 runtime 数据应作为同一 Content Release 的两个输出；游戏服务端、管理后台和未来 Android 启动器分别消费该 release，而不再各自推测内容状态。

实施顺序保持：先提速开发验证，再修复 CDN Catalog/Planner，随后建设 Content Builder/Release，最后接入服务端、后台和启动器。
