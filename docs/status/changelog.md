# 近期修改与发现
> 状态: 变更时间线   关键文件: -   相关端点: -

## 一、账号系统 (2026-06-08)

### 1.1 账号切换功能

**新增文件：**
- `src/data/activeAccount.ts` — 活跃账号状态管理，持久化到 `.database/active_account.json`
- ~~`src/data/accountNames.ts`~~ — 已删除（改名直接改 `players.name`）

**修改文件：**
- `src/routes/cn/tool.ts` — signup 支持活跃账号复用：查 `activeAccountId` → 存在则返回已有 viewer_id
- `src/data/wdfpData.ts` — 新增 `getAllAccountsSync`、`deleteAccountSync`，导出 `getAccountPlayersSync`、`updateAccountSync`
- `src/routes/web_api/server.ts` — 新增 6 个端点：`/accounts`、`/activeAccount`、`/activate`、`/deactivate`、`/renameAccount`、`/deleteAccount`
- `src/routes/web/index.ts` — 首页渲染账号列表 + 活跃状态
- `src/cn-server.ts` — URLSearchParams 表单解析回退（修复改名功能）

**功能：**
- 首号自动绑定：第一次建号后自动设为活跃账号
- Web 面板 `http://<LAN_IP>:8001/` 可切换/改名/删除账号
- 状态持久化，重启不丢失
- 改名直接修改 `players.name` 字段（游戏内显示名）

### 1.2 Session 创建

**问题：** signup 未创建 session → `/story_quest/finish`、`/gacha/exec` 返回 400

**修复：** `tool.ts` signup 中创建 `SessionType.VIEWER`（365天有效）

---

## 二、时间系统 (2026-06-09)

### 2.1 servertime 实时求值

**问题：** `generateDataHeaders` 在模块加载时求值 `servertime`，设自定义时间后 signup 等端点仍返回系统时间

**修复：** `utils.ts` 改为每次请求实时计算 `servertime`

### 2.2 stubMsgpackReply 时间硬编码

**问题：** `cn-server.ts` 的 `stubMsgpackReply` 硬编码 `servertime: Date.now()/1000` → 永远系统时间

**根因发现（关键）：** 客户端每收到一个带 `data_headers.servertime` 的响应，就会调用 `Clock.applyServerTime()`。如果新旧 servertime 日期不同 → `checkNewDay(old, new)` → `ClockInput.ChangeDate` → 弹"日期变了 返回标题"。

流程如下：
```
signup → servertime=2025 (getServerTime)     → applyServerTime → time=Some(2025)
/load  → servertime=2025 (getServerTime)     → checkNewDay(2025,2025) = same ✅
query_unfinish_order → servertime=2026 (Date.now) ← BUG!
  → applyServerTime(2026) → checkNewDay(2025,2026) = DIFFERENT → 弹框！
```

**修复：** `stubMsgpackReply` 改用 `getServerTime()`

### 2.3 客户端 Clock 信标

**新增文件：** `starview/scripts/beacons/clock_trace.py` — 注入 3 处时钟调试信标：
- `CLOCK:applyServerTime servertime=X` — 每次接收服务端时间
- `CLOCK:checkNewDay old=X new=Y` — 新旧时间对比（>1 行的时候触发弹框）
- `CLOCK:checkClockState stateIdx=X avail=Y` — 状态检查

**修改文件：**
- `starview/scripts/lib/env.sh` — 导出列表增加 `pinball.context.clock.Clock`
- `starview/scripts/steps/02-export-targets.sh` — 验证列表增加 Clock
- `starview/scripts/steps/03/03b-add-crash-util-import.sh` — import 注入增加 Clock

### 2.4 时间穿越方案

| 时间 | servertime（客户端收到） | dailyReset（服务端结算） |
|------|------------------------|------------------------|
| 不设自定义 | 系统时间 | 系统时间 |
| 设自定义 2025 | 2025（getServerTime） | 2025（getServerDate） |
| 弹框行为 | 时间变更时弹一次 | 之后再登录不弹 |

**正确流程：**
1. **先**设自定义时间
2. **再**清应用数据
3. 首次登录 → `time=2025` 存储
4. 后续登录 → `checkNewDay(2025, 2025)` → 不弹框

### 2.5 Web 面板时间功能

- 时间设置改为 `fetch` 提交（无跳转）
- URLSearchParams 表单解析回退

---

## 三、Tutorial 跳过

**问题：** 新玩家注册后弹出前置剧情（ShortPrologue）+ 教程弹框，然后黑屏

**根因：** `user_tutorial: { tutorial_step: 0 }` → 客户端认为教程未完成 → 弹前置剧情。教程端点 stub 不持久化进度。

**修复：** `wdfpData.ts` 默认 `triggeredTutorial = [12]` → `find(12) !== undefined` → `user_tutorial = null`（教程已完成）

---

## 四、默认角色

| 字段 | 值 | 说明 |
|------|-----|------|
| 默认角色 | k_id=2 → code=10（小白 white_tiger） | 1级, exp=10, mana_board=1 |
| 默认队伍 | [2, null, null] → [10, null, null] | 6组×10队 |
| 队长 | 2 → code=10 | |
| 星导石 | 150 | 够1抽 |
| mana | 1000 | |

---

## 五、TCP/IP 别名

**问题：** Mac DHCP 换 IP 后 APK 连不上 `<LAN_IP>`

**修复：** `sudo ifconfig en0 alias <LAN_IP> 255.255.255.0`（重启后失效）

---

## 六、时间偏移持久化 (2026-06-09)

### 6.1 设计

**改前：** `serverTime: Date | null` — 绝对时间，重启后丢失。

**改后：** `timeOffset: number | null` — 偏移量（毫秒），持久化到 `active_account.json`。

### 6.2 原理

