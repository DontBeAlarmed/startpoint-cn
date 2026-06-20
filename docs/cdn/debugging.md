# CDN 排查手册
> 状态: 排查手册   关键文件: src/routes/cn/asset.ts, scripts/   相关端点: /asset/get_path

CDN 下载/数据对齐问题的端到端排查 runbook：12 步流程、数据对齐工具链、ADB 快速测试、排查命令、关键发现时间线、已知问题、错误码、构建/信标系统。机制见 `overview.md`，客户端逆向流程见 `client-flow.md`。

---

## 一、问题定义

```
条件：新 CDN 包 + is_initial=true + res_ver 匹配 + CharacterTable CDN 数据完整（505 角色）
结果：手机下载所有 CDN ZIP → 仍弹 C8601（"部分资源文件已损坏"）
```

> 此问题的最终根因（CDN 键体系 k_id vs business code 不匹配）见第七章。以下章节保留完整排查历程与工具链。

---

## 二、端到端流程（12 步）

| 步 | 位置 | 操作 | 关键字段/文件 |
|----|------|------|-------------|
| 1 | 手机 | AssetExtractor 解压 APK `assets/bundle.zip` | `app-storage:/asset/bundle/production/` |
| 2 | 手机→服务端 | POST `/api/index.php/tool/signup` | udid header |
| 3 | 服务端→手机 | 返回 viewer_id + login_token | — |
| 4 | 手机→服务端 | POST `/api/index.php/load` | res_ver header |
| 5 | 服务端→手机 | `available_asset_version = res_ver` | `cn/load.ts:wrapOptionFields()` |
| 6 | 手机 | `GlobalLoading.loadedHandler → applyLoad` | assetReadKind=2 |
| 7 | 手机 | `isDownloaded()` → 读取 `info.json` | 首次为 false |
| 8 | 手机→服务端 | POST `/api/index.php/asset/get_path` | res_ver + asset_size headers |
| 9 | 服务端→手机 | 返回 `full.archive[]` + `diff[]` | `cn/asset.ts:buildArchiveList()` |
| 10 | 手机 | 下载所有 ZIP | GET `/patch/cn/archive-*/...zip` |
| 11 | 手机 | 解压 ZIP → 编译 SQLite DB | `MasterSource.open()` |
| 12 | 手机 | `GeneralCharacterLogic(1)` → C8601 | `MasterBinaryMap.getIndex(1)` |

---

## 三、客户端请求时序图

```
signup (create account)
  ↓
load (player data + available_asset_version)
  ↓
[如果 isDownloaded() = false]
  asset/get_path (ZIP list)
  asset/version_info (CDN info)
  ZIP downloads × 677
  ↓
[写入 info.json]
  ↓
[tutorial/update_step × N]
tutorial/finish_trigger
  ↓
[后续登录]
load → isDownloaded() = true → 直接进入加载
  ↓
RootMasterBinary 加载 orderedmap
  ↓
[如果 orderedmap 解析成功 → 进入主场景]
[如果 C8601 → 弹框"资源损坏"]
[如果 8100 → 弹框"不足的数据" → 返回标题循环]
```

---

## 四、数据对齐工具链

> 来自 `starpoint-cn` 内的数据对齐调试经验：wfax / converter.py / sha1 / orderedmap 解码。

### 4.1 数据流全景

```
Leiting CDN (shijtswydl.leiting.com)
    │  wfax fetch (Go 工具)
    ▼
  dump/  原始有序映射二进制（ZIP 压缩）
    │  wfax extract
    ▼
  wf-assets-cn/orderedmap/  2115 个 JSON 文件（标准答案）
    │  converter.py (starpoint-cn/scripts/)
    ▼
  starpoint-cn/assets/  服务端使用的 JSON 文件
    │  TypeScript 静态 import
    ▼
  服务端运行时 (Fastify)
    │  HTTP API (MsgPack → Base64)
    ▼
  客户端 (CN Android APK)
    │  客户端本地 CDN 表 (orderedmap)
    ▼
  UI 显示 (报酬一览、掉落画面)
```

**关键原则**：`wf-assets-cn/orderedmap/` 是标准答案。服务端 `assets/` 中的 JSON 是转换脚本的产物。两者不一致 → 转换脚本有 bug。

### 4.2 wfax — CDN 下载/提取

| 命令 | 用途 |
|------|------|
| `wfax fetch dump --region cn` | 从 Leiting CDN 下载完整有序映射 |
| `wfax extract dump --indent 2 ./output` | 解压为 JSON → `output/orderedmap/` |
| `wfax extract dump --path-list .pathlist` | 仅提取指定路径的表 |

**安装**：`go install github.com/blead/wfax@latest`

**本地 CDN 镜像**（无需联网）：
```bash
wfax fetch dump \
  --custom-api "file:///path/to/entities/10939-android_medium.csv" \
  --custom-cdn "file:///path/to/cn_cdn_new/WF__CN2/" \
  --version 1.4.54
```

**路径**：`<PROJECT_ROOT>/cdn/cn_cdn_new/WF__CN2/`

### 4.3 converter.py — JSON 格式转换

**位置**：`starpoint-cn/scripts/converter.py`
**输入**：`scripts/in/<name>.json`（需从 `wf-assets-cn/orderedmap/` 复制）
**输出**：`scripts/out/<name>.json`（需复制到 `assets/`）

```bash
cd starpoint-cn/scripts
cp ../../wf-assets-cn/orderedmap/reward/rare_score_reward.json in/
python3 converter.py
cp out/rare_score_reward.json ../assets/
```

### 4.4 ADB — 客户端数据提取与 orderedmap 解码

```bash
# 连接设备
adb connect <ip>:5667

# 计算文件 SHA1
echo -n "master/reward/rare_score_reward.orderedmapK6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy" | shasum -a 1

# 提取文件
adb pull "/data/data/com.leiting.wf/.../Local Store/asset/asset_download/dummy/download/production/upload/{hash[:2]}/{hash[2:]}" /tmp/

# 解码有序映射二进制
python3 -c "
import zlib, json
buf = open('/tmp/file', 'rb').read()
decompressed = zlib.decompress(buf[4:])  # 跳过头 4 字节
# 使用 wfax 或手动解析有序映射结构
"
```

**CDN 文件寻址公式**：`SHA1("master/.../table.orderedmap" + "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy")`
**设备路径**：`production/upload/{hash前2位}/{hash剩余}`

### 4.5 数据分析工具

| 工具 | 用途 |
|------|------|
| `python3` + `json` | JSON 对比、结构分析、批量生成 |
| `sqlite3` | 查看 `wdfp_data.db` 验证服务端状态 |
| `grep` / `tail` | 日志分析 `[BATTLE]` `[QUEST]` 调试输出 |
| `console.log()` | 服务端关键路径埋点调试 |
| `msgpackr` | MsgPack 编码/解码 |

### 4.6 常见问题模式

**掉落相关排查链：**

```
现象：打完关卡无掉落
  ↓
1. 加日志确认掉落入口
   console.log(`[BATTLE] scoreReward groupId=${questData.scoreRewardGroupId} groupLen=...`)
   → groupId=undefined → 关卡 JSON 无 scoreRewardGroup
   → groupId=值, groupLen=null → score_reward.json 找不到该组
2. 确认 scoreRewardGroup 来源
   → 查转换脚本对应关卡的列索引（boss_battle=col[70], advent=col[76] 等）
   → 对照 CDN 原始数据验证
3. 确认稀有组存在性
   → 查 rare_score_reward.json 中是否有所引用的组
   → 查 ADB 客户端文件中是否有所引用的组（决定是否 C8601）
4. 确认 type 分类正确
   → type=0 (普通) → 客户端不查 RareScoreRewardTable → 无 C8601 风险
   → type=1 (稀有) → 客户端查 RareScoreRewardTable → 组必须存在
```

