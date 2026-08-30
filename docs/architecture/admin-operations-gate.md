# 后台运营能力 Gate 目标架构设计

实现状态：已实现，等待客户端实机验收。

## 1. 目标

本 Gate 在不修改 CN 1.8.1 客户端的前提下，完成四个顺序检查点：

1. 集中运行时与运营协议的生产权威值；
2. 使用 SQLite 管理普通公告；
3. 使用客户端原生入口实现公共礼包码；
4. 恢复邮件后台的玛纳和经验值，并停止新建 Boss Boost、Boost、Rank 点邮件。

四个检查点属于同一 Gate、共用本规格和一份仓库外实施计划。每个检查点独立执行聚焦 TDD 和代码审查；整个 Gate 最终稳定后只运行一次广域测试。功能完成后创建本地 commit，不 push，等待实机验收。

本 Gate 不实现：

- Hub 模式切换或在线管理；
- Attention、随机招募或救援铃铛；
- 公告 forced、system、维护、普通已读或红点；
- 后台登录认证；
- 礼包有效期、batch、channel、总领取人数限制；
- 礼包的单条领取重置或人工重发；
- 资源补充弹窗或客户端补丁。

## 2. 共同安全与运行边界

后台继续沿用当前可信网络边界：本机、可信 LAN、可信 VPN，或部署者提供认证的反向代理。服务端不在本 Gate 增加管理员账号、密码、Cookie、CSRF 或公网安全承诺。管理 HTTP `8001` 不得直接暴露到不可信公网。

所有后台写入必须：

- 使用 JSON API；
- 执行服务端完整校验，不能信任 React 表单；
- 使用参数化 SQL；
- 使用 revision 乐观并发，冲突返回 HTTP 409；
- 在业务要求的同一 SQLite 事务中完成全部写入；
- 不把礼包 code、玩家身份或奖励大对象写入普通日志；
- 不记录绝对路径、LAN IP、device ID、session 或 Hub token；
- 不修改 `.env`、RuntimeConfig、Hub 配置或 Server Bundle active 指针。

## 3. 检查点一：运行时与运营协议契约集中化

### 3.1 单一生产权威

新增仓库内只读发布契约，例如：

```text
assets/server_release_contract.json
```

该文件是随 Server Bundle 发布的代码契约资产，不是后台可编辑数据，也不进入 Content Release 动态表注册。TypeScript 通过一个小型冻结适配器导出类型安全常量；CommonJS Bundle builder/verifier 直接读取同一 JSON 并执行 shape 校验。

契约包含：

```json
{
  "serverManifestSchemaVersion": 3,
  "runtimeApiVersion": 1,
  "minimumDataSchema": 0,
  "currentDataSchema": 24,
  "serverEntry": "out/cn-server.js",
  "localPrepareEntry": "out/content/sync/entry.js",
  "adminPath": "web/dist",
  "adminRequired": true,
  "bundledCdnCatalogVersion": "1.4.54",
  "supportedAssetModes": ["client-owned", "local", "remote"],
  "defaultPorts": {
    "http": 8001,
    "tcp": 8003,
    "hub": 8004
  }
}
```

公告提交完成后 `currentDataSchema` 为 23；礼包提交完成后为 24。

以下生产组件必须消费同一权威：

- `src/data/index.ts` 数据库 latestVersion；
- Server Bundle builder；
- Server Bundle verifier；
- runtime bundle metadata；
- runtime capabilities 的 Runtime API；
- Content baseline 常量和 health `minClientVersion`；
- 固定入口、admin path、supported asset modes 和默认端口的生产校验；
- 文档契约检查器。

运行时实际端口仍可由环境变量覆盖。Bundle 中的端口表示默认契约，不得被误当成已启动进程的实际 endpoint。

### 3.2 独立测试锚点

大多数只表达“当前生产值”的测试读取共享契约，避免升级后散落旧断言。仍保留一组独立字面量锚点，明确断言：

```text
server manifest schema = 3
runtime API = 1
CN Content baseline = 1.4.54
公告完成时 schema = 23
礼包完成时 schema = 24
schema 22 → 23 公告迁移
schema 23 → 24 礼包迁移
schema 25 被最终服务器拒绝
server entry / local prepare entry / admin path 的固定字符串
```

迁移测试不得使用 `CURRENT - 1` 或 `CURRENT + 1` 推导期望。生产 builder 和 verifier 可以共享值，但至少一个测试必须用字面量验证公开契约，避免两边共同写错后自证通过。