```
设时间 2025-06-01T00:00:00（真实时间 2026-06-09）
  → offset = 1748736000000 - Date.now()  ≈ -373 天
  → 保存到 active_account.json

每次 getServerTime() = Date.now() + offset
  → 模拟时间随真实时间自然流逝

服务关闭 N 天后重启:
  → 读 offset → setServerTimeOffset(offset)
  → 模拟时间 = 重启时的真实时间 + offset（自动包含离线流逝）
```

### 6.3 核心改动

| 文件 | 改动 |
|------|------|
| `src/utils.ts` | `serverTime` → `timeOffset`；`getServerTime()` 无参返回 `Date.now()+offset`，有参返回 date 自身 epoch；新增 `setServerTimeOffset`/`getTimeOffset` |
| `src/data/activeAccount.ts` | `active_account.json` 增加 `timeOffset`/`lastSetTime` 字段；新增 `saveTimeOffset`/`restoreTimeOffset` |
| `src/cn-server.ts` | 启动时调用 `restoreTimeOffset()` |
| `src/routes/web_api/server.ts` | 设时间/重置时调用 `saveTimeOffset()` |

### 6.4 验证结果

```
设时间:        2025-06-01T00:00:00.002Z
等 10s 后:     2025-06-01T00:00:10.151Z  ← 流逝 10 秒 ✅
重启后:        2025-06-01T00:00:23.698Z  ← 自动恢复 + 继续流逝 ✅
启动日志:      startup restore offset=-32259698531 ← 从文件恢复 ✅
```

### 6.5 active_account.json 格式

```json
{
  "activeAccountId": 2,
  "timeOffset": -32259698531,
  "lastSetTime": "2025-06-01T00:00:00.001Z"
}
```

---

## 七、安全时间范围 (2026-06-09)

### 7.1 数据版本对照

| 数据源 | 最早有效时间 | 最晚有效时间 |
|--------|:-----------:|:-----------:|
| CN gacha.json（584 卡池） | 2020-01-27 | 2025-08-14 |
| 全球 gacha.json（224 卡池） | 2018-10-03 | 2025-01-31 |
| CDN 数据 (v1.4.0→1.4.54) | ≈2022-03 | ≈2024 末 |
| APK 编译时间 (v1.8.1) | — | 2025-06-05 |

### 7.2 安全范围

```
模拟时间: 2022-06 ~ 2025-08
推荐区间: 2023 ~ 2024（卡池最密集、事件最丰富）
```

### 7.3 超出范围的后果

| 时间 | 现象 | 原因 |
|------|------|------|
| 早于 2022 | 进不去游戏 / C8601 / F1009 | CDN 版本不匹配，数据表缺失 |
| 设到 2021 年 | 角色/卡池/活动数据全部缺失 | CDN v1.4.0 之前无数据 |
| 晚于 2025-08 | 卡池全部过期，无法抽卡 | gacha.json 最后结束日之后 |

### 7.4 手动测试方法

```bash
# 1. 设时间（2023-2024 区间安全）
curl "http://<LAN_IP>:8001/api/server/time?time=2024-06-01"

# 2. 清应用数据 + 进游戏

# 3. 看日志确认无 C8601/C2032/F1009 等关键错误

# 4. 逐步往更早时间调整，直到出现报错 → 确定边界
```

---

## 八、抽卡系统分析 (2026-06-09)

### 8.1 问题

客户端请求 `POST /api/index.php/gacha/exec`，发送 gacha_id=1700。服务端返回 HTTP 400。

**日志确认：** `[GACHA] Gacha not found: gachaId=1700`

### 8.2 数据源对比

| 数据 | 文件 | 数量 | 格式 | pool 数据 |
|------|------|:--:|------|:--:|
| 全球 gacha.json | `starpoint-cn/assets/gacha.json` | 224 卡池 | JSON 对象，pool 嵌入 | ✅ 有 |
| CN gacha.json | `wf-assets-cn/orderedmap/gacha/gacha.json` | 584 卡池 | JSON 数组，pool 引用外部文件 | ❌ 无 |

### 8.3 关键差异

| 项目 | 全球 gacha | CN gacha |
|------|-----------|----------|
| ID 范围 | 1~5038 | 1~900003，含 1700 等高编号 |
| 日期范围 | 2018-10 ~ 2025-01-31 | 2020-01 ~ 2025-08-14 |
| pool 数据 | 直接嵌入 banner 中 | 引用 `new_character_pickup_*` 等外部表 |
| 2025-06 数据 | 无 | 有（CN 停服前最后卡池） |

### 8.4 gacha_id=1700 元数据

| CN 索引 | 值 | 对应字段 |
|:-------:|-----|---------|
| [1] | 新角色特选扭蛋 | 名称 |
| [9] | 1（角色） | `type` |
| [5] | 150 | `singleCost` |
| [6] | 1500 | `multiCost` |
| [7] | 50 | `discountCost` |
| [17] | normal | `movieName` |
| [18] | normal_guarantee | `guaranteeMovieName` |
| [29] | 2025-06-05 12:00:00 | `startDate` |
| [30] | 2025-06-19 11:59:59 | `endDate` |
| [14-16] | `new_character_pickup_99_character_3/4/5` | pool 引用（数据缺失） |

### 8.5 pool 条目结构（全球 gacha 示例）

```json
{ "id": 311001, "rank": 3, "odds": 1, "isRateUp": false, "rarity": 20.41 }
```

| 字段 | 含义 |
|------|------|
| `id` | 角色 business code（6 位数字） |
| `rank` | 稀有度（1=★5，2=★4，3=★3） |
| `odds` | 抽选权重 |
| `isRateUp` | 是否 UP |
| `rarity` | 对应概率（movie seed 用） |

### 8.6 CN pool 数据缺失原因

CN gacha.json 中的 pool 引用指向编辑进 SWF ActionScript 的静态表，不在 CDN dump 文件中。CN 服务端停服后无法获取。

### 8.7 交叉验证：全球池 vs CN 角色

**全球 ID=184（280 角色）vs CN codeMap（449 角色）：**