**转换脚本 bug 模式 —— Array wrapper（最常见）：CDN 数据有额外一层数组包裹！**
```python
# CDN 数据格式（wfax 提取后）：
{"1": [["name", "0", "0", "10000076", "4", "320", "", ""]]}
#               ↑ 额外一层数组包裹！

# 转换脚本错误写法：
for _, reward in score_group.items():
    type = int(reward[1])  # reward = [["..."]], reward[1] → IndexError!

# 正确写法：
for _, reward_wrapper in score_group.items():
    reward = reward_wrapper[0]  # 解包
    type = int(reward[1])
```

**列索引错误：**
```python
# boss_battle 和 advent 事件的数据结构不同
"scoreRewardGroup": int(chapter[70])  # boss_battle 正确
"scoreRewardGroup": int(chapter[76])  # advent 正确（不是 70!）
```

### 4.7 调试工作流

**通用流程：**
```
1. 日志定位      grep "CRASH|ERR:|level\":50" /tmp/cn-server.log → 确定错误码和触发时机
2. 端点验证      grep "POST.*url" /tmp/cn-server.log → 确认调用了哪些 API、返回状态码
3. 数据对比      diff <(python3 ... server_data) <(python3 ... cdn_data) → 找差异
4. 客户端提取    adb pull → zlib 解压 → 有序映射解析 → 确认客户端本地表内容
5. 修复          改 converter.py → 重新生成 assets/ JSON（或直接改 JSON）→ 构建重启
```

**服务端快速加日志：**
```typescript
// singleBattleQuest.ts 掉落入口
console.log(`[BATTLE] scoreReward groupId=${questData.scoreRewardGroupId} groupLen=${questData.scoreRewardGroup?.length ?? 'null'} questId=${questId} category=${questCategory}`)
// quest.ts 稀有池处理
console.log(`[QUEST] givePlayerScoreRewards group=${groupId} items=${scoreRewards.length}`)
console.log(`[QUEST] RARE_POOL rareGroup=${rareGroupId} found=${group !== null} items=${group?.length ?? 0}`)
```

**存档快速排查：**
```bash
# 查看最近完成的关卡
sqlite3 .database/wdfp_data.db "SELECT quest_id, clear_rank FROM players_quest_progress WHERE player_id=20 ORDER BY rowid DESC LIMIT 10"
# 查看编队状态
sqlite3 .database/wdfp_data.db "SELECT id, party_slot FROM players WHERE id=20"
```

### 4.8 关键数据文件映射

| CDN 源 (wf-assets-cn/orderedmap/) | 服务器 (starpoint-cn/assets/) | 重要列 |
|------|------|------|
| `reward/score_reward.json` | `assets/score_reward.json` | type, id, count, rarity |
| `reward/rare_score_reward.json` | `assets/rare_score_reward.json` | type, id, count, rarity |
| `quest/boss_battle_quest.json` | `assets/boss_battle_quest.json` | scoreRewardGroup (col[70]) |
| `quest/event/advent_event_quest.json` | `assets/advent_event_quest.json` | scoreRewardGroup (col[76]) |
| `shop/event_item_shop.json` | `assets/event_item_shop.json` | BOSS 币 ID → 商店商品 |
| `item/item.json` | — | 物品 ID → 中文名 |

### 4.9 经验总结

1. **CDN 原始数据是唯一标准答案**。不要自行构造合成数据——除非确认 CDN 中确实不存在。
2. **转换脚本是所有问题的根源**。Array wrapper、列索引、`||` vs `??` 等 JS/Python 差异都是常见陷阱。
3. **type=0 vs type=1 是分水岭**。type=0（普通）走直接发放 → 客户端不查 RareScoreRewardTable → 不会 C8601。type=1（稀有池）→ 客户端查表 → 组必须存在。
4. **优先查 CDN**，再查客户端 ADB 提取，最后才考虑合成数据。
5. **DROP_MULTIPLIER** 在 `.env` 中配置，测试时设 10 便于快速积累，上线设 1。
6. **`wf-assets-cn` 的 `.pathlist`** 记录了所有 CDN 表的路径（976 条），是查找 CDN 数据的索引入口。

### 4.10 Gacha 动画种子生成（理论方案）

**背景**：C3032 错误——客户端收到 `seed` + `movie_id` 后，用 MersenneTwister(seed) 模拟弹珠物理得出预期稀有度。若与角色实际稀有度不一致 → C3032。

**种子需求：**

| movie_id | 动画配置 | 说明 |
|------|------|------|
| `normal` | `master/gacha/normal.orderedmap` | 常规卡池 |
| `fes` | `master/gacha/fes.orderedmap` | FES/流星祭 |
| `normal_guarantee` | `master/gacha/normal_guarantee.orderedmap` | 10 连保底 |
| `fes_guarantee` | `master/gacha/fes_guarantee.orderedmap` | FES 保底 |

每种配置需按稀有度（★3/★4/★5）生成各自的种子池。

**数据源：**

| 来源 | 路径 | 状态 |
|------|------|------|
| 动画配置文件 | `master/gacha/{movie_id}.orderedmap` | ⚠️ 本地 CDN ZIP 中未找到（可能仅 APK 内嵌） |
| 客户端弹珠物理源码 | `wf-2.1.125-cn-decompiled/.../ballMovie/fallingField/FallingField.as` | ✅ 可用 |
| 客户端种子校验 | `BallMovie.verifyResultBallRarity()` | ✅ 可参考 |

**种子生成流程（计划）：**
```
1. 提取动画配置文件
   → SHA1("master/gacha/fes.orderedmap" + salt)
   → 从 CDN ZIP 或 APK 提取 orderedmap 二进制
   → zlib 解压 → JSON（ballStar4, amuletTwoUp, amulets[], playMovie 等阈值）
2. 在 Node.js 中实现 MersenneTwister(seed) 模拟
   → 参考 FallingField.as 的 initBallRarity() 和 precalculateFieldResult()
   → 输入：seed + movie 配置参数；输出：ballRarityIndex (0=★3, 1=★4, 2=★5)
3. 暴力枚举
   for seed in range(10000000, 99999999):
       if simulate(seed, movieConfig) matches target: seeds.push(seed)
4. 按 movie_type × rarity 分组输出 → gacha_movie_seeds.json
```

**参考文件**：`FallingField.as`（物理模拟）、`BallMovie.verifyResultBallRarity()`（种子校验）、`BallMovieGachaSource.getGachaConfig()`（资产加载）、`GachaMovieIdTools.getGachaConfigAssetPath()`（路径生成）。

**当前种子池**（数据来源：历史抓包；`fes` 类型种子为空）：

| 文件 | 常规 normal | 常规 guarantee | rate-up normal | rate-up guarantee |
|------|:---:|:---:|:---:|:---:|
| ★5 | 23 | 7 | 14 | **2** |
| ★4 | 124 | 44 | 56 | 24 |
| ★3 | 292 | — | 162 | — |

---

## 五、ADB 快速测试法

> 避开 10GB CDN 重复下载，用 adb 直接操作文件完成快速迭代测试（核心操作只需 30 秒，比重新下载 10GB 快 600 倍）。

### 5.1 目的与适用场景