### 3.3 不合并的版本

以下版本仍保持独立：

- SQLite data schema；
- Player Save format version；
- Content manifest schema；
- Server Manifest schema；
- Runtime API；
- Multi protocol version；
- Hub credential store schema。

相同数字不表示同一职责，禁止建立“全项目统一版本号”。

## 4. 检查点二：普通公告管理

### 4.1 数据源与迁移

SQLite 是公告唯一运行时主数据源。实现时删除：

```text
assets/news.json
```

同时移除该文件的 Content registry、动态读取、测试和文档依赖。新数据库公告表为空；不导入旧 JSON、不 seed、不 fallback。数据库或公告表不可用时返回明确服务错误或阻止启动，不能静默返回旧文件内容。

schema 23 创建：

```sql
CREATE TABLE server_news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category INTEGER NOT NULL CHECK (category IN (1, 2, 3)),
    title TEXT NOT NULL,
    published_at_real TEXT NOT NULL,
    body_rich_text TEXT NOT NULL,
    label INTEGER NOT NULL CHECK (label BETWEEN 1 AND 8),
    thumbnail INTEGER NOT NULL CHECK (thumbnail BETWEEN 1 AND 13),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

迁移同时删除现有 `players_options` 中 `server.forced_news.%` 私有键，因为旧公告数据源和 forced 能力均不保留。

`server_news` 是服务器级运营数据：

- 不属于 Player Save；
- 不随玩家导入、导出、恢复或克隆；
- 服务重启保留；
- Server Bundle 更新不覆盖。

### 4.2 客户端端点

首版只实现普通公告：

```text
POST /api/index.php/news/index
POST /api/index.php/news/get_info
```

保持兼容空响应：

```text
POST /api/index.php/news/system_index
POST /api/index.php/news/get_system_info
POST /api/index.php/news/latest_forced
POST /api/index.php/news/latest_forced_system
```

`/load` 不因公告设置 `force_news`，不返回普通公告已读或红点事实。

### 4.3 分类与客户端投影

普通公告分类：

```text
1 Topics
2 HeldInfo
3 BugInfo
```

`/news/index` 必须按请求 category 严格过滤，再执行稳定分页。客户端每页维持当前 20 条，排序为：

```text
published_at_real DESC, id DESC
```

`label=1..8` 与 category 独立，分别表示客户端卡片标签。禁止把 category 推导为 label。

客户端投影固定为：

```ts
interface ClientNewsItem {
    id: number
    title: string
    date: string
    html: string
    label: number
    thumbnail: number
    thumbnail_path: null
    added_time: null
}
```

`thumbnail_path` 不进入数据库且永远返回 `null`，避免 CN 1.8.1 `NewsListAdapter` 触发客户端 9100。`thumbnail` 只允许已确认的内置 `1..13`。

### 4.4 时间与可见性

公告完全使用真实时间：

```text
visible = enabled && published_at_real <= getRealNow()
```

虚拟服务器时间不参与显示/隐藏。`published_at_real` 以 UTC ISO-8601 保存；客户端 `date` 由该真实时间转换为 CN 客户端期望的中国时区字符串：

```text
YYYY-MM-DD HH:mm:ss
```

客户端只格式化并显示 `date`，不自行执行未来时间过滤。

### 4.5 RichText

后台采用简单受限 RichText 源码输入和辅助预览，不实现复杂所见即所得编辑器。

允许标签：

```text
p br div h1 h2 h3 hr
ul ol li
table tr th td
```

不允许：

```text
a img script style class
任意属性
事件属性
外部 URL
scene/ 或 dialog/
::associate_token::
```

服务端使用确定性 parser 验证完整嵌套、闭合和白名单，不能只用字符串替换或单一正则。标题要求 UTF-16 长度 `1..128`；正文要求 UTF-16 长度 `1..20000`。保存和客户端返回使用同一份已校验源码。

### 4.6 后台 CRUD

后台 API：

```text
GET    /api/news
GET    /api/news/:id
POST   /api/news
PATCH  /api/news/:id
PATCH  /api/news/:id/enabled
DELETE /api/news/:id
```

支持：

- category、label、thumbnail 选择；
- 标题、RichText 正文；
- 真实发布时间；
- enabled 草稿/停用；
- 创建、编辑、启停、物理删除；
- revision 乐观并发。

已发布公告允许编辑，下一次客户端请求看到新内容；不保留历史版本、回收站、审批流或操作者审计。

更新使用：

```sql
UPDATE server_news
SET ..., revision = revision + 1, updated_at = ?
WHERE id = ? AND revision = ?
```

`changes !== 1` 返回 409。物理删除也要求当前 revision；SQLite 自增 ID 不允许后台指定或复用。

## 5. 检查点三：公共礼包码管理

### 5.1 客户端协议

能力端点：

```text
POST /api/index.php/tool/check_enable_gift
```

兑换端点：

```text
POST /api/index.php/gift/receive
body: { key: string }
```

成功响应：

```text
data.result_code = 1
data.all_gift_info = [{ type, type_id, number }]
```

客户端使用现有 `GiftDialog` 展示，不新增协议字段或客户端补丁。

### 5.2 数据表与 schema 24

schema 24 创建：

```sql
CREATE TABLE server_gift_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'stopped'
        CHECK (status IN ('stopped', 'active')),
    note TEXT,
    reward_revision INTEGER NOT NULL DEFAULT 1
        CHECK (reward_revision > 0),
    revision INTEGER NOT NULL DEFAULT 1
        CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE server_gift_rewards (
    gift_id INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    type INTEGER NOT NULL CHECK (type IN (1, 4, 5, 6, 8, 9)),
    type_id INTEGER,
    number INTEGER NOT NULL CHECK (number > 0),
    PRIMARY KEY (gift_id, position),
    FOREIGN KEY (gift_id) REFERENCES server_gift_codes(id) ON DELETE CASCADE
);