| 指标 | 数值 |
|------|:--:|
| 全球 pool 角色 | 280 |
| 在 CN codeMap 中 | 270（96.4%） |
| 不在 codeMap 中 | 10（CN codeMap 未收录的后期角色） |
| CN 角色不在全球 gacha | 58（教程角色/剧情赠送/装备 code，本不应在 gacha） |

**准确率 96%，足够使用。**

### 8.8 重建方案与 odds 计算

#### Sheet 结构

| Sheet 名 | 列 | 说明 |
|----------|-----|------|
| 常驻池 | k_id, code, 稀有度 | 基础常驻角色，始终在池中 |
| 2024-01 | k_id, code, 稀有度, 常驻/限定, UP(单/双/三/四) | 该时期新增 + UP 角色 |
| 2024-02 | 同上 | ... |
| 2025-06 | 同上 | 对应 gacha_id=1700 |

#### 常驻累积规则

后期卡池 = 常驻池 Sheet + 所有 ≤ 卡池日期的 Sheet 中"常驻"标记角色 + 当期"限定" + UP。

#### 8.8.1 基础概率

| 抽取类型 | ★5 | ★4 | ★3 |
|---------|:--:|:--:|:--:|
| 普通单抽 | 7.5% (75/1000) | 25% (250/1000) | 67.5% (675/1000) |
| 十连保底 | 7.5% (75/1000) | 92.5% (925/1000) | — |

这些值与全球服 `lib/gacha.ts` 中的 `GachaRankRates` 完全一致，不需要修改。

#### 8.8.2 UP 概率与占比

| UP 类型 | 目标概率 | ★5 中占比 | 公式 |
|:------:|:------:|:---------:|------|
| 单 UP | 1.5% | 20% | 1.5% ÷ 7.5% |
| 双 UP | 各 1.0% | 各 13.3% | 1.0% ÷ 7.5% |
| 三 UP | 各 0.7% | 各 9.3% | 0.7% ÷ 7.5% |
| 四 UP | 各 0.5% | 各 6.7% | 0.5% ÷ 7.5% |

#### 8.8.3 odds 计算公式

```
设 ★5 池共 N 个角色，其中 K 个 UP，其余 N-K 个常驻 (odds=1)

odds_UP 满足:
  odds_UP / (odds_UP × K + (N-K) × 1) = UP占比

解出:
  odds_UP = (N-K) × 占比 / (1 - 占比 × K)
```

**单 UP 示例（N=111, K=1, 占比=20%）：**

```
odds_UP = (111-1) × 0.2 / (1 - 0.2 × 1)
        = 110 × 0.2 / 0.8
        = 27.5 → 取整 28

验证: 28 / (28 + 110) = 20.29% ≈ 20% ✅
```

**双 UP 示例（N=111, K=2, 各占比=13.3%）：**

```
odds_UP = (111-2) × 0.133 / (1 - 0.133 × 2)
        = 109 × 0.133 / 0.734
        = 19.8 → 取整 20

验证: 20 / (20+20+109) = 13.4% ≈ 13.3% ✅
```

#### 8.8.4 odds 速查表

| UP 类型 | odds (N≈111) | odds (N≈50) | odds (N≈200) |
|:------:|:----------:|:---------:|:----------:|
| 单 UP | 28 | 12 | 50 |
| 双 UP | 20 | 9 | 36 |
| 三 UP | 14 | 7 | 27 |
| 四 UP | 10 | 5 | 20 |
| 常驻 | 1 | 1 | 1 |

脚本会根据实际池大小（N）自动计算精确 odds，上表仅供参考。

#### 8.8.5 实际抽卡概率验证

**十连抽单 UP（odds=28, N=111）：**

```
单抽出 ★5:   75/1000 = 7.5%
★5 出 UP:    28/(28+110) = 20.29%
单抽出 UP:   7.5% × 20.29% = 1.522%

10 至少 1 UP: 1 - (1-0.01522)^10 = 14.23%
100 至少 1 UP: 78.4%
300 (井):     98.9%
```

**与官方公布一致（1.5% 单抽）。**

#### 8.8.6 Sheet 到 pool 的完整流程

```
用户 Sheet 输入:
  常驻池 Sheet:  k_id, code, ★
  日期 Sheet:    k_id, code, ★, 常驻/限定, UP(单/双/三/四)

脚本处理:
  1. 读取所有 Sheet → 按日期排序
  2. 遍历 CN gacha.json（584 卡池）:
     a. 取卡池日期 → 匹配最近的日期 Sheet
     b. pool = 常驻池（所有字符 odds=1）
     c. + 所有 ≤ 当前日期 Sheet 中标记"常驻"的角色（odds=1）
     d. + 当前日期 Sheet 中标记"限定"的角色（odds=1）
     e. + 当前日期 Sheet 中 UP 角色（isRateUp=true, odds=公式计算）
     f. 按稀有度分组（rank=1/2/3）
  3. 写入 assets/gacha.json（完整 584 卡池）
```

**产出：** 客户端请求任何 CN gacha_id → 服务端直接命中 ✅

### 8.9 月卡端点

`Pass_card/get_pass_card` — 国服独有。已 stub。

| 端点 | 状态 |
|------|:--:|
| `/Pass_card/get_pass_card` | ✅ 已 stub |
| `/gacha/exchange_character` | ✅ 正常 |
| `/gacha/exchange_equipment` | ✅ 正常 |
| `/gacha/exec` | ⏳ 等 Sheet 数据到位 |

### 8.10 未映射角色清单

codeMap 覆盖 k_id 1~449（449 个角色）。CDN CharacterTable 共 505 个角色，剩余 56 个 code 无映射。

#### 需分配 k_id 的角色（35 个）

通过 CN `gacha_feature_content.json` 追踪每个 code 最早出现的卡池，得到引入日期。按日期排序：