每次修改后重新下载 10GB CDN 极其耗时（~30 分钟）。本方法通过 adb 直接操作手机文件，绕过 CDN 下载流程，让游戏直接进入加载阶段。适用于：
- 快速验证 Orderedmap 二进制解析（RMB 信标）
- Bundle stub 替换测试
- 资源文件缺失排查
- 反复迭代 SWF/信标修改后的回归测试

### 5.2 原理

**客户端 CDN 判断流程：**
```
signup → load → applyLoad
  ├─ isDownloaded(version) → 检查 info.json.version
  │   ├─ partial_downloaded.json 存在 → false（下载进行中）
  │   ├─ 版本不匹配 → false（触发下载）
  │   └─ 版本匹配 → true
  ├─ isAssetComplete() → 检查 info.json.assetRecoveryInfo
  │   └─ 空数组 → true
  └─ 两者都 true → 直接 StartLoading，跳过 CDN 下载
```

**为什么 adb 操作可以跳过 CDN**：CDN 下载产生的文件就是磁盘上的二进制文件；用 adb 直接复制等效文件 → 客户端判断逻辑感知不出差异；`info.json` + `partial_downloaded.*` 控制下载判断，手动设置即可。

**bundle stub 替换原理：**
```
问题：bundle 中 _iosbundled（69828cac...）只有 4 条目
     → bundleFiles.contains(hash) 优先加载 bundle stub
     → MasterBinaryMap.getIndex(2) 找不到 → C8601
修复：用 CDN CharacterTable（505 条目）覆盖 bundle stub
     → _iosbundled 返回 505 条目 → 主路径也返回 505 条目 → 正常
```

### 5.3 前置条件

| 条件 | 检查方法 |
|------|------|
| 5667 root 手机在线 | `adb devices` |
| 服务端在线 | `lsof -i :8001` |
| APK 已安装（推荐 1.7.6，不触发 `character_level_up_effect`） | — |
| CDN 数据存在或已手动推送 | 检查 `upload/2d/5cb9b28d...` 是否存在 |

### 5.4 操作步骤

**方案 A：已下载 CDN（推荐）**
```bash
# 1. 检查 adb 连接
adb devices
# 2. 检查服务端
lsof -i :8001
# 3. 查看当前 info.json 状态
adb -s <DEVICE_IP>:5667 shell "cat '.../dummy/info.json'"
# 4. 删除残留的进行中标记
adb -s <DEVICE_IP>:5667 shell "rm '.../dummy/partial_downloaded.json' '.../dummy/partial_downloaded.platform'"
# 5. 复制 CharacterTable 覆盖 bundle stub
adb -s <DEVICE_IP>:5667 shell "cp \
  '.../download/production/upload/2d/5cb9b28d18f984a51b345a4d7aab03d77bddfc' \
  '.../bundle/production/android_bundle/db/69828cac33bfcdd1d4c65e8b354adf0e815e26'"
# 6. 重启游戏，监控信标
tail -f /tmp/cn-server.log | grep BEACON
```

**方案 B：零下载（手动推送最小文件集）** —— 适用于全新安装或 CDN 数据已丢失，只需推送几个文件（几 KB）。
```bash
# 1-2. 同方案 A
# 3. 从 Mac 推送 CharacterTable 二进制到手机
adb -s <DEVICE_IP>:5667 push /tmp/ct_505.bin \
  '/data/data/com.leiting.wf/.../upload/2d/5cb9b28d18f984a51b345a4d7aab03d77bddfc'
# 4. 复制到 bundle stub 路径（同方案 A 步骤 5）
# 5. 手动写入 info.json
adb -s <DEVICE_IP>:5667 shell "cat > '.../dummy/info.json' << 'EOF'
{\"assetSizeKind\":\"fulfill\",\"assetRecoveryInfo\":[],\"totalSize\":10000000000,\"version\":\"1.4.0\"}
EOF"
# 6. 修改服务端 files_list → empty.csv（跳过 sufficiency check）
#    编辑 cn/asset.ts: files_list: '{CDN_BASE}/EntityLists/empty.csv'
# 7. 重启服务端，重启游戏，监控信标
```

### 5.5 预期结果

| 信标 | 含义 | 下一步 |
|------|------|------|
| `RMB:init slices=1` + `RMB:getIntMap entries=505` | CharacterTable **解析成功** | ✅ CDN 数据无问题 |
| `RMB:getIntMap entries=0` | 文件找到但**解析失败** | CDN 二进制格式不兼容 |
| `ERR:7051` | 主路径和 `_iosbundled` 有重复 key | CDN 数据完整，需去重 |
| `ERR:C8601` | key=2 仍缺失 | 主路径也解析失败或 key 确实不存在 |
| `ERR:C8100` | recovery 弹框 | `files_list` 需改为 `empty.csv` |

### 5.6 恢复方法

```bash
# 1. 删除手动复制的文件
adb -s <DEVICE_IP>:5667 shell "rm '.../bundle/.../db/69828cac33bfcdd1d4c65e8b354adf0e815e26'"
# 2. 恢复原始 bundle stub（从 APK bundle.zip）：方式 A 手机重新解压 bundle.zip；方式 B adb push 原始 stub
# 3. 删除 info.json（触发重新下载）
adb -s <DEVICE_IP>:5667 shell "rm '.../dummy/info.json'"
```

### 5.7 注意事项 ⭐

- ⚠️ **必须先检查 adb 连接**：`adb devices`，确认 5667 在线
- ⚠️ **保持服务端在线**：每次操作后检查 `lsof -i :8001`
- ⚠️ **删除 `partial_downloaded.*`**：此文件存在时 `isDownloaded()` 永远返回 false
- ⚠️ **确认 `info.json.version`**：必须匹配服务端 `available_asset_version`（当前为 `"1.4.0"`）
- ⚠️ **备份原始 bundle stub**：操作前 `cp` 一份到 `.bak` 路径
- ⚠️ **bundle 数据会被 APK 重装覆盖**：重装 APK 会重新解压 bundle.zip，手动复制的文件会丢失
- ⚠️ **仅对 5667（root）有效**：37983 无法访问私有目录

### 5.8 后续测试复用

