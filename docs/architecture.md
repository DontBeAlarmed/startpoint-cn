# 架构文档 — StarPoint CN
> 状态: 核心架构   关键文件: src/cn-server.ts, src/routes/cn/*   相关端点: 全局

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js（使用当前环境默认版本；最低要求见 `package.json` 的 `engines`） |
| 语言 | TypeScript |
| HTTP | Fastify 5 |
| 数据库 | better-sqlite3 (SQLite) |
| 序列化 | MsgPack (msgpackr) |
| 客户端 | Adobe AIR SWF (ActionScript 3) |

日常开发直接使用 `node` / `npm`，不维护不同 Node 主版本的两套命令。切换 Node 主版本后，如果 `better-sqlite3` 报 `NODE_MODULE_VERSION` 或 `ERR_DLOPEN_FAILED`，执行 `npm rebuild better-sqlite3`；仍未恢复时重装依赖。

## 服务入口

### cn-server.ts

- 端口：`CN_LISTEN_PORT`（默认 8001）
- 监听：`CN_LISTEN_HOST`（默认 localhost，`.env` 中设为 0.0.0.0）
- 不包括：Kakao OpenAPI、Web 管理面板（全球服功能）

### 响应管线

```
路由 handler
  → JSON 序列化（Fastify 内置）
  → onSend hook：JSON → MsgPack 编码 → Base64 编码
  → HTTP 响应
```

### 请求管线

```
HTTP body (Base64)
  → Content-Type 解析器：Base64 解码 → MsgPack 解码 → JavaScript 对象
  → 路由 handler
```

---

## 一、响应协议

```
请求：
  Content-Type: application/x-www-form-urlencoded
  Body: base64(msgpack(object))

响应：
  Content-Type: application/x-msgpack
  Body: base64(msgpack({ data_headers: {...}, data: {...} }))
```

### data_headers 结构

```typescript
{
  force_update: boolean,    // 客户端是否强制更新
  asset_update: boolean,    // 是否有新的 CDN 资源
  short_udid: number,       // 短设备 ID
  viewer_id: number,        // 玩家 ID
  servertime: number,       // Unix 时间戳（秒）
  result_code: number       // 1 = 成功
}
```

### 错误响应（非 msgpack）

```json
{ "error": "Bad Request", "message": "..." }
```

---

## 二、CN 专有端点

### 2.1 版本检查

全局 GET 路由，无 `/api/index.php` 前缀。

| 端点 | 方法 | 用途 |
|------|:--:|------|
| `/shijtswy/version/client_release_android.dis` | GET | Android 版本配置文件 |
| `/shijtswy/version/client_release_ios.dis` | GET | iOS 版本配置文件 |

响应 `text/plain; charset=utf-8`：

```
// 用于官服正式用\r\n
{"default":{"apiPath":"shijtswygamegf.leiting.com"}}
```

### 2.2 雷霆认证

prefix: `/api/index.php`，文件：`src/routes/cn/leitingAuth.ts`

| 端点 | 用途 |
|------|------|
| `channels/channel_leiting/leiting_login` | 模拟雷霆账号登录 |
| `channels/channel_leiting/leiting_antiaddiction_login` | 防沉迷系统登录检查 |
| `channels/channel_leiting/leiting_antiaddiction_logout` | 防沉迷系统登出 |
| `channels/channel_leiting/leiting_update` | 雷霆 SDK 心跳/更新检查 |

#### leiting_login

请求 Body：
```typescript
{
  userId:    string,   // 用户标识
  game:      string,   // 游戏标识
  channelNo: string,   // 渠道号
  token:     string,   // SDK token（模拟模式下忽略）
  media?:    string,   // 媒体来源
  imei?:     string,   // IMEI
  androidId?: string,  // Android ID
  oaid?:     string,   // OAID
  mac?:      string,   // MAC 地址
  terminInfo?: string, // 终端信息
  osVer?:    string    // 系统版本
}
```

响应 data：
```json
{
  "status": "success",
  "userId": "<请求中的 userId>",
  "data": {
    "idCard": "123456",     // 模拟身份证号
    "age": 18,              // 年龄（成人）
    "isGuest": 0,           // 非游客
    "auth": 1               // 已认证
  },
  "online_server_check": true,
  "heart_beat_interval": 240
}
```

#### leiting_antiaddiction_login

响应 data：
```json
{
  "status": 0,
  "message": "success",
  "data": {
    "onlineTime": 0,
    "limitTime": 999999,    // 无限制
    "usableTime": 999999    // 无限制
  }
}
```

#### leiting_antiaddiction_logout / leiting_update

响应 data：`{}`（空对象）

### 2.3 注册/工具

prefix: `/api/index.php/tool`，文件：`src/routes/cn/tool.ts`

| 端点 | 用途 |
|------|------|
| `get_header_response` | 获取响应头握手，客户端据此获取 viewer_id |
| `auth` | 认证 stub，客户端可能调用，返回空 `{}` |
| `signup` | CN 账号注册，创建 account + 默认玩家 |

#### get_header_response

请求 Body：
```typescript
{ viewer_id: number }
```

响应 data：`[]`（空数组），`data_headers.viewer_id` 设为 body 中的值。

#### auth

请求 Body：`{}`

响应 data：`{}`

#### signup

请求 Body：
```typescript
{
  device_id:       number,   // 设备 ID
  channelNo:       string,   // 渠道号
  media?:          string,   // 媒体来源
  androidId?:      string,   // Android ID
  oaid?:           string,   // OAID
  mac?:            string,   // MAC 地址
  terminInfo?:     string,   // 终端信息
  osVer?:          string,   // 系统版本
  storage_directory_path?: string,
  first_viewer_id?: number,  // 首次 viewer_id
  advertise_id?:   string    // 广告 ID
}
```

请求 Header：
```
udid: string   // 设备 UDID
```

响应 data：
```json
{
  "login_token":  "<32位随机字母数字>",
  "newAccount":   1,
  "roleName":     "Player{accountId}",
  "accountName":  "Player{accountId}",
  "sign":         "dummy_sign",
  "createDate":   "<ISO 8601>",
  "serverName":   "StarPoint CN",
  "serverId":     1
}
```

### 2.4 玩家加载

prefix: `/api/index.php`，文件：`src/routes/cn/load.ts`

| 端点 | 用途 |
|------|------|
| `/load` | 获取玩家完整游戏数据 |

请求 Header：
```
res_ver: string   // 客户端 CDN 本地版本（可选）
```

请求 Body：
```typescript
{
  device_id:       number,
  device_token:    string,
  keychain:        number,     // accountId fallback
  graphics_device_name: string,
  platform_os_version: string,
  storage_directory_path: string,
  oaid?:   string,
  imei?:   string,
  mac?:    string,
  advertise_id?: string,
  viewer_id?: number           // 主要 accountId 来源
}
```

处理流程：

```
1. 读取 accountId (viewer_id || keychain || 1)
2. 查找玩家 → dailyResetPlayerDataSync() → collectPlayerDataPooledExpSync()
3. getClientSerializedData() 序列化完整玩家数据
4. wrapOptionFields() 补全 CN 特有字段
   ├─ last_login_time: Number → "YYYY-MM-DD HH:mm:ss"
   ├─ 30+ CN 配置字段 (cn_crash_url, enable_customer_service, ...)
   ├─ user_info 缺失字段补全 (is_bought_fund_*, monthly_*, ...)
   ├─ user_option 补全 (episode_encyclopedia_suggest_show, ...)
   └─ CN 数组字段 (tower_dungeon_list, stars_gacha_campaign_list, ...)
5. 设置 available_asset_version
   ├─ client-owned：使用客户端上报且格式合法的 res_ver
   └─ local/remote：使用进程固定 Content snapshot 的 targetVersion
```

响应 data：62 个顶层字段，含 `user_info`, `user_character_list`, `item_list`, `quest_progress`, `gacha_info_list`, `config` 等。

### 2.5 CDN 资源

prefix: `/api/index.php/asset`，文件：`src/routes/cn/asset.ts`

| 端点 | 用途 |
|------|------|
| `version_info` | CDN 版本和文件清单 URL |
| `get_path` | CDN 下载清单（full + diff） |

#### version_info

响应 data：
```json
{
  "base_url":             "http://{host}:8001/patch/cn/",
  "files_list":           "http://{host}:8001/patch/cn/recovery/empty.csv",
  "total_size":           734003200,
  "delayed_assets_size":  0
}
```

`total_size` 示例值仅用于展示字段形状；真实值取自进程固定 Catalog 的 `installedBytes`，不使用固定的 700 MB 桩值。`client-owned` 模式不发布 CDN 地址，四个字段分别返回空字符串、空字符串、`0`、`0`。

#### get_path

请求 Header：
```
res_ver:    string   // 客户端本地 CDN 版本（可选）
asset_size: string   // "fulfill"（全量）或空（部分）
```

请求 Body：`{}`（可选含 `target_asset_version`）

初始请求示例（未上报 `RES_VER`）：
```json
{
  "info": {
    "client_asset_version":          "",
    "target_asset_version":          "1.4.54",
    "eventual_target_asset_version": "1.4.54",
    "is_initial":                    true
  },
  "full": {
    "version": "1.4.0",
    "archive": [
      { "location": "http://.../archive-common-full/pinball-1.4.0-N-hash.zip", "size": 123, "sha256": "..." }
    ]
  },
  "diff": [
    {
      "original_version": "1.4.0",
      "version": "1.4.1",
      "archive": [
        { "location": "http://.../archive-common-diff/pinball-1.4.0-1.4.1-1-hash.zip", "size": 123, "sha256": "..." }
      ]
    }
  ],
  "asset_version_hash": "",
  "delayed_assets_size": 0
}
```

版本决策逻辑：

```
targetVersion = contentSnapshot.cdn.targetVersion
client_asset_version = RES_VER ?? ""
is_initial = RES_VER 不存在
downloadPlan = Catalog 中从 RES_VER（或 full base）到 targetVersion 的唯一可达路径
```

服务端不会根据请求 Body 的 `target_asset_version` 改变目标版本，也不会在请求时扫描 diff 目录或自动发现 ZIP。客户端已处于目标版本时 `full` 和 `diff` 都为 `null`；增量请求只返回从当前版本继续前进所需的 Catalog 路径。未知当前版本、无可达路径或存在多条歧义路径时明确返回错误。`client-owned` 模式要求合法 `RES_VER`，不返回下载清单，并将 `asset_update` 保持为 `false`。

## 八、消息序列化细节

### onSend hook

```typescript
fastify.addHook("onSend", (_, reply, payload, done) => {
    if (reply.getHeader("content-type") === "application/x-msgpack") {
        done(null, pack(payload).toString("base64"));
        return;
    }
    done(null, payload);  // JSON 透传
});
```

游戏 API 的所有响应经过 `JSON → msgpackr.pack() → base64 编码`。非 `application/x-msgpack` 的响应（如 404 错误）不走此管线。

### Content-Type 解析器

```typescript
fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" },
    (_request, body, done) => {
        try { done(null, unpack(Buffer.from(body, "base64"))); }
        catch { jsonParser(_request, body, done); }  // 回退 JSON
    }
);
```

客户端请求经 `base64 解码 → msgpackr.unpack()` 还原为 JavaScript 对象。

---

## 九、CN 字段补全函数

`wrapOptionFields()` 位于 `src/routes/cn/load.ts`，在全球服 `getClientSerializedData()` 输出后补全 CN 特有字段。

### 类型转换

| 字段 | 原始类型 | 转换为 |
|------|---------|--------|
| `user_info.last_login_time` | Number (Unix) | `"YYYY-MM-DD HH:mm:ss"` |

### CN 配置字段（String）

| 字段 | 值 | 说明 |
|------|------|------|
| `cn_crash_url` | `"http://{IP}:8001/crash"` | 崩溃上报端点 |
| `survey_url` | `""` | 调查问卷 |
| `qq_group_url` | `""` | QQ 群入口 |
| `bug_report_url` | `""` | 反馈入口 |

### CN 配置字段（Boolean）

| 字段 | 值 | 说明 |
|------|------|------|
| `enable_gift` | `false` | 礼包入口 |
| `enable_customer_service` | `false` | 客服 |
| `enable_rename` | `true` | 改名 |
| `enable_delete_file` | `false` | 删除文件（调试功能） |
| `enable_newbie` | `true` | 新手引导 |
| `enable_little_assistant` | `false` | 小助手 |
| `mission_tips` | `false` | 任务提示 |
| `monthly_tip` | `false` | 月度提示 |
| `pass_force_reward` | `false` | 通行证强制奖励 |

### CN 数组字段

| 字段 | 值 | 说明 |
|------|------|------|
| `tower_dungeon_list` | `[]` | 塔活动 |
| `special_exchange_campaign_list` | `[]` | 特殊兑换 |
| `stars_gacha_campaign_list` | `[]` | 星辰抽卡 |
| `win_lottery_active_mission_list` | `[]` | 彩票任务 |
| `favorite_party_group_list` | `[]` | 收藏编队 |
| `ranking_event_reward` | `[]` | 排名奖励 |
| `crazy_gacha_result_list` | `[]` | 疯狂抽卡结果 |
| `last_crazy_gacha_draw_result` | `[]` | 最近抽卡结果 |
| `fund_receive_list` | `[]` | 基金领取 |
| `simple_payment_item_list` | `[]` | 支付列表 |
| `party_list` | `[]` | 队伍列表 |

### 补全的 user_info 字段

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `is_bought_fund_ex_quest` | `false` | 购买基金-EX 关卡 |
| `is_bought_fund_main_quest` | `false` | 购买基金-主线 |
| `is_bought_fund_laite` ~ `laite3` | `false` | 购买基金-莱特 1~3 |
| `is_newbie` | `true` | 新手标记 |
| `is_comeback` | `false` | 回归标记 |
| `month_card_remain_days` | `0` | 月卡剩余 |
| `weekly_bonus_remain_days` | `0` | 周奖励剩余 |
| `monthly_payment_total` | `0` | 月支付累计 |
| `renewal_gift_remain_days` | `0` | 续费礼包剩余 |

### 补全的 user_option 字段

| 字段 | 默认值 |
|------|--------|
| `episode_encyclopedia_suggest_show` | `false` |
| `server_push` | `false` |
| `stamina` | `false` |

### 嵌套对象字段

| 字段 | 结构 |
|------|------|
| `payment_rebate_info` | `{ expired_time: 0, status: 0, start_time: 0 }` |
| `monthly_charge_bonus_info` | `{ bonus_days: 0, expired_time: 0, init_time: 0, status: 0, start_time: 0 }` |
| `comeback_campaign_boss_boost` | `{ period_start_time: 0, period_end_time: 0 }` |
| `login_info` | `{}` |

---

## 十、stubMsgpackReply 函数

行内 stub 端点的统一响应辅助：

```typescript
function stubMsgpackReply(reply: any, data: any) {
    reply.header("content-type", "application/x-msgpack");
    reply.status(200).send({
        data_headers: {
            force_update: false, asset_update: false,
            short_udid: 0, viewer_id: 0,
            servertime: Math.floor(Date.now() / 1000),
            result_code: 1
        },
        data
    });
}
```

所有行内 stub（`custom_notify`, `contact_active`, `query_unfinish_order` 等）通过此函数返回统一的 `data_headers` + response data。

---

## 十一、EN vs CN API 关键差异

| 字段 | EN (global starpoint) | CN (starpoint-cn) | 影响 |
|------|:--:|:--:|------|
| `is_initial` | `true` | 未上报 `RES_VER` 时为 `true` | 决定全量或增量规划 |
| `client_asset_version` | 空 (undefined) | 客户端上报的 `RES_VER`，初始请求为空字符串 | 表示客户端已有版本 |
| `target_asset_version` | `availableAssetVersion` (metadata.json) | 进程固定 Content snapshot 的 `targetVersion` | Content Release/Catalog 为唯一权威 |
| `full.version` | `"2.1.0"` | `"1.4.0"` | CDN 基准版本 |
| `full.archive` | 预构建静态 JSON（357 条） | Catalog 固定归档清单 | CN 不在请求时扫描目录或自动发现 ZIP |
| SHA256 | 真实 SHA256 值 | Catalog 记录的 SHA256 | 两端均返回归档摘要 |
| `diff` | 始终 `[]` | Catalog 中从当前版本到目标版本的唯一可达路径 | CN 支持 Catalog 声明的 diff |
| `device_lang` header | 必需，否则 400 | 忽略 | EN 多语言支持 |

---

## 十二、CharacterTable orderedmap 二进制格式

CDN 中 `production/upload/93/35d17430d2d157ea5e2b573b6ba4f210232664` 包含 505 个角色的 CharacterTable 数据。

### 物理路径计算

```
hash = SHA1("master/character/character.orderedmap" + "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy")
path = "production/upload/" + hash[0:2] + "/" + hash[2:]
```

### 二进制结构

```
[4 bytes: 压缩后长度（大端）]
[zlib 压缩数据]
  → 解压 → [4 bytes: 条目数 (LE)]
            [条目数 × 8 bytes: { string_offset(u32), data_offset(u32) }]
            [键字符串区域: null-separated strings]
            [zlib-compressed CSV rows]
```

### 数据内容

每个 CSV 行对应 CharacterValues 的 37 列：
```
[0] string_id      [1] gacha_odds_weight  [2] rarity      [3] element
[4] race           [5] character_tag       [6] speciality   [7] gender
[8] action_skill   [9-16] skill_switching  [17-18] leader_ability
[19-24] abilities  [25] mana_board_kind    [26] stance      ...
[36] max_ability_powers
```

### Salt 验证

```
已知确认路径:
  ✅ "master/config/config.orderedmap" → CSV 中找到 (16 bytes)
  ✅ "story/.../movie.movie.amf3.deflate" → CSV 中找到 (6260 bytes)
  ✅ "master/character/character.orderedmap" → CSV 中找到 (72979 bytes)
```

Salt `K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy` 经 3/3 路径验证正确。

---

## 十三、wf-assets-cn 源数据

`wf-assets-cn/` 目录包含 CN CDN 构建前的原始 JSON 数据（571MB, 2115 个 orderedmap JSON 文件）。

```
wf-assets-cn/
├── VERSION                → "1.4.54"
├── .pathlist (7.5MB)      → 逻辑路径→物理文件映射
├── orderedmap/             → JSON 源数据
│   ├── character/          → 角色表（character.json 含 505 角色）
│   ├── gacha/              → 抽卡表
│   ├── ability/            → 技能表
│   ├── battle/             → 战斗数据
│   └── ...                 → 共 2115 个 .json 文件
└── assets/                 → 服务端 character.json 等
```

### 与 CDN 关系

```
wf-assets-cn (JSON) → 构建过程 → CDN (binary in ZIPs)
```

源数据包含所有 master 表。CDN 构建时应全部编译为二进制并放入 ZIP。当前 `cn_cdn.rar` 中的 `character/character.orderedmap` 数据完整（505 角色），确认构建过程正常。

## 三、行内 Stub 端点

直接在 `cn-server.ts` 中定义，替换全球服对应路由。

| 端点 | 用途 | 响应 data |
|------|------|----------|
| `assetintitle/version_info_in_title` | 标题界面 CDN 信息 | `{ base_url, files_list, total_size, delayed_assets_size }` |
| `tool/check_social_link_enable` | 社交功能开关 | `{ enable: false }` |
| `tool/contact_active` | 客服入口 | `{ enable_customer_service: false }` |
| `tool/custom_notify` | 在线通知系统 | `{}` |
| `channels/channel_leiting_pay/query_unfinish_order` | 雷霆支付未完成订单 | `{ order_id: "" }` |
| `tutorial/update_step` | 教程步骤（替代全球服） | `{ step: 1, start_time: N, mail_arrived: false }` |
| `tutorial/finish_trigger` | 教程完成触发器（替代全球服） | `[]` |

---

## 四、调试端点

| 端点 | 方法 | 用途 |
|------|:--:|------|
| `/debug` | GET/POST | 信标日志，参数 `loc` 记录到控制台 |
| `/crash` | POST | 客户端崩溃报告，body 打印到控制台 |

---

## 五、复用全球服 API

以下路由复用 `src/routes/api/`，prefix 均为 `/api/index.php`：

| 路由 | 文件 | 功能 |
|------|------|------|
| `reproduce` | reproduce.ts | 遥测/回放 |
| `gacha` | gacha.ts | 抽卡执行与交换 |
| `party` | party.ts | 队伍编辑 |
| `expod` | expod.ts | 经验值系统 |
| `story_quest` | storyQuest.ts | 剧情关卡 |
| `option` | option.ts | 游戏设置 |
| `single_battle_quest` | singleBattleQuest.ts | 单人战斗 |
| `multi_battle_quest` | multiBattleQuest.ts | 多人战斗 |
| `attention` | attention.ts | 协作匹配 |
| `character` | character.ts | 角色强化/突破/玛纳节点 |
| `party_group` | partyGroup.ts | 编队组管理 |
| `equipment` | equipment.ts | 装备系统 |
| `ex_boost` | exBoost.ts | EX 强化 |
| `box_gacha` | boxGacha.ts | 宝箱抽卡 |
| `shop` | shop.ts | 商店 |
| `encyclopedia` | encyclopedia.ts | 图鉴 |
| `mail` | mail.ts | 邮件系统 |
| `ranking_event` | rankingEvent.ts | 排名活动 |
| `mission` | mission.ts | 任务系统 |
| `payment` | payment.ts | 支付 |
| `news` | news.ts | 新闻/公告 |
| `event/raid` | raidEvent.ts | 讨伐活动 |
| `event/rush` | rushEvent.ts | Rush 活动 |

---

## 六、静态文件

| 路径 | 映射 | 说明 |
|------|------|------|
| `/patch/*` | `.cdn/` 目录 | CDN ZIP 资源服务 |

---

## 七、数据流

```
客户端 APK
  └─ /api/index.php/tool/signup     → 注册账号
  └─ /api/index.php/load            → 获取玩家数据
  └─ /api/index.php/asset/get_path  → CDN 下载清单
  └─ /patch/cn/archive-*/**.zip     → 下载 CDN ZIP
  └─ /api/index.php/tutorial/update_step → 教程进度
  └─ /api/index.php/channels/...    → 雷击 SDK stub
  └─ 游戏 API (gacha/party/quest...) → 核心游戏逻辑
```