| code | ★ | 引入日期 | CN gacha | 说明 |
|------|:--:|------|:--:|------|
| 121153 | 5 | 2023-03-31 | 167 | |
| 131152 | 5 | 2023-03-31 | 167 | |
| 141165 | 5 | 2023-03-31 | 167 | |
| 151159 | 5 | 2023-04-14 | 170 | |
| 261089 | 4 | 2023-04-14 | 170 | |
| 111159 | 5 | 2023-04-28 | 173 | |
| 131158 | 5 | 2023-04-28 | 173 | |
| 141171 | 5 | 2023-04-28 | 173 | |
| 121159 | 5 | 2023-05-15 | 176 | |
| 111165 | 5 | 2023-05-31 | 179 | |
| 151165 | 5 | 2023-05-31 | 179 | |
| 161177 | 5 | 2023-05-31 | 179 | |
| 161183 | 5 | 2023-06-16 | 181 | |
| 161189 | 5 | 2023-06-16 | 181 | |
| 121165 | 5 | 2023-06-30 | 184 | |
| 151171 | 5 | 2023-06-30 | 184 | |
| 111171 | 5 | 2023-07-14 | 187 | |
| 121171 | 5 | 2023-07-14 | 187 | |
| 131164 | 5 | 2023-07-31 | 190 | |
| 141177 | 5 | 2023-07-31 | 190 | |
| 161195 | 5 | 2023-08-14 | 193 | |
| 121177 | 5 | **2023-08-31** | 196 | ⬅ 基准时间 |
| 131170 | 5 | **2023-08-31** | 196 | |
| 141183 | 5 | **2023-08-31** | 196 | |
| 121183 | 5 | 2023-09-14 | 198 | |
| 111177 | 5 | 2023-09-29 | 200 | |
| 131176 | 5 | 2023-09-29 | 200 | |
| 141189 | 5 | 2023-10-13 | 202 | |
| 121189 | 5 | 2023-10-31 | 206 | |
| 111183 | 5 | 2023-11-14 | 209 | |
| 141201 | 5 | 2023-11-30 | 212 | |
| 151182 | 5 | 2023-11-30 | 212 | |
| 161201 | 5 | 2023-11-30 | 212 | |
| 131182 | 5 | **未找到** | — | |
| 153001 | ? | **未找到** | — | |

相对于基准时间 2023-08-31：
- ≤ 基准日：22 个（在常驻池 Sheet 中）
- > 基准日：11 个（在对应日期 Sheet 中）
- 未找到：2 个（131182、153001，可能非 gacha 角色）

#### 特殊角色（21 个，不分配 k_id）

| code | 数量 | 推测用途 |
|------|:--:|------|
| 700000~700019 | 20 | Come Back 奖励 / NPC |
| 999999 | 1 | 测试占位 |

#### k_id 分配方案

```
现有 codeMap: k_id 1~449（449 个）
需新增:       k_id 450~483（34 个）
待确认:       k_id 484~485（2 个未找到角色）

建议按引入日期升序分配：最早引入的角色 → k_id=450，依此类推。
```

### 8.11 数据提取尝试过程

**目标：** 从 CN SWF 或 CDN 中提取 `GachaOddsTable`（角色池）和 `EquipmentGachaOddsTable`（装备池）的完整数据。

| 方法 | 结果 | 原因 |
|------|:--:|------|
| CDN ZIP SHA1 寻址 | ❌ | 算出的 hash 在 459 个 ZIP 中不存在 |
| 扫描 CDN ZIP 内 orderedmap | ❌ | 数万文件，0 个匹配 orderedmap 格式 |
| 手机 ADB 提取 | ❌ | Leiting 私有加密格式，无法解密 |
| SWF XML (482MB) | ❌ | 数据在 ABC 常量池，不可读 |
| wf-assets-cn orderedmap | ❌ | 未提取这两张表 |
| 全球 gacha 模板 | ✅ | 交叉验证 87-96% 准确率 |

**结论：** GachaOddsTable 数据客观存在于 CN SWF 中，但当前工具链无法提取。需要通过组合其他数据源重建。

### 8.12 最终重建方案：三源合并

**数据来源：**

| 数据源 | 提供内容 | 说明 |
|--------|---------|------|
| CN `gacha.json` | 584 卡池元数据 | ID、名称、日期、价格、类型 |
| CN `gacha_feature_content.json` | UP 角色标记 | 543 个卡池共 3489 次引用，338 个去重角色 |
| 全球 `gacha.json` | 常驻池角色 | 95 个从未 UP 过的常驻角色（odds=1） |

**生成脚本：** `starpoint-cn/scripts/generate_gacha.py`

```bash
python3 scripts/generate_gacha.py  # 生成 assets/gacha.json
```

**流程：**
```
常驻池 (95 角色, odds=1)
  + feature_content UP 角色 (按 UP 数量自动计算 odds: 单28/双20/三14/四10)
  + CN gacha.json 元数据 (日期/价格/类型)
  → 584 卡池完整 gacha.json
```

**验证结果：**

| 之前缺失的 gacha_id | 角色数 | UP | cost | 状态 |
|:--:|:--:|:--:|:--:|:--:|
| 1700 | 96 | 1 | 150 | ✅ |
| 196 | 98 | 3 | 150 | ✅ |
| 1580 | 98 | 3 | 150 | ✅ |
| 1581 | 99 | 4 | 150 | ✅ |

### 8.13 未入常驻池角色

通过交叉验证 CN CharacterTable (505) vs 全球 gacha pool vs feature_content，确认**全部 4 种不进入常驻池的角色**：

| 类别 | 数量 | 示例 | 原因 |
|------|:--:|------|------|
| 装备 codes | 12 | 412004, 512001 | 装备池数据，不在角色池 |
| 剧情/活动赠送 | 27 | 213001, 223001... | 关卡/任务奖励，非 gacha 获取 |
| 教程角色 | 2 | code=1(Alk), code=10(小白) | 教程初始角色 |
| 特殊角色 | 12 | 113001(商店), 131182(试玩) | 其他渠道获取 |
| **常驻池总计** | **95** | — | 从全球 gacha 提取 |