| 测试类型 | 需要准备的文件 | 操作 |
|------|------|------|
| CharacterTable 解析 | ct_505.bin | cp 到 bundle stub 路径 |
| 缺文件测试 | 任意文件 | 删除对应路径，观察错误码 |
| 版本判断测试 | info.json | 修改 version 字段，触发/跳过下载 |
| recovery 循环测试 | info.json | 修改 assetRecoveryInfo，观察循环 |
| bundle stub 测试 | bundle/db/*.bak | 恢复/删除 stub，观察 C8601 变化 |

### 5.9 常见问题

- **Q：复制后游戏仍然下载 CDN？** A：检查 `partial_downloaded.json` 是否已删除，`info.json.version` 是否匹配服务端。
- **Q：adb 操作后数据丢失？** A：覆盖安装 APK 会重新解压 bundle.zip。操作后不要重装 APK。
- **Q：为什么 37983 不能这样操作？** A：非 root 手机无法访问 `/data/data/` 私有目录。需 root（5667）。
- **Q：如何判断当前手机是 5667 还是 37983？** A：`adb devices` 查看在线设备列表。

---

## 六、排查命令清单

### 6.1 服务端

```bash
# 验证 get_path 响应
curl -s -X POST http://localhost:8001/api/index.php/asset/get_path \
  -H "content-type: application/x-www-form-urlencoded" --data-raw "" | python3 -c "
import sys, base64
sys.path.insert(0, 'node_modules')
from msgpackr import unpack
data = unpack(base64.b64decode(sys.stdin.buffer.read()))
print(data['data']['info'])
"

# 验证 CharacterTable ZIP 可访问
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  http://localhost:8001/patch/cn/archive-common-full/pinball-1.4.0-61-cc592e56.zip

# 检查最近下载日志
grep "pinball-1.4.0-61" /tmp/cn-server*.log

# 重启服务端
cd starpoint-cn
kill $(lsof -ti :8001)
npm run build
node --env-file=.env out/cn-server.js > /tmp/cn-server.log 2>&1 &

# 查看信标
grep BEACON /tmp/cn-server.log | grep -v "servertime\|viewer_id"

# 查看错误
grep -E "ERR:|CRASH|C8601|8100|8102" /tmp/cn-server.log

# 查看下载进度
grep -c "archive-common-full" /tmp/cn-server.log
```

### 6.2 手机端（需 root，仅 5667）

```bash
# 检查 CharacterTable 二进制是否被解压到本地
adb shell su -c "ls -la /data/user/0/com.leiting.wf/files/asset/asset_download/dummy/production/upload/93/35d17430d2d157ea5e2b573b6ba4f210232664"

# 查看 info.json（本地版本记录）
adb -s <DEVICE_IP>:5667 shell cat '.../dummy/info.json'

# 查看 CDN 下载目录
adb -s <DEVICE_IP>:5667 shell ls '.../download/production/'

# 查看编译数据库内容 / compiled version
adb shell su -c "sqlite3 /data/user/0/com.leiting.wf/files/asset/bundle/production/android_bundle/db/69828cac33bfcdd1d4c65e8b354adf0e815e26 '.tables'"
adb shell su -c "sqlite3 .../db/69828cac... 'SELECT sql FROM sqlite_master WHERE type=\"table\" LIMIT 10;'"

# 查找所有 SQLite 数据库文件
adb shell su -c "find /data/user/0/com.leiting.wf/files/asset/ -name '*.db' -o -name '*.sqlite'"

# 清除缓存（不丢 CDN 数据）
adb -s <DEVICE_IP>:5667 shell rm -rf '.../cache/'

# 清除 info.json（重新触发下载判断）
adb -s <DEVICE_IP>:5667 shell rm '.../dummy/info.json'

# 安装 APK
adb -s <DEVICE_IP>:5667 install -r wf-patched.apk
```

---

## 七、核心发现：CDN 键体系不匹配（C8601 根因与修复分层）

> 最后更新：2026-06-08（服务端 k_id→code 转换部署后，游戏进入主场景）

### 7.1 根因

**`cn_cdn.rar` 是中间编译产物，不是官服最终 CDN。** CDN 中所有 orderedmap 表使用**业务 code**（6 位复合码）作为键，但客户端按 **`k_id`**（整数 ID）进行查找。

| | CharacterTable 键 | 客户端查找 | 结果 |
|------|------|------|------|
| CDN dump | `"10"`, `"111001"`, `"121002"`... | `.get(7)` | key `"7"` 不存在 → C8601 |
| 官服 CDN | `"1"`, `"2"`, `"7"`... | `.get(7)` | 正常工作 |

### 7.2 代号对照表

`docs/代号对照表.xlsx`（450 条）是 CharacterTable 专用的 code→k_id 映射。

| k_id | code | name |
|------|------|------|
| 1 | 1 | alk（男主） |
| 2 | 10 | white_tiger（小白） |
| 7 | 121002 | onmyoji_boy（阴阳师） |

### 7.3 修复方案总览（最终版）

C8601/8100/F1009 等错误的根因分两类：
- **数据格式不匹配**：服务端返回 k_id，CDN 用 business code → **服务端修复**
- **CDN dump 物理缺失**：文件不在任何 dump 来源中 → **客户端 SWF 防御跳过**

| # | 修复 | 层面 | 方式 | 需要SWF? | 状态 |
|------|------|------|------|------|------|
| **0** | **k_id→code 映射** | **服务端** | `utils.ts:serializePlayerData()` 中角色ID转 business code | ❌ | ✅ 主修复 |
| **1** | 动画跳过 | 客户端 SWF | `PixelArtCharacterView.run()` try-catch | ✅ | ✅ Step 01c |
| **2** | AttentionConfig 跳过 | 客户端 SWF | `AttentionConfigLogic.loadMasterIfNotLoaded()` try-catch | ✅ | ✅ Step 01d |
| **3** | 构建校验 | 构建 | `06c-verify-markers.sh` 14 标记 | ❌ | ✅ Step 06c |
| — | ~~505 k_id bundle~~ | 客户端 | ~~替换 3 个 bundle stub~~ | — | ❌ 废弃（服务端修复替代） |

**修复分层原则：**

| 层面 | 职责 | 何时用 |
|------|------|------|
| **服务端** | 数据格式转换 (k_id→code) | ✅ 优先——不动客户端 |
| **客户端 SWF** | try-catch 校验跳过 | 仅当 CDN dump 物理缺失文件时用（服务端无法修复） |
| **客户端 Bundle** | 不动 | 原始 CDN 数据即可 |

> 目的：为可能的单机/离线版移植**保留**客户端修复方法（505 k_id 替换等）作为备选。联机版优先用服务端修复。

**修复 0：k_id→code 服务端转换（核心）** —— 服务端 SQLite 存 k_id（如 2,7），官方 CDN orderedmap 用 business code（如 10,111001,121002）。官方服务端返回 business code，客户端直接用 code 查 CDN 表。我们返回 k_id，客户端 get(2) 找不到 key=2。
- `src/data/codeMap.ts`：从 `代号对照表.xlsx` 加载 449 条 k_id↔code 映射。
- `src/data/utils.ts`：`serializePlayerData()` 中 characterList/party/rush event 等角色 ID 全部 k_id→code；`deserializePlayerData()` 中 code→k_id 回存。
- 效果：客户端收到 business code → 直接查 CDN 原版表（business code key）→ 找到了。bundle 505 k_id 修复全部废弃。

**修复 1-2：CDN dump 物理缺失**

| 补丁 | 缺失文件 | 原因 |
|------|------|------|
| 01c | `character_level_up_effect.frame.amf3.deflate` | `.pathlist` 有记录但 ZIP 无二进制文件 |
| 01d | `attention_config.orderedmap` | CDN 有文件(78B)但 `MasterSummary.paths` 哈希映射未知，加载失败 |

两个文件均**不在任何 CDN dump 中**，服务端无法提供，客户端 SWF try-catch 防御是唯一解法。

### 7.4 历史修复探索（保留供参考）

`character_iosbundled` orderedmap 由 `RootMasterBinary.getIntMap()` 解析，格式为 `[entry_count][N×(cum_key_len_u32, val_off_u32)][key_string]`。

原始 key string: `"7456"` (0x37,0x34,0x35,0x36) → cum_lens [1,2,3,4] → `Std.parseInt("7"→7,"4"→4,"5"→5,"6"→6)` → keys [7,4,5,6]。*（早年误记为 69,228,149,424——误读 value_offset 为 key；FFDec 逆向 `RootMasterBinary.as` 确认真实值 [7,4,5,6]。）*

通过 CDN CharacterTable 重建（505 条 k_id），用 `代号对照表.xlsx`（449 条映射 + 56 条补充）替换键，得到 72,543B 的 505 k_id 版。
- **修复②：10 条文本 stub** —— 扩展 `character_text_iosbundled` 需同时避免 C7051（与 data 表 key 冲突）和 C8601（key 缺失）。实验发现 10 条不触发 C7051 阈值，创建 key 1-10 通用 stub（151B）。玩家 key=2,7 在覆盖内。
- **修复③：10 条状态 stub** —— 同上模式，从 CDN `character_status` 表提取真值（1092B），用 k_id 键 1-10。
- **C7051 冲突根因** —— `MasterSummary.iosBundledPaths` 将 text/status stub 作为 `character_iosbundled` 扩展 slice 加载 → 同一 `IntMap` → 同键冲突。仅发生在两个文件都 ≥ 505 条时（阈值未知），10 条以下不触发。

### 7.5 其他表的处理

`wf-assets-cn/orderedmap/` 包含 2115 个 JSON 源文件，全部使用业务键。除 CharacterTable 有对照表外，其余 2114 个表**没有 code→k_id 映射**。可能其他表的业务键恰好是客户端需要的格式（如 ItemTable 用字符串键）——需逐个验证。

### 7.6 动画跳过补丁（2026-06-08）

`PixelArtCharacterView.run()` 硬编码调用 `getAnimation("scene/general/animation/character_level_up_effect")`。CDN dump 不含此文件的纹理 atlas（确认为源码硬限制）。Step `01c-skip-animation.sh` 通过 SWF 补丁注入 try-catch 和 null 守卫：

```actionscript
// L409: 包裹 try-catch
try { pedestalLevelUpEffectAnimation = view.asset.getAnimation("..."); }
catch(_e_:*) { pedestalLevelUpEffectAnimation = null; }
// L410: 守卫 addChild
if(pedestalLevelUpEffectAnimation != null) animationEffectLayer.addChild(...);
// L676: 守卫 gotoAndStop
if(pedestalLevelUpEffectAnimation != null) pedestalLevelUpEffectAnimation.gotoAndStop(...);
```

效果：CDN 缺失此动画时游戏不崩溃，跳过播放（无视觉效果但不影响功能）。

### 7.7 AttentionConfig 源码分析

`AttentionConfigLogic.loadMasterIfNotLoaded()`（CN 源码 line 116）：
```as3
var _loc2_ = _loc1_.getMasterTable(AttentionConfigTable).get_data().get(1);
```
传 `int 1` 调用 `MasterIntMap.get()`。`attention_config.orderedmap` CDN 有文件(78B)但 `MasterSummary.paths` 哈希映射未知。SWF try-catch 包裹解决。

### 7.8 当前状态（2026-06-08）

**服务端 k_id→code 转换已部署**——核心 C8601 问题根除。客户端保持原始 bundle + CDN。

| 类型 | 状态 | 说明 |
|------|------|------|
| C8601 (k_id 不匹配) | ✅ 服务端修复 | `serializePlayerData()` 转 business code |
| C8601 (bundle stub) | ✅ 不再需要 | 原始 4 条目 stub 不影响 code 查找 |
| 黑屏（动画纹理缺失） | ✅ 01c try-catch | SWF 防御跳过 |
| C8601 (AttentionConfig) | ✅ 01d try-catch | SWF 防御跳过 |
| F1009/U_982156 运行时 | ✅ 非致命 | 场景切换生命周期 |
| 构建流程 | ✅ 全入口+子脚本+marker | Step 02 禁；config.sh 统一配置；reserved/ 保留参考 |
| APK 源 | ✅ `sjdswy2025zxb.apk` (1.8.1) | 5667 全量版 / 37983 验证版 |

---

## 八、关键发现时间线

### 问题 1：C8601 — CharacterTable 数据缺失

**症状**：进入主场景后弹框 "指定的Key不存在。key=2"。

**排查过程**：
1. ❓ 怀疑 CDN 文件缺失 → 验证 ZIP 中存在 CharacterTable 二进制（72979 bytes，505 条目）→ 排除
2. ❓ 怀疑 CSV 不含 CharacterTable → 验证 CSV 第 20197 行包含 → 排除
3. ❓ 怀疑 `sha256` 空值导致校验失败 → 反编译确认客户端不校验 sha256 → 排除
4. ❓ 怀疑 diff 版本覆盖导致 → 测试纯 base 1.4.0 CDN 仍报错 → 排除
5. ❓ 怀疑文件路径不匹配 → 验证 `resolveFiles()` 构建路径与磁盘一致 → 排除
6. ✅ 确定根因：bundle.zip 内含 `android_bundle/db/` 13 个 stub 文件

**根因**：bundle `android_bundle/db/69828cac...`（= `character_iosbundled.orderedmap`）在 `bundleFiles` 白名单中被优先加载，bundle stub 只有 4 条目（keys 69,228,149,424——后确认为 7,4,5,6），主路径 CharacterTable 的 505 条目在 CDN 中但因优先权问题无法生效。

**修复（早期）**：starview Step 1b 删除 `android_bundle/db/`（3 个目录，保留 `bundle/db/` 含标题 logo）。Step 6 复制修改后 bundle.zip 到最终 APK。必须完全卸载重装才能生效（AIR SWF+bundle 缓存）。**注**：此 bundle 方案后被第七章服务端 k_id→code 修复取代。

### 问题 2：CDN 下载循环（Recovery 循环）

**症状**：下载完成后立即提示重新下载/"不足的数据"。

**根因**：`version_info.files_list` CSV 含全部 137,820 条记录，其中 `character_level_up_effect` 及其他 diff 版本文件不在 CDN 中。Sufficiency check 发现缺失 → recovery 触发 → 独立文件也缺失 → 循环。

**修复**：`files_list` 指向 `EntityLists/10939-android_medium.csv`（正常模式）。如需跳过 recovery，可临时指向 `empty.csv`。

**下载循环修复历史（CDN 配置层面）：**

| 阶段 | 症状 | 根因 | 修复 |
|------|------|------|------|
| ① | full-only(1.4.0) 正常 | 版本匹配 | — |
| ② | +diff(1.4.54)后循环 | load 返回 1.4.0 ≠ info.json(1.4.54) | 服务端读取 res_ver header |
| ③ | isFullPackage=true 无效 | 运行时值未生效，且 bundle 无 CharacterTable | 撤销 |
| ④ | 服务端 target=res_ver | 版本匹配但 is_initial=false 跳过全量 | ✅ is_initial=true |
| ⑤ | diff 放错在 full 列表 | ZIP 内容格式不匹配导致编译失败 | diff 独立字段 |

### 问题 3：`character_level_up_effect` 缺失

**症状**：加载阶段报 8100 `notify_asset_recovery 未找到素材 scene/general/animation/character_level_up_effect.frame.amf3.deflate`。

**根因**：该文件在 CDN dump 中不存在。`.pathlist` 中列有此路径（证明应为 CDN 一部分），但 ZIP 中无对应文件。两份 CN CDN 对比确认都不含此文件。

**影响**：`files_list` 指向正式 CSV 时 sufficiency check 会将其标记为缺失，触发 recovery 循环。指向 `empty.csv` 时 sufficiency check 无发现，但游戏仍可能在其他代码路径中尝试加载此文件而报 8100。

### 问题 4：API Server 配置错误

**症状**：游戏提示"未能联网"。

**根因**：拆分后的 `01-patch-swf.sh` 中 `sed` 将 `shijtswygamegf.leiting.com` 替换为 `http://<LAN_IP>:8001`（含 `http://` 前缀），导致 `ApiServerKind.Custom("http","http://<LAN_IP>:8001")` 双 `http://` 无效 URL。

**修复**：`sed` 先剥离 `http://` 前缀再替换 hostname。已通过 SWF 导出验证（`ApiServerKind.Custom("http","<LAN_IP>:8001")`）。

### 问题 5：enableAssetSufficiencyCheck 误设为 false

**症状**：游戏弹出 8102 崩溃（`素材 master//character/character_iosbundled.orderedmap将其打开后未出现`）。

**根因**：为阻止 recovery 弹框，临时在 DevConfig 中设置 `enableAssetSufficiencyCheck = false`。这导致 bundle db 删除后 `_iosbundled` 查找失败时 `notifyFileNotFoundError` 直接 throw 8102，而非默认的 dispatch FileNotFound 静默跳过。

**修复**：移除 `devconfig_disablesck.py` beacon，恢复默认值 `true`。

### 问题 6：AIR SWF 缓存

**症状**：安装新 APK 后旧 SWF 仍在运行，信标不触发、配置不生效。

**根因**：Android AIR 应用首次启动时将 SWF 和 bundle 提取到 `cache/app/<UUID>/`。覆盖安装 APK 不更新此缓存。

**解决**：完全卸载后重装，或在手机设置中清除应用缓存。**切勿只清除数据——会丢失 CDN 下载的 10GB。**

### 问题 7：Bundle ZIP 构建后未生效

**症状**：APK 已构建 0 db 条目但手机仍报 C8601。

**根因**：
1. Step 1b 修改 `$WORK_DIR/work/assets/bundle.zip` 但 Step 6 从原始 APK 重新解包覆盖了修改版
2. `zip -r` 不删除旧条目（直接追加）
3. 两次修复后（Step 6 加 `cp` + `rm -f "$BUNDLE_ZIP"` before repack）才生效

### 问题 8：两份 CDN 数据完全一致

**对比结果**：`cn_cdn.rar` 和 `cn_cdn_new/WF__CN2.zip` 的 ZIP 数量、文件大小（byte-level）、CSV 行数、`pinball-1.4.0-61.zip` 全部一致。唯一差异：目录名 `entities/` vs `EntityLists/`。**结论**：换 CDN 不能解决任何缺失文件或兼容性问题。

### 问题 9：低版本 APK 测试（1.7.6）

**结论**：1.7.6 和 1.8.1 **行为完全一致**。C8601 仍出现，stub `69828cac...` 在所有 CN 版本中都存在。唯一差异：1.7.6 不触发 `character_level_up_effect` 的 8100 错误——1.7.6 的游戏代码中没有引用该文件。

### 问题 10：CDN 键体系不匹配（核心发现）

**根因**：`cn_cdn.rar` 是 CDN 构建的**中间产物**，所有 orderedmap 表使用业务 code（6 位复合码）作为键。官方 CDN 在最终编译阶段会通过映射表将 code 转为 k_id（整数），但我们的 dump 未经过此步骤。

**修复（CharacterTable）**：Python 脚本从 CDN 提取 orderedmap 二进制 → 解压 → 用 `代号对照表.xlsx`（450 条 code→k_id 映射）替换所有键 → 重新压缩 → 推送到手机两个路径。**修复后验证**：key 1,2,7 全部可查找，C8601 在 CharacterTable 层面消失。**局限性**：其余 2114 个 orderedmap 表没有对应 code→k_id 映射表。（最终采用服务端转换替代 bundle 替换，见第七章。）

---

## 九、已验证事实 / 未确认环节 / 剩余假设

### 已验证事实

| 步骤 | 验证结果 | 证据 |
|------|:--:|------|
| 2-3 | ✅ | 服务器日志 `/signup` → 200 |
| 4-5 | ✅ | 服务器日志 `/load` → 200，`res_ver` header 正确传递 |
| 6-7 | ✅ | 信标 `GL:applyLoad START` 到达 |
| 8-9 | ✅ | 信标 `GL:loadedHandler START` 到达，get_path 返回 490 full + 54 diff |
| 10 | ✅ | 服务器日志确认 ZIP 全部 200，CharacterTable 所在 ZIP 被下载 3 次 |
| CDN 数据 | ✅ | CharacterTable 二进制有 505 个角色条目（含 `alk`/ID=1） |
| SHA256 | ✅ | CDN 文件 SHA256 与 EntityLists CSV 记录一致（urlsafe base64） |
| Salt | ✅ | `K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy` 经 3/3 路径验证正确 |
| API 配置 | ✅ | `is_initial=true`, diff 独立字段, res_ver 动态匹配 |

### 未确认环节

| 环节 | 问题 | 需要操作 |
|------|------|---------|
| **ZIP 解压** | 下载的 ZIP 是否正确解压到本地？ | 手机检查 `asset_download/dummy/production/upload/93/35d174...` 是否存在 |
| **数据库编译** | 编译的数据库是否包含 CharacterTable 条目？ | 导出 SQLite DB 查询 |
| **数据库路径** | 游戏从哪个路径加载数据库？ | 对比 bundle 和 CDN 两个路径 |
| **编译完整性** | 505 个条目是否全部被正确解码？ | 导出 DB 确认条目数 |

### 剩余假设

| 假设 | 概率 | 说明 |
|------|:--:|------|
| **数据库编译时 CharacterTable 被跳过** | **高** | ZIP 被正确下载、解压位置正确，但 binary decode 失败导致 505 条目全部丢失 |
| **数据库编译到错误路径** | 中 | 编译到了非预期位置，游戏从 bundle 路径（缺数据）加载，而非 CDN 路径 |
| **key 类型不匹配** | 低 | `MasterIntMap.get(1)` (int) vs binary key "1" (string)——但 EN 也走此路径且正常 |

---

## 十、已知问题与修复状态

| 问题 | 状态 | 修复 |
|------|------|------|
| C8601（k_id vs code 不匹配） | ✅ 服务端修复 | `serializePlayerData()` 角色 ID → business code |
| C8601（bundle stub） | ✅ 废弃 | 不需要——原始 bundle 不影响 code 查找 |
| C8601（AttentionConfig） | ✅ SWF 跳过 | 01d try-catch |
| `character_level_up_effect` 黑屏 | ✅ SWF 跳过 | 01c try-catch + null 守卫 |
| C7051 重复 key | ✅ 不再触发 | 原始 bundle stub 无重叠 |
| F1009 / U_982156 运行时 | ✅ 非致命 | 场景切换 Gear dispose |
| Orderedmap 格式 | ✅ 已确认 | cum_key_len + key_string + Std.parseInt |
| Step 02 bundle 修复 | ✅ 已禁用 | 服务端修复替代，脚本移 `reserved/bundle-fix/` |
| Recovery 下载循环 | ✅ 已可避免 | `files_list: empty.csv` |
| `apiServer` 双 http:// | ✅ 已修复 | `01-patch-swf.sh` |
| `enableAssetSufficiencyCheck=false` | ✅ 已修复 | 移除 beacon，恢复 true |
| Bundle ZIP 构建覆盖 | ✅ 已修复 | Step 6 `cp` + Step 1b `rm -f` |
| 全版本 `69828cac...` 确认 | ✅ 已确认 | 1.7.6/1.7.8/1.8.1 全部存在，换 APK 无效 |
| `FileReader.as` 无法 FFDec 导入修改 | 已知 | FFDec 对此文件 recompilation 失败，需改 DevConfig |
| 标题画面 logo 动画缺失（8100） | 已知 | `scene/title_bundled/logo/logo.movie.amf3.deflate` 仅存在 CDN 中，首次启动无 CDN 时出现，非阻塞 |
| SWF 缓存需完全卸载 | 已知 | AIR 缓存机制（见问题 6 / 构建管线 AIR SWF 缓存） |
| 教程端点持久化 | 待修 | `/tutorial/update_step` + `finish_trigger` 为 stub |
| `enable_newbie` 控制 | ✅ 已修复 | `cn/load.ts` 改为 `false`，教程不重播 |

**C8601 修复确认（早期 bundle 方案，已被服务端修复取代）**：
- **根因**：bundle.zip 内含 `production/android_bundle/db/` 等 4 个 db 目录，其中 `69828cac...` 为 `character_iosbundled` stub（465 字节）。`FileReader.resolveFiles()` 通过白名单 `bundleFiles.contains()` 优先加载 bundle stub，导致 `RootMasterBinary` 解析返回 0 条目。
- **修复**：Step 1b 删除 bundle.zip 内全部 `*/db/` 目录。Step 6 `cp` 修改后的 bundle.zip 到 APK。完全卸载重装后验证通过（C8601 不再出现）。
- **注意**：必须**完全卸载 + 清除缓存**才能生效。

---

## 十一、客户端错误码参考

| 错误码 | 含义 | 常见原因 | 触发位置 / 排查入口 |
|--------|------|----------|---------|
| **C3032** | Gacha 种子稀有度不匹配 | MersenneTwister 模拟稀有度 ≠ 角色实际稀有度 | `BallMovie.verifyResultBallRarity()` |
| **C3212** | 找不到通关等级 | `clearRank` 为 NULL | `quest_progress` 表、`story_quest/finish` |
| **C7051** | 重复 key | 主路径与 `_iosbundled` stub 同键冲突（≥505 条时） | `MasterSummary.iosBundledPaths` |
| **C8100** | 未找到素材（recovery 对话框） | 缺文件 → 弹 recovery 框 | `AssetSufficiencyCheckLoadingTask.gotoAssetRecovery()` |
| **C8102** | 素材未发现（硬错误） | `enableAssetSufficiencyCheck=false` 时直接 throw | `FileReader.notifyFileNotFoundError()` |
| **C8601** | 指定的 Key 不存在 | 角色表 orderedmap 条目缺失 / RareScoreRewardTable 缺组 / k_id vs code | `MasterBinaryMap.getIndex()`、CDN orderedmap 表 |
| **F1009** | 空指针 null pointer | `party_slot` 无效值 | `get_mainCharacters()` → home scene |
| **F2032** | 未连网（IO Error） | 空 URL 或网络不通 | `URLRequest` 失败 |
| **H400** | HTTP 400 Bad Request | CN 请求格式与全球服教程插件不兼容 / 端点校验失败 | 日志 `[BATTLE] start failed` |
| **H404** | HTTP 404 / 端点不存在 | 未实现 API 路由 / Recovery 独立文件 `base_url+hash` 路径不存在 | `cn-server.ts` 注册 |

---

## 十二、构建管线与信标系统

### 12.1 构建脚本（拆分入口 + 子脚本模式）

| 脚本 | 步骤 | 耗时 | 场景 |
|------|------|------|------|
| `build-debug.sh` | 00→01→02→03→04→05→05→05b→05c→06 | ~70s | 全量构建（Step 02 已禁用——服务端修复替代） |
| `build-minimal.sh` | 同上，SKIP 04c+04d | ~70s | 最小验证（仅登录+信标） |
| `build-quick.sh` | 03→04→05→05→05b→05c→06 | ~35s | 增量构建（跳过 SWF 提取+导出） |
| `build-release.sh` | 00→01→04→05c→06 | ~30s | 生产构建（无信标） |

**构建流水线（入口 → 子脚本）：**
```
01-extract-swf.sh                          (仅提取 SWF)
02-export-targets.sh                       (FFDec 一次导出 8 类)
03-inject-beacons.sh → 03/03a/b/c          (信标注入 3 步)
04-patch-swf.sh      → 04/04a/b/c/d        (SWF 补丁 4 个: sdkDummy+apiServer+动画跳过+AttConfig跳过)
05-import-scripts.sh                       (FFDec 一次性导入)
05b-reverify-swf.sh                        (安全阀重验证)
05c-verify-markers.sh                      (全部补丁标记校验)
06-build-install.sh  → 06/06a/b/c          (打包/校验/安装)
```

| 步骤 | 文件 | 操作 |
|------|------|------|
| Step 00 | `00-verify-source.sh` | 验证源 APK |
| Step 01 | `01-extract-swf.sh` | 从 APK 提取 SWF（不修改） |
| Step 02 | `02-export-targets.sh` | FFDec 导出全部 8 个目标类（信标+补丁） |
| Step 03 | `03-inject-beacons.sh` → `03/03a-c` | 信标注入：URLLoader + CrashUtil import + 11 信标 |
| Step 04 | `04-patch-swf.sh` → `04/04a-d` | SWF 补丁：sdkDummy + apiServer + 动画跳过 + AttConfig跳过 |
| Step 05 | `05-verify-beacons.sh` / `05-import-scripts.sh` | 验证 .as 注入 / FFDec 导入回 SWF |
| Step 05b | `05b-reverify-swf.sh` | **安全阀**：从 SWF 重新导出验证 |
| Step 05c | `05c-verify-markers.sh` | **校验**：全部补丁标记，缺则中断 |
| Step 06 | `06-build-install.sh` → `06/06a-c` | 打包(zip+align+sign) + 校验 + 安装 |

### 12.2 统一配置（`scripts/config.sh`）

所有 build 脚本的唯一配置入口（值可被环境变量覆盖：`APK_SOURCE=xxx.apk bash build-debug.sh`）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `APK_SOURCE` | `sjdswy2025zxb.apk` | APK 源 |
| `OUTPUT_APK` | `wf-patched.apk` | 构建输出 |
| `KEYSTORE_PASS` | `worldflipper` | 签名密钥 |
| `ANDROID_SERIAL` | — | 目标设备（不设则跳过安装） |
| `SKIP_PATCHES` | `02a,b,c (默认)` | 空格分隔的跳过补丁列表 |
| `SKIP_PATCHES_DEFAULT` | 同上 | 全局默认（永远跳过 02 项） |

**补丁选中机制（`SKIP_PATCHES`）：**

| 场景 | SKIP_PATCHES 额外项 | 效果 |
|------|------|------|
| build-debug | （无） | 全部 4 个 SWF 补丁 + 11 信标 |
| build-minimal | `04c 04d` | 仅 04a+04b + 11 信标 |
| build-quick | 复用上次 | 同上次构建 |
| build-release | （无） | 全部 SWF 补丁，无信标 |

**保留补丁（`scripts/reserved/`，供单机版参考）：**

| 目录 | 内容 | 说明 |
|------|------|------|
| `reserved/bundle-fix/` | 02a/02b/02c | bundle stub k_id 替换（服务端转换替代） |
| `reserved/deprecated/` | 01b | 删除 bundle db/（完全废弃） |

### 12.3 Bundle Stub 修复策略（已废弃，保留供参考）

Step 02 (`02-fix-bundle-stub.sh`) 已被服务端 k_id→code 转换替代，子脚本移至 `reserved/bundle-fix/`。原方案精确替换 3 个 bundle stub：

| 操作 | 路径 | 替换内容 | 大小 |
|------|------|------|------|
| ✅ 替换 | `android_bundle/db/69828cac...` | 505 k_id CharacterTable data | 72,543B |
| ✅ 替换 | `android_bundle/25/859db198...` | 10 条通用 text stub（key 1-10） | 151B |
| ✅ 替换 | `android_bundle/cd/e548c4b4...` | 10 条 status stub（CDN 真值） | 1,092B |

10 条限制：≥505 条会触发 C7051（iosBundledPaths 合并机制）。

另一早期方案（Step 1b）**选择性删除** bundle.zip 内 db 目录：

| 操作 | 目录 | 文件数 | 含 C8601 根因？ |
|------|------|------|------|
| ✅ 删除 | `production/android_bundle/db/` | 13 个（含 `69828cac...`） | ✅ `character_iosbundled` stub |
| ✅ 删除 | `production/android_medium_bundle/db/` | 2 个 | 未知 |
| ✅ 删除 | `production/android_small_bundle/db/` | 1 个 | 未知 |
| 保留 | `production/bundle/db/` | 1 个（`add831d...`=logo.movie） | 标题画面需要 |

**原始 `android_bundle/db/` 13 个文件内容：**

| 文件 | 大小 | 类型 |
|------|------|------|
| `014b5943...` | 1033 B | 加密/二进制 |
| `13410042...` | 2735 B | 加密/二进制 |
| `3fbfe1f2...` | 273 B | 配置数据 |
| `69828cac...` | 465 B | **zlib 压缩** — `character_iosbundled` orderedmap（C8601 根因） |
| `82d11b09...` | 26 KB | MP3 音频（LAME 编码） |
| `8d2ff3b6...` | 77 B | 配置数据 |
| `b816f7bc...` | 94 B | 配置数据 |
| `c67310a0...` | 168 B | 配置数据 |
| `cd8f32bc...` | 176 KB | **PNG 图片** |
| `d385f906...` | 227 B | 配置数据 |
| `d3fc65f0...` | 454 B | 加密/二进制 |
| `dfac63cf...` | 133 B | 配置数据 |
| `f6b35832...` | 1.5 KB | **PNG 图片** |

### 12.4 AIR SWF 缓存机制

Android AIR 应用首次启动时将 SWF 从 APK 提取到私有缓存 `/data/data/com.leiting.wf/cache/app/<UUID>/`（SWF 缓存 + bundle 解压）。覆盖安装 APK 后**缓存不自动更新**——UUID 不变，旧 SWF 继续生效。

**所有 SWF 修改（apiServer、sdkDummy、isFullPackage、信标等）和 bundle.zip 修改必须清除缓存后才能生效。**

清除方式：
- 手机设置 → 应用 → 世界弹射物语 → 存储 → **清除缓存**（不丢失 CDN 数据）
- 或 adb：`rm -rf /data/data/com.leiting.wf/cache/`

**切勿使用"清除全部数据"——会丢失已下载的 CDN（10GB）。**

### 12.5 ADB 安装策略

- **必须**设置 `ANDROID_SERIAL` 环境变量，否则构建跳过安装。
```bash
# 指定设备后构建并安装
ANDROID_SERIAL=<DEVICE_IP>:5667 bash scripts/build-debug.sh
# 或构建后手动安装
bash scripts/build-debug.sh
adb -s <DEVICE_IP>:5667 install -r wf-patched.apk
# 增量构建（修改 beacon 后）
ANDROID_SERIAL=<DEVICE_IP>:5667 bash scripts/build-quick.sh
# 生产构建（无信标）
ANDROID_SERIAL=<DEVICE_IP>:5667 bash scripts/build-release.sh
```

### 12.6 信标系统（11 个）

| 信标 | 目标类 | 作用 |
|------|------|------|
| `function debugBeacon(` | CrashUtil | 信标发送方法定义 |
| `debugBeacon("ERR:"` | CrashUtil | 错误码上报 |
| `RD:servertime check` | ResponseData | 响应时间戳校验 |
| `RD:viewer_id check` | ResponseData | 用户 ID 校验 |
| `GL:loadedHandler START` | GlobalLoading | 加载数据到达 |
| `GL:applyLoad START` | GlobalLoading | 资源加载决策入口 |
| `GL:startLoading START` | GlobalLoading | 开始加载资源 |
| `GL:completeHandler START` | GlobalLoading | 全局加载完成 |
| `GL:notifyComplete START` | GlobalLoading | 加载通知完成 |
| `RMB:init slices=` | RootMasterBinary | 角色表 binary slice 数量 |
| `RMB:getIntMap entries=` | RootMasterBinary | 角色表解析条目数 |

**信标含义：**

| 信标值 | 含义 |
|------|------|
| `RMB:init slices=0` | CharacterTable 文件未找到 |
| `RMB:init slices=1` | 找到 1 个 binary slice |
| `RMB:getIntMap entries=0` | 解析出 0 条目（格式不兼容） |
| `RMB:getIntMap entries=505` | 解析出 505 条目（正常） |

**监控命令**：`tail -f /tmp/cn-server.log | grep BEACON`

### 12.7 当前构建配置

**SWF 补丁（Step 1）：**

| 补丁 | 目标 | 方式 |
|------|------|------|
| `sdkDummy = true` | `DevConfig.as` | sed |
| `apiServer` → `<LAN_IP>:8001` | `DevConfig_gf_android.as` | sed（去除 `http://` 前缀） |

**信标（Step 3）**：11 个信标注入 5 个目标类。**未注入**：`enableAssetSufficiencyCheck = false`（已移除）。
**Bundle（Step 1b）**：默认不修改，需手动在 `build-debug.sh` 中启用。

**服务端变更：**

| 变更 | 文件 |
|------|------|
| `enable_newbie = false` | `cn/load.ts` |
| `files_list` → 正式 CSV | `cn/asset.ts` |
| `TOTAL_SIZE` 动态计算 | `cn/asset.ts` |
| tutorial stub（`update_step`/`finish_trigger`） | `cn-server.ts` |

### 12.8 构建文件索引

| 文件 | 职责 |
|------|------|
| `scripts/build-debug.sh` / `build-quick.sh` / `build-release.sh` | 全量 / 增量 / 生产构建主入口 |
| `scripts/config.sh` | 统一配置入口（APK 源、签名、设备、SKIP_PATCHES） |
| `scripts/steps/01-patch-swf.sh` | SWF 补丁（sdkDummy+apiServer+isFullPackage） |
| `scripts/steps/01b-remove-db-stubs.sh` | 删除 bundle db stub（已移 reserved） |
| `scripts/steps/05b-reverify-swf.sh` | SWF 重验证安全阀 |
| `scripts/steps/06-build-install.sh` | APK 打包+签名+安装 |
| `scripts/beacons/` | 11 个 Python 信标注入脚本 |
| `scripts/reserved/bundle-fix/` | 客户端 bundle stub k_id 替换（单机版参考） |

---

## 十三、当前服务端配置状态

```
src/routes/cn/asset.ts:
  is_initial: true
  target_asset_version = resVer ?? highestDiff
  client_asset_version = resVer ?? null
  full.version = "1.4.0"
  sha256 = "" (不校验)
  diff 独立于 full 列表

src/routes/cn/load.ts:
  available_asset_version = resVer ?? "1.4.0"
  dailyResetPlayerDataSync() ✅
  collectPlayerDataPooledExpSync() ✅
  wrapOptionFields() 补全 30+ CN 字段
  enable_newbie = false

src/cn-server.ts:
  isFullPackage: false (不设定)
  fullResourceVersion: 不覆盖
  /debug + /crash 端点 ✅
  /tutorial/update_step + finish_trigger stub ✅
  /channels/channel_leiting_pay/query_unfinish_order stub ✅

.env:
  CDN_BASE_URL = http://<LAN_IP>:8001/patch/cn
  CN_LISTEN_HOST = 0.0.0.0
  CN_LISTEN_PORT = 8001
```