CREATE TABLE players_gift_redemptions (
    gift_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    reward_revision INTEGER NOT NULL CHECK (reward_revision > 0),
    reward_snapshot TEXT NOT NULL,
    redeemed_at TEXT NOT NULL,
    inherited_from_player_id INTEGER,
    PRIMARY KEY (gift_id, player_id),
    FOREIGN KEY (gift_id) REFERENCES server_gift_codes(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
    FOREIGN KEY (inherited_from_player_id) REFERENCES players(id) ON DELETE SET NULL
);
```

应用层进一步校验 type/type_id：

- Item、Character、Equipment 必须有合法正整数 `type_id`；
- Free VMoney、Mana、EXP 的 `type_id` 必须为 null；
- Character 和 Equipment 每条 `number=1`；
- Item 数量不超过当前 Content 官方持有上限；
- 其他资源使用 int32 安全上限；
- 每个礼包至少 1 条、最多 20 条奖励；
- position 连续且从 0 开始；
- 所有奖励必须在启动或兑换前整体校验，任一非法则不允许 active。

### 5.3 Code 约束

只对齐客户端：

- 原始字符串精确匹配；
- 区分大小写；
- 不 trim；
- 不做 NFC/NFKC；
- 不做大小写转换；
- 非空；
- 单行；
- JavaScript/AS3 UTF-16 `length <= 20`；
- 支持中文和其他客户端可输入字符；
- SQLite 默认 BINARY 唯一比较；
- code 以明文公共值保存在服务器表中；
- 客户端提交的原始 code 不写普通日志。

### 5.4 公共领取语义

一个 active code 可由当前服务器所有玩家存档各领取一次：

```text
PRIMARY KEY (gift_id, player_id)
```

无账号级共享状态、无全服总人数限制、无 batch、无 channel、无开始/结束时间。

实际 result code：

```text
1    成功
6101 code 不存在、空、换行或 UTF-16 长度超过 20
6103 code 为 stopped
6104 当前 player_id 已领取
```

6102、6105、6106 首版不使用。

### 5.5 状态机

礼包只有：

```text
stopped
active
```

stopped 时可修改 code、奖励和 note，可删除或启动。active 时定义完全不可变，只允许停止。启停、编辑和删除均使用 revision 条件更新。

启动前事务内重新读取并校验：

- code 客户端约束；
- code 唯一；
- 奖励完整且可执行；
- status 为 stopped；
- revision 匹配。

active 后立即生效。至少存在一个 active 礼包时，统一 capability 返回 `enable_gift=true`；没有 active 礼包时为 false。`/load` 和 `/tool/check_enable_gift` 必须读取同一个 capability service，不得分别写死。

停止后可以修改奖励并再次启动。同一个 gift ID 的既有 redemption 保留：已领取存档不能重领，未领取存档获得当前 reward revision。redemption snapshot 保存历史实际奖励。

只有 stopped 可以物理删除。删除级联清除 rewards 和 redemptions；未来使用相同 code 新建会得到新 gift ID，所有存档重新可领取。后台必须在删除确认框明确提示。

### 5.6 兑换事务

客户端兑换流程：

1. 由 viewer session 解析当前 `player_id`；
2. 以原始 key 精确查询 gift；
3. 不存在或输入结构非法返回 6101；
4. stopped 返回 6103；
5. 已有 `(gift_id, player_id)` 返回 6104；
6. 在同一 SQLite 事务内重新读取 active、revision 和完整奖励；
7. 校验所有奖励；
8. 插入 redemption；
9. 使用 Reward Grant owner 发放 6 类标准奖励；
10. 每条奖励写入 receive history；
11. 保存 reward revision 和不可变 reward snapshot；
12. 提交后返回 `result_code=1` 与同一奖励列表投影的 `all_gift_info`。

奖励、history、redemption 任一步失败，事务整体回滚。并发请求由 SQLite 与复合主键保证最多一个成功。成功响应丢失后重试返回 6104，不重放成功弹窗，也不重复发奖。

### 5.7 同服克隆与外部导入导出

礼包 redemption 是服务器本地、按 player 归属的运营事实：

- 同一个 player 正常操作保留；
- 同服显式克隆时，在克隆外层事务中复制来源 redemption 到新 player，并记录 `inherited_from_player_id`；
- 普通新建存档和默认模板创建不复制；
- Player Save V2 导出不包含；
- 任意文件导入均视为外部新存档，不携带 redemption，可重新领取；导入创建新 player 时自然没有记录，导入覆盖已有 player 时必须在同一恢复事务中删除该目标 player 的全部 redemption；
- 跨服导入不携带；
- 删除 player 时级联删除其记录。

即使导出文件来自同一服务器，只要经过外部导入边界，导入目标也按未领取处理。这是明确允许的运营语义，不作为防回档限制。

`players_gift_redemptions` 在 Player Save registry 中登记为明确排除的服务器运营状态；显式同服 clone 通过专用 SQL 复制，不复用普通导出/导入路径。

### 5.8 后台管理

后台 API：

```text
GET    /api/gifts
GET    /api/gifts/:id
POST   /api/gifts
PATCH  /api/gifts/:id
POST   /api/gifts/:id/start
POST   /api/gifts/:id/stop
DELETE /api/gifts/:id
GET    /api/gifts/:id/redemptions
```

礼包列表显示 code、status、奖励摘要、reward revision、领取存档数、创建和更新时间。详情在 stopped 时允许简单奖励表单编辑；active 时只读并只提供停止。

领取记录只读，支持按 player ID、玩家名称、account ID 分页搜索，显示领取时间、reward revision、奖励快照、是否克隆继承及来源 player ID。

不提供单条删除、重置、强制已领取、人工重新领取或奖励快照编辑。玩家补偿继续使用后台邮件。

## 6. 检查点四：邮件后台资源选项

后台允许新建附件：

```text
1  道具
4  免费星导石
5  角色
6  装备
7  星之碎片
8  玛纳
9  经验值
10 羁绊之证
```

后台禁止新建：

```text
3  付费星导石
11 Boss Boost 点
12 Boost 点
15 Rank 点
```

Boss Boost、Boost、Rank 继续在玩家存档详情页直接调整。邮件后台恢复 type 8/9，只需数量、不需要 type ID，并复用已存在的 Reward Grant 领取分支。

游戏端继续兼容领取数据库中已有的 type 3/11/12/15 历史邮件，避免旧邮件变成不可领取。收紧的是后台新建白名单，不删除 `MailType` 或历史领取 writer。

## 7. 错误与事务原则

- 后台输入错误返回有限中文 400，不泄露 SQL、路径或堆栈；
- revision 冲突返回 409；
- 不存在返回 404；
- Gift 客户端业务错误通过 HTTP 成功 MsgPack 外壳返回 `result_code`，不以普通 JSON 400 代替 6101/6103/6104；
- 内部数据库或奖励异常返回现有有限远程错误，零部分写入；
- 公告读取只返回 enabled 且已到真实发布时间的记录；
- 服务未 ready 时后台 API 返回 503，不创建半成品数据；
- active 礼包兑换和 stop 操作由 SQLite 提交顺序决定：兑换先提交则成功，stop 先提交则兑换返回 6103。

## 8. 测试策略

### 8.1 每个检查点

实现子代理只运行聚焦测试：

```text
写 RED
确认失败原因正确
最小 GREEN
聚焦回归
实现者自审
Sol 审查真实 diff
必要时局部修正和 scoped re-review
```

小修只跑直接覆盖的测试，不触发 `test:changed` 或 `test:full`。

### 8.2 必测公告行为

- schema 22 → 23；
- 新表为空，不读取 `assets/news.json`；
- category 1/2/3 隔离；
- label 和 thumbnail 约束；
- enabled 与真实发布时间边界；
- 虚拟时间变化不影响；
- UTF-16 标题/正文长度；
- RichText 白名单、非法标签/属性/嵌套；
- `thumbnail_path=null`；
- 稳定分页与详情不可见边界；
- revision 并发冲突；
- 物理删除；
- forced/system 保持空；
- `players_options` 旧 forced 私有键清理。

### 8.3 必测礼包行为

- schema 23 → 24；
- code 原样、大小写、前后空格、中文、emoji UTF-16 长度；
- stopped/active 变更矩阵；
- active 定义不可修改；
- capability 与 active 数量一致；
- `/load` 与 check endpoint 一致；
- 6 类奖励正常投影；
- 非支持类型、ID、数量、条目数 fail closed；
- 同一 player 重复 6104；
- 不同 player 各自成功；
- 并发最多一次；
- 奖励/history/redemption 故障注入整体回滚；
- 成功响应丢失后的重试不重复发奖；
- stop 与兑换提交顺序；
- 停止后改奖励、再次启动，旧 player 仍已领，新 player 取得新 revision；
- stopped 删除级联，重建同名 code 全员可领；
- 同服显式 clone 复制；
- 新建/默认模板不复制；
- export 不包含；
- import 创建新 player 时没有记录；import 覆盖已有 player 时事务内清空目标记录，失败回滚时原记录恢复；
- Player Save registry 明确排除；
- 领取记录后台只读分页和搜索。

### 8.4 必测邮件行为

- UI 显示玛纳和经验值；
- UI 不显示付费星导石、Boss Boost、Boost、Rank；
- 后台 route 允许 8/9，拒绝 3/11/12/15；
- 8/9 不提交 type ID；
- 旧数据库 3/11/12/15 邮件仍可领取；
- 现有邮件事务和回滚不变。

### 8.5 Gate 最终验证

所有检查点完成、代码稳定后只运行一次广域验证：

```text
npm run test:changed（或计划锁定的等价一次性广域集合）
npm run typecheck
npm run docs:check
npm run build:server
npm run hygiene
git diff --check
```

没有代码变化时禁止连续第二次广域测试。广域失败并发生修复后，才允许再次运行受影响组或一轮最终广域验证。

## 9. 实机验收

### 公告

- 三个普通 tab 分类正确；
- 真实时间发布，虚拟时间前后调整不影响；
- 列表、分页、详情和内置缩略图正常；
- RichText 文字、标题、列表和表格正常；
- 无 forced 弹窗、system 内容和客户端 9100。

### 礼包

- 无 active 礼包时入口隐藏；
- active 后入口显示；
- 中文 code 可原样输入；
- 6 类奖励在原生 GiftDialog 中显示且实际入包一致；
- 同存档重复显示 6104；
- 不同存档独立；
- 同服克隆继承；
- 文件导入后可重新领取；
- stop 后返回 6103；
- 删除重建后重新可领取。

### 邮件

- 后台可发送玛纳和经验值；
- 客户端领取后余额正确；
- 后台不再提供 Boss Boost、Boost、Rank；
- 旧历史邮件仍可领取。

## 10. 文档与提交

正式实现必须更新：

- Server Bundle 与嵌入式运行契约；
- 数据库和 Player Save 边界；
- 管理后台说明；
- 公告系统文档；
- 礼包码系统文档；
- 邮件支持矩阵；
- 路由状态和支持矩阵；
- 测试进度。

建议本地提交序列：

```text
refactor(runtime): centralize release contracts
feat(admin): manage ordinary announcements
feat(gift): add public save-scoped gift codes
fix(admin): expose supported mail resources
docs: finalize admin operations gate
```

所有提交留在 `dev`，不 push，等待用户实机确认。