其中 131182(莱特) 是 4 周年试玩关卡角色，153001(凪原直) 是主线解锁角色，均不在 gacha 流程内。

### 8.14 Gacha 端点状态

| 端点 | 状态 |
|------|:--:|
| `/gacha/exec` | ✅ 584 卡池全部命中 |
| `/gacha/exchange_character` | ✅ 正常 |
| `/gacha/exchange_equipment` | ✅ 正常 |
| `/Pass_card/get_pass_card`（月卡） | ✅ 已 stub |

### 8.15 装备池修复 (2026-06-09)

#### 8.15.1 问题

CN gacha 中装备池和角色池混编（全部 type=1），全球 gacha 中装备池有独立 type=1 但只有 40 个卡池。

#### 8.15.2 装备池识别

| 判据 | 匹配数 | 示例 ID |
|------|:--:|------|
| 全球装备 ID 直接匹配 | 40 | 3, 5000~5038 |
| CN 名称关键词（装备/武器/武具） | 91 | 25025~25043 |

去重后共 **91 个装备池**。

#### 8.15.3 CN 装备池数据来源

**手动整理的 68 件 gacha 装备**（来自 384 条全量装备来源标注）：

| 稀有度 | code 前缀 | 数量 | 来源 |
|:--:|------|:--:|------|
| ★5 | 5xxxxx | 15 | 装备池 |
| ★4 | 4xxxxx | 24 | 装备池 |
| ★3 | 3xxxxx | 29 | 装备池 |

**稀有度判定规则：装备 code 首位 = gacha 稀有度**（与角色池一致）。

```
5xxxxx → ★5, 4xxxxx → ★4, 3xxxxx → ★3
```

验证：全球 gacha 装备池 pool["1"] 的 item 全部以 5 开头 ✅。

#### 8.15.4 非 gacha 装备（不在装备池中）

| 来源 | 数量 | 说明 |
|------|:--:|------|
| 主线 + EX | ~20 | 章节通关/关卡奖励 |
| 领主/降临讨伐 | ~100 | BOSS 掉落/商店兑换 |
| 活动 | ~100 | 活动奖励/扭蛋 BOX |
| 交易所/星粒商店 | ~50 | 兑换 |
| 土俑嘉年华 | 21 | 活动商店 |
| 练习场/临境域 | ~20 | 挑战奖励 |
| CDN 中未找到 | 11 | 名称不匹配（可能 CN 独占名称） |

#### 8.15.5 装备池数据格式

```json
{
  "type": 1,
  "singleCost": 75,
  "multiCost": 750,
  "pool": {
    "1": [ ★5 共 15 件: { "id": 5010028, "rank": 5, "odds": 1 } ],
    "2": [ ★4 共 24 件: { "id": 4010010, "rank": 4, "odds": 1 } ],
    "3": [ ★3 共 29 件: { "id": 3010007, "rank": 3, "odds": 1 } ]
  }
}
```

池结构 key 含义：`1`=★5, `2`=★4, `3`=★3（pool 索引 + 1）。

#### 8.15.6 生成脚本

`scripts/generate_gacha.py` 中 CN 装备池数据硬编码为 `cn_eq_pool`，自动应用到所有检测为装备池的 CN gacha banner。

---

## 九、CDN 时间基准 (2026-06-09)

### 9.1 发现过程

测试时在 2024-03-21 ~ 2024-04-03 时间段进入抽卡界面报 C2032。gacha_id=1615 的 feature_content 图片在 CDN dump 中缺失。

```
CN gacha 1615: 2024-03-21 ~ 2024-04-03 新角色特选扭蛋（联动卡池）
周边 ID 1613~1618 唯独缺 1615 的图片资源
```

### 9.2 原因

联动活动下线后资源被清理 → CDN dump 时已不存在 → 出现随机数据空洞。

### 9.3 CDN 起点推断

CDN v1.4.0 约对应 2022 年上半年（纯编译版本号，无日期标注）。无法精确确定起始时间，通过手动测试定位安全边界。

| 测试时间 | 结果 |
|---------|:--:|
| 2021-11 | ❌ 进不去（缺基础资源） |
| 2023-08 | ✅ 正常 |
| 2024-03 | ⚠️ 联动空洞 |

### 9.4 基准时间

**最终选择：2023-08-31 12:00:00**

| 考量 | 说明 |
|------|------|
| 避开联动空洞 | 2023-08 之前的联动资源相对完整 |
| 功能界面可用 | 文字翻译、图片引用等较少日版残留 |
| 角色数据充裕 | 2023-08 已积累大量常驻/限定角色 |

### 9.5 已知数据空洞

| gacha_id | 日期 | 问题 |
|:--:|------|------|
| 1615 | 2024-03-21 ~ 04-03 | 联动卡池，feature_content 图片缺失 |

## TODO

| 优先级 | 任务 | 状态 |
|:------:|------|:----:|
| 🔴 最高 | **装备池修复** — 用户手动整理 68 件 CN gacha 装备，91 个装备池全量覆盖 | ✅ 已修复 |
| 🟡 中 | Web 面板存档详情查看/编辑 | 待做 |
| 🟡 中 | 千里眼功能（docs/千里眼.xlsx → Web 页面/API） | 待做 |
| 🟡 中 | 16 个 stub 端点补充实现（mail/mission/payment/multi_battle） | 待做 |
| 🟡 中 | `tutorialApiPlugin` 注册（替换 inline stubs） | 待做 |

---

## 十、卡池模板迁移 (2026-06-10)

### 10.1 原因

之前用全球模板（ID=155, 363 个角色含限定）作为常驻池，现在改为用户手写 `character_table.json`（271 常驻），池更精准。

### 10.2 character_table.json 分类修正

| 分类 | 修改前 | 修改后 |
|------|:----:|:----:|
| 常驻卡池 | 284 | **271** |
| 限定卡池 | 121 | **117** |
| 主线/副本/活动赠送 | 30 | **43** |
| 联动 | 16 | **16** |
| 教程/初始角色 | 0 | **2** |

**移动清单：**

- `1`(男主), `243001`(亚里沙) → 教程/初始角色
- `10`(小白), `141003`(丛云), `222001`(水兵), `231005`(老猫), `251001`(歌姬), `261001`(阿鲁姆), `263001`(丽人), `263002`(太母), `311003`(火牛仔) → 主线/副本/活动赠送
- `223001`(泳船), `243013`(蛋白), `263003`(山田) → 商店获取 → 主线/副本/活动赠送
- `253013`(女主) → 主线剧情获取 → 主线/副本/活动赠送

### 10.3 generate_gacha.py 改造

**之前：** `git show HEAD:assets/gacha.json` 取全球最大卡池作为池模板
**之后：** 读 `data/character_table.json`，`source='常驻卡池'` 作为池模板

**产出：** 584 个卡池横幅，常驻池 271 角色（★5=104 / ★4=94 / ★3=73）

### 10.4 默认角色 & 队伍更新

- `wdfpData.ts` — 默认角色加 `243001`(亚里沙)，默认队伍 `[1, 243001, null]`
- 原有 `1`(男主) 保留，做教程兼容

---

## 十一、抽卡概率修正 (2026-06-10)

### 11.1 角色 ★5 概率 7.5% → 5%

**文件：** `src/lib/gacha.ts`

| 模式 | 修改前 | 修改后 |
|------|:--:|:--:|
| 普通角色 | `[75,250,675]` → 7.5% | `[50,250,700]` → 5.0% |
| 十连保底 | `[75,925]` → 7.5% | `[50,950]` → 5.0% |

- 删除 `rateUpCharacterGachaRates`（与修正后完全相同）
- 简化 `drawGachaSync`，不再根据 `movieName` 切换概率
- 装备扭蛋不变（原本就是 5%）

### 11.2 UP 公式修正（per-tier 独立计算）

**Bug：** 所有 UP 角色共用一个 `up_odds`（基于 ★5 池大小计算），导致 ★4 UP 概率爆炸（6.78%）且 UP 总数≥5 时归零。

**修改：** `scripts/generate_gacha.py` — 每个星级独立计算 odds

```python
up_targets = {
    '1': {1: 0.30, 2: 0.20, 3: 0.14, 4: 0.10},  # ★5
    '2': {1: 0.10, 2: 0.08},                       # ★4
}
```

- 各星级用各自的 `pool_template[pk]` 大小 + 各自 target 计算 odds
- ★3 无 rate-up，UP 角色 odds=1（与普通角色一致）
- UP 总数不受 {1..4} 字典限制，≥5 的混合卡池正常运作

### 11.3 最终概率表

**星级概率：**

| 星级 | 角色 | 武器 |
|------|:--:|:--:|
| ★5 | 5.0% | 5.0% |
| ★4 | 25.0% | 25.0% |
| ★3 | 70.0% | 70.0% |

**UP 全局概率（角色）：**

| UP 数 | ★5 每 UP | ★4 每 UP |
|:--:|------|------|
| 单 | 1.5% | 2.5% |
| 双 | 1.0% | 2.0% |
| 三 | 0.7% | — |
| 四 | 0.5% | — |

- 十连保底：每第 10 抽消灭 ★3，★5/★4 概率不变
- 天井：250 点交换
- 装备扭蛋：无 UP 机制 

---

## 十二、功能补全 (2026-06-10)

### 12.1 教程系统

**完整的教程流程已注册并修复：**

| 端点 | 功能 |
|------|------|
| `POST /tutorial/update_step` | 推进教程步骤：保存名字、step=15 触发十连（8选1★4）、step=16 送1500珠+243001亚里沙 |
| `POST /tutorial/finish_trigger` | 标记教程完成（`triggeredTutorial=[12]`）、含去重检查 |

**数据流：**
```
signup → tutorialStep=0, triggeredTutorial=[] → 触发教程
  ↓ step 1~14
update_step → 保存名字/跳过标记
  ↓ step 15
教程十连 → 从 [251001~251008] 8个★4随机选1 → rewardPlayerGachaDrawResultSync → 扣150珠
  ↓ step 16
givePlayerCharacterSync(243001) → 直接送角色 + 发500珠邮件 → mail_arrived=true
  ↓ finish_trigger
insert triggeredTutorial=[12] → 以后 /load 时 user_tutorial=null → 跳过教程
```

**关键细节：**
- `wdfpData.ts` 默认 `triggeredTutorial=[]`（新号触发教程，旧为 `[12]` 直接跳过）
- 默认角色不含 243001（只有男主 1），教程 step=16 发放
- 教程 step=15 十连不是真抽卡，是固定 8 人物池随机选
- 账号去重：`update_step` 检测 `triggeredTutorial` 含 12 则拒绝

### 12.2 公告系统

**文件：** `assets/news.json`（数据源）+ `routes/api/news.ts`

| 端点 | 功能 |
|------|------|
| `POST /news/index` | 分页公告列表（默认 3 条中文公告） |
| `POST /news/get_info` | 单条公告详情（含 HTML） |
| `POST /news/system_index` | 系统公告列表（空） |
| `POST /news/get_system_info` | 系统公告详情（空） |
| `POST /news/latest_forced` | 强制弹窗公告（空，无强制） |
| `POST /news/latest_forced_system` | 系统强制弹窗（空） |

**响应格式（从 CN 客户端反编译确认）：**

```json
// /news/index 响应
{
  "current_page": 1,
  "news": [{ "id", "title", "date", "html", "label", "thumbnail", "thumbnail_path", "added_time" }],
  "news_count": 3
}

// /news/get_info 响应
{ "id", "title", "date", "html", "label", "thumbnail", "thumbnail_path", "added_time" }
```

**编辑方式：** 直接修改 `assets/news.json`，无需重启。

### 12.3 邮件系统

**数据库：** `players_mails` 表、CRUD 函数在 `wdfpData.ts`

| 端点 | 功能 |
|------|------|
| `POST /mail/index` | 分页邮件列表（100 条/页），返回 `mail[]` + `total_count` |
| `POST /mail/receive` | 领取单封邮件 → 发奖 → 标记已领取 → 返回 `character_list/equipment_list/item_list/user_info` |
| `POST /mail/receive_all` | 批量领取 → 返回 `mail_ids/ex_boost_item_list/total_count` |

**支持的附件类型（MailType 枚举）：**

| type | 名称 | 需要 type_id | 说明 |
|:--:|------|:--:|------|
| 1 | 道具 | ✅ | `type_id` = 道具 ID |
| 3 | 付费珠 | ❌ | `number` = 数量 |
| 4 | 免费珠 | ❌ | `number` = 数量 |
| 5 | 角色 | ✅ | `type_id` = 角色 code |
| 6 | 装备 | ✅ | `type_id` = 装备 ID |
| 7 | 星碎 | ❌ | `number` = 数量 |
| 8 | 法力 | ❌ | `number` = 数量 |
| 9 | 经验池 | ❌ | `number` = 经验 |
| 10 | 羁绊证 | ❌ | `number` = 数量 |
| 11 | Boss Boost | ❌ | `number` = 点数 |
| 12 | Boost 点 | ❌ | `number` = 点数 |
| 15 | Rank 点 | ❌ | `number` = 经验 |

**`mail_arrived` 动态计算：** `utils.ts` 序列化时调用 `getPlayerMailCountSync(playerId, true)`，有未读邮件时返回 `true`。

**Web 管理面板：** `/mail` 页面，可视化发送邮件，附带附件类型说明表。

### 12.4 修行之道（PassCard）

**端点：**

| 端点 | 功能 |
|------|------|
| `POST /Pass_card/get_pass_card` | 获取当前赛季通行证数据 |
| `POST /Pass_card/receive_all` | 一键领取所有可领奖励 |

**响应格式：**
```json
// get_pass_card
{ "point": 0, "is_buy": false, "all_received_record": [] }

// receive_all
{ "all_received_record": [
    { "reward_id": int, "is_received_1": 0|1, "is_received_2": 0|1 }
  ]
}
```

**当前状态：** MVP stub，point=0、未购买、无奖励记录。通行证页面正常打开，按钮 3 显示「购买通行证」。后续可通过加载 `pass_card_reward.json`（21662 条）实现完整奖励发放。

### 12.5 Web 管理面板新增

| 功能 | URL | 说明 |
|------|------|------|
| 发送邮件 | `/mail` | 可视化群发邮件，12 种附件类型，表单直接提交 |
| 新建存档 | `POST /api/server/newAccount` | 一键创建初始存档（150 珠+男主） |
| 账号切换 | `POST /api/index.php/tool/check_enable_gift` | 按顺序循环切换存档 ⚠️ 待修复 |

### 12.6 端点注册总结

| 系统 | 已实现 | stub | 总计 |
|------|:--:|:--:|:--:|
| 教程 | 2 | 0 | 2 |
| 公告 | 6 | 0 | 6 |
| 邮件 | 3 | 0 | 3 |
| 个人资料 | 5 | 0 | 5 |
| 漫画 | 2 | 0 | 2 |
| 领取记录 | 1 | 0 | 1 |
| 通行证 | 0 | 2 | 2 |
| 其他游戏功能 | 38 | 6 | 44 |
| Web 面板 | 13 | 0 | 13 |
| 管理 API | 12 | 0 | 12 |
| **总计** | **82** | **8** | **90** |

### 12.7 个人资料与领取记录 (2026-06-10)

**个人资料端点（`routes/api/profile.ts`）：**

| 端点 | 功能 |
|------|------|
| `POST /profile/get_my_profile` | 个人资料主页（角色数/称号/编队数据） |
| `POST /profile/get_last_login_region` | 上次登录地区 `"CN"` |
| `POST /profile/get_degree_list` | 拥有称号列表 |
| `POST /profile/update_profile_settings` | 资料可见性设置 |
| `POST /profile/update_comment` | 修改留言（写 DB） |
| `POST /profile/rename` | 改名（写 DB） |

**领取记录（`routes/api/history.ts`）：**

| 端点 | 功能 |
|------|------|
| `POST /history/receive` | 近 7 天内最近 500 条领取记录 |

**数据来源：** `players_receive_history` 表，所有发奖点自动打日志：
- 教程十连 + 教程奖励（角色/珠子）
- 扭蛋抽取 + 兑换（角色/装备）
- 邮件领取（全部 12 种附件类型）

**关于 `check_enable_gift`：** 之前误标为切换账户功能，实际是**礼包码兑换**入口（`enable_gift: true` 亮起按钮，兑换逻辑待实现）。

### 12.8 漫画系统 (2026-06-10)

**端点（`routes/api/comic.ts`）：**

| 端点 | 功能 |
|------|------|
| `POST /comic/get_list` | 分页漫画列表（kind=0 弹射小世界 409 集，kind=1 史黛拉小课堂 13 集） |
| `GET /comic/image?kind=&episode=&size=` | 漫画图片服务（三档尺寸） |

**图片规格（针对 3200×1440 设备调优）：**

| size | 用途 | 处理 | 尺寸 |
|------|------|------|------|
| main（无参数） | 详情页全图 | PNG，高度 ≤ 2048（GPU 纹理限制） | 等比缩放 |
| `size=l` | 列表头图 | JPEG，顶部裁剪 | 984×623 |
| `size=s` | 3×3 磁贴网格 | JPEG，顶部裁剪 | 298×256 |

> ⚠️ **屏幕适配警告**：当前尺寸针对 **3200×1440**（Android ≈1080dp × 2.96density）调优。不同分辨率/密度的设备可能需要调整尺寸。头图和磁贴宽高比取自反编译客户端 UI 比例（头图 1334:858、磁贴 400:320），缩放后的实际像素值是手动适配的结果。

**关键技术发现：**
- F3766 崩溃根因：`PngLoadHandler` 要求 PNG 格式，且 `Texture.fromBitmapData()` GPU 纹理限制 ≤ 2048px
- C2035 崩溃根因：`getLatestComicData()` 查找 `episode == totalCount`，需首页倒序排列
- 缩略图必须从顶部裁剪（`--cropOffset` 不可靠，改用 Pillow `crop((0,0,w,h))`）
- 约 53% 源文件为 RGBA 模式，需 `.convert('RGB')` 后才能存 JPEG

**数据源：** `docs/漫画/` 下的 422 张 JPG/PNG，处理后存 `web/public/comic/{kind}/`

### 12.8 漫画系统 (2026-06-10)

**端点：** `routes/api/comic.ts`

| 端点 | 功能 |
|------|------|
| `POST /comic/get_list` | 分页漫画列表（9 张/页，kind 区分） |
| `GET /comic/image?kind=&episode=&size=s\|l` | 漫画图片（三档尺寸） |

**数据源：** `docs/漫画/` 目录下的原始 JPG 图片（kind=1: 13 张, kind=0: 408 张）

**图片处理规则（从 CN 客户端反编译确认）：**

| 尺寸 | 用途 | 格式 | 处理 |
|------|------|:--:|------|
| main（详情） | 点击后全屏浏览 | PNG | 等比缩放，高度 ≤ 2048px（Starling GPU 纹理限制） |
| thumbnail_l（头图） | 列表顶部封面 | JPEG | 等比缩放至 984px 宽，顶部裁剪 623px |
| thumbnail_s（磁贴） | 3×3 网格 | JPEG | 等比缩放至 298px 宽，顶部裁剪 256px |

**关键踩坑记录：**
- `getLatestComicData()` 调用 `getByEpisode(totalCount)` → 要求列表**倒序排列**（最新在前），否则 C2035
- 页码 0-based（客户端发 `page_index=0` 为首页）
- 详情图必须 **PNG 格式**（客户端用 `PngLoadHandler`），JPEG 报 F3766
- GPU 纹理限制 2048px → 详情图高度必须 ≤ 2048px
- `parseKind1` / `parseKind0` 按文件名正则提取 episode 和 title
- 标题不拼 episode 序号（客户端已单独显示）
- 图片从顶部裁剪（Pillow `crop((0,0,w,h))`），sips 的 `--cropOffset` 不可靠

---

## 十三、账号与存档系统重构 (2026-06-11)

### 13.1 设备绑定

**之前：** `activeAccountId` 全局单例 — 所有设备共用同一个 account。

**现在：** `device_id` 绑定 — 每台设备自动独立的 account。

```typescript
// tool.ts signup
const binding = getDeviceBindingSync(deviceId)
if (binding) → 复用已有 account
else → 新建 account + player + device_bindings 行
```

**新增表：** `device_bindings(device_id, account_id, last_seen)`

### 13.2 两级时间系统

| 层级 | 存储 | 用途 |
|------|------|------|
| 服务器虚拟时间 | `active_account.json` → `timeOffset` | 全局默认，避免 CDN C8601 |
| 存档独立时间 | `players.time_offset` | 单存档穿越用（预留，待加 UI） |

```
getServerTime() = Date.now() + globalOffset
getServerTimeForPlayer(pid) = player.time_offset ?? getServerTime()
```

### 13.3 Web 面板简化

| 页面 | 内容 |
|------|------|
| `/` (Dashboard) | 仅时间设置 |
| `/player` | 三区：账号管理表 + 存档表 + 玩家列表 |

**账号管理表**：显示所有 account，每行「存档数」、「生效存档名」，「查看存档」+「删除」。

**存档表**（点击账号的「查看存档」后出现）：每条存档可「切换」（设定活跃存档）、「改名」、「新建」（空存档）、「删除」。

**存档名**可点击进入 `/player/:id` 编辑角色/道具/装备/关卡进度。

### 13.4 `activeAccount.ts` 精简

| 函数 | 用途 |
|------|------|
| `getActivePlayerId/setActivePlayerId` | 当前活跃存档 |
| `getSelectedAccountId/setSelectedAccountId` | Player 页当前查看的 account |
| `saveTimeOffset` | Dashboard 时间设置 → 存全局偏移 + player 偏移 |
| `restoreTimeOffset` | 启动时恢复全局时间偏移 |

删除：`rotateToNextAccount`、`giftIndex`、`restoreTimeOffset(player查)`

### 13.5 按钮行为总览

| 位置 | 按钮 | 行为 |
|------|------|------|
| Player 页/账号表 | 查看存档 | 选中该 account，下方显示其 saves |
| Player 页/账号表 | 删除 | 删 account + 所有 saves + device binding |
| Player 页/存档表 | 切换 | 设定为活跃存档 |
| Player 页/存档表 | 改名 | 改 `players.name` |
| Player 页/存档表 | 新建 | 同 account 下新建空 player |
| Player 页/存档表 | 删除 | 删该 save（最后一 save 顺带删 account） |
| Dashboard | 时间控件 | 设服务器全局偏移 + 写活跃存档的 `time_offset` |

### 13.6 默认安全时间

**之前：** 首次启动 `timeOffset=null` → 系统时间 → CDN 资源缺失 → C8601。

**现在：** `restoreTimeOffset()` 无保存值时自动设为 **2024-08-14 12:00 UTC**。

```typescript
const defaultDate = new Date("2024-08-14T12:00:00Z")
const offset = defaultDate.getTime() - Date.now()
```

Dashboard 时间控件可覆盖此默认值，保存后重启自动恢复。


## TODO（更新）

| 优先级 | 任务 | 状态 |
|:------:|------|:----:|
| 🔴 最高 | 存档独立时间 UI（Player 页 per-save 时间设置） | 待做 |
| 🟡 中 | 账号密码登录系统（spec 已写好，代码待实施） | 待做 |
| 🟡 中 | Web 面板「教程跳过」改为真正修改 triggeredTutorial | 待做 |
