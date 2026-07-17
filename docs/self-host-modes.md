# 自建服 · 玩「深渊连战 + 15 把深渊武器 + 双新角色」完整指南

面向**已经有(或能自己搞到)一套能跑的 WF CN 私服**、想在其上加载两个自制模式、深渊武器和两位自制角色(苍海龙王·赛瑞斯 / 夏日女神·史黛拉)的人。本 mod 只提供**增量**(数据 + 客户端补丁),不含官方基础 CDN。

## 先备齐

| # | 东西 | 说明 |
|---|---|---|
| 1 | 一台 Linux 服务器 + 一个域名 | Node ≥ 20;联机/CDN/证书需要域名(纯本地内网玩可简化,见步骤 3) |
| 2 | 本仓库 `release/modes-20260714` 分支 | **本 mod 的全部增量**:两模式+武器 masterdata(`assets/*.json`,服务端直接读)+ `client-patch/` 客户端改造工具 |
| 3 | **CN 基础 CDN(~11GB)自备** | 官方源 `shijtswydl.leiting.com` **已停服**,需自行从 WF 私服圈/现有部署获取,放到 `.cdn/cn/`。**服主不分发这个,只发上面的增量**;已有能跑的 WF CN 私服的人此项已具备 |
| 4 | 官方 CN 客户端 APK(1.8.1)+ FFDec + keystore + Android build-tools | 自己重打客户端用(步骤 4) |

---

## 步骤

### 1. 拿代码

```bash
git clone -b release/modes-20260714 https://github.com/kuronzzhan-droid/startpoint-cn.git starpoint-cn
cd starpoint-cn && npm install
```

> 必须是 `release/modes-20260714` 分支。默认 `main` 没有这两个模式。

### 2. 基础 CDN(自备)+ 本 mod 增量(随代码到手)

- **基础 CDN(~11GB)**:确保 `.cdn/cn/` 已就位(目录结构与校验见 [`docs/cdn/overview.md`](cdn/overview.md))。官方源已停服,本 mod **不分发**基础 CDN——需你自行从 WF 私服圈/现有部署获取。已有能跑的 WF CN 私服的人跳过此项。
- **本 mod 的增量(①+②两层都在分支里)**:
  - ① **服务端层**:两模式和武器的 masterdata 在 `assets/*.json`(服务端直接读)。
  - ② **客户端层**:深渊武器/兑换商店/rush 700099 的客户端 orderedmap 数据,已打包成 **`assets/asset-patch/active/pinball-1.4.90→1.4.101-mod*.zip`(11 个,git 跟踪)**,服务端 `asset.ts` 会自动 serve、`manifest.json` 已 enabled 到 1.4.101。**这层缺了 → 打完 15 轮或开兑换商店会 C8601**(客户端没有武器/商店主数据)。
  - ⚠️ **前提**:你的 base CDN 必须接到 **1.4.90**(这条增量链的起点),客户端才能续上 1.4.90→1.4.101 拿到 ② 层。base CDN 版本不到 1.4.90 的话这段接不上。
  - ③ **双新角色层(1.4.102→1.4.103)**:`assets/asset-patch/active/pinball-1.4.102-1.4.103-*-charpkg*.zip`(7 个分包共 28MB、164 个 payload,git 跟踪;同一版本跨越拆多包,客户端按 get_path 列表全部下载)——赛瑞斯(129999)与史黛拉(139999)的全部客户端资产:16 表克隆数据、UI、像素动画、语音、技能 DSL、独有状态图标。打完模式链的客户端自动续上这层。服务端侧的四张角色表已在 `assets/*.json` 里随分支到手。

### 3. 起服

按 [`docs/deployment.md`](deployment.md) 走(Node 20 + nginx + 域名 + Let's Encrypt + `.env` + TCP 联机口 8003)。

- **公网开服**:照 deployment.md 全套(nginx 反代 + HTTPS + 域名)。
- **本地/内网自己玩**:可简化——`.env` 里 `CN_LISTEN_HOST=0.0.0.0`,客户端直接重定向到 `<你的内网IP>:8001`(见步骤 4),省掉 nginx/域名/证书。

### 4. 打你自己的客户端(**四合一补丁**)

自建服要连**你自己的**服,客户端必须打四个补丁。拿官方 CN APK,用 FFDec 把主 SWF 导出为 AS3 目录(记为 `EXPORT_DIR`),依次应用:

```bash
# ① 免登录 + ② 重定向到你的服(改 DevConfig 两处)
bash client-patch/apply.sh <EXPORT_DIR> <你的host:port>     # 如 192.168.1.10:8001

# ③ 深渊装备战斗门控(否则武器装上不生效!)
python -X utf8 client-patch/abyss-mode-equipment/patch.py \
  --source <EXPORT_DIR>/pinball/common/data/character/BattleCharacterLogic.as \
  --output <EXPORT_DIR>/pinball/common/data/character/BattleCharacterLogic.as
```

①-③ 改完后用 FFDec 把 AS3 导回 SWF。接着打第四个补丁——它作用于 **P-code 层**(FFDec 的 pcode 导出,不是 AS3 源):

```bash
# ④ 赛瑞斯双形态 P-code(特殊演出预载/双形态动画/湿润雷伤终乘/退场充能/弱化延长)
#    不打的话:客户端播放赛瑞斯特殊演出会硬崩!
python -X utf8 client-patch/dual-form-v1/build_patch.py \
  --baseline-swf <上一步导回的主SWF> \
  --baseline-pcode-root <FFDec对该SWF的pcode导出目录> \
  --ffdec-jar <ffdec.jar> --output-dir <空输出目录> --profile-dir <FFDec配置目录> \
  --manifest client-patch/dual-form-v1/patch-manifest-seris-combat.json
```

最后把产出的 SWF 替换进 APK、`zipalign` + `apksigner` 重签名、安装。
`client-patch/abyss-mode-equipment/build_apk.py` 提供了打包+回读验证的一体化脚本(参数见其 README)。

> ‼️ 已发布的 [`WorldFlipper-abyss.apk`](https://github.com/kuronzzhan-droid/wf-abyss-client/releases) 是给"连某个固定服"用的,**自建服请自己重打**指向自己域名的客户端——那个现成包对你没用。

### 5. 发放两位角色(服务端管理后台)

角色数据到位后玩家不会自动拥有,用管理后台邮件发放:打开 `http://<你的服>:8001/admin` → 邮件页 → 附件类型选「角色」,ID 填 `129999`(赛瑞斯)发一封、`139999`(史黛拉)再发一封 → 玩家进游戏从邮箱领取。

### 6. 进游戏验证

- **模式**:Rush 活动 **700099「深渊连战」** → 打每轮 boss 掉武器/攒代币 → 兑换商店换 15 把深渊武器 → 装上进 700099 / 挑战 2001 / 练习关生效。
- **角色**:邮箱领取 129999/139999 → 角色页查看面板(词条/队长技完整显示,立绘居中) → 赛瑞斯放技能进「龙王显形」(双形态动画+湿润上敌,需④号补丁) → 史黛拉当队长打一场(能力攻击体系)。

---

## 已有部署如何升级(存量服)

已经跑着一个 WF CN 私服(上游 startpoint-cn 或旧版本)想加上两模式+双新角色,不用从零来:

1. **换服务端代码**:`git remote add kuron https://github.com/kuronzzhan-droid/startpoint-cn.git && git fetch kuron && git checkout -b release/modes-20260714 kuron/release/modes-20260714`,然后 `npm install`、重新构建、重启。**数据库零迁移**——本分支不改表结构,原 `.database/` 和全部玩家存档直接沿用。
2. **数据自动下发**:服务端 masterdata 和客户端增量链都随分支到手(见步骤 2),重启后自动 serve。base CDN 须到 1.4.90;玩家客户端不论卡在哪个版本(含 1.4.101 撞车位),桥接包会把它推进到链尾,重启游戏即触发下载。
3. **重打客户端(唯一的人工大步)**:按步骤 4 打**四合一**,②重定向填你们**已有的**服务器地址。存量服的旧客户端只有①②——缺③=深渊武器装上不生效,缺④=赛瑞斯特殊演出必崩。
4. **换包与账号**:新 APK 签名与旧包不同时玩家须卸载重装,**本地客户端身份会被抹掉、下次登录开新号**;服主可在管理后台按 device_id 把老存档重绑,或重打时沿用旧包同一个 keystore(可覆盖安装,身份保留)。**全员换完包再发角色**——数据与客户端补丁必须配套。
5. **发角色 + 验证**:同步骤 5/6。

### 通用桥接:玩家客户端卡在任意版本 V(接不上增量链)

症状:服务端数据都在,但客户端开兑换商店/邮件领角色报"资源损坏"(C8601 换皮),
`get_path` 对该客户端版本返回空 diff——客户端经别的 CDN 血统到了链外版本(桥接包只救 1.4.101)。

修法按你的**血统**分两条路(2026-07-17 野外实证后修订):

**先判断**:你的基础 CDN/客户端表是不是**跟着本指南**走的(基线 ≤1.4.101 等价内容)?
还是来自**别的私服血统**(基础表内容比本链新,比如经别家更新链到了 1.4.1xx)?

**A. 基线血统 → 整表替换救援(一跳 9 包)**:

```bash
cd assets/asset-patch/active
V=1.4.123        # ← 换成你玩家客户端实际卡住的版本
W=1.4.124        # ← V 的下一号
cp pinball-1.4.101-1.4.102-1-mod07142258.zip "pinball-$V-$W-1-mod07142258.zip"
for i in 1 2 3 4 5 6 7; do
  cp "pinball-1.4.102-1.4.103-$i-charpkgmod07161121.zip" "pinball-$V-$W-$((i+1))-charpkgmod07161121.zip"
done
cp ../archive/pinball-1.4.90-1.4.101-9-modassets07170102.zip "pinball-$V-$W-9-modassets07170102.zip"
```

服务端自动感知目录变化(重启更稳妥);`get_path` 带 `res_ver: V` 应返回一跳 9 个 zip。
⚠ 此路对基线血统外的部署是**破坏性**的:桥接 6 表/角色 16 表是整表替换,会抹掉你血统
自己的活动/商店/角色行(实测:外血统换上后活动页/领主战直接「数据不足」瘫痪)。

**B. 外血统 → 行级合并,禁止整表替换**:

> ⚠ **前提 0(2026-07-17 野外事故后补明)**:mod-tools 的 **store(数据包)基线必须等于你目标
> 客户端的当前版本**。`wf_publish` 是整文件发布——store 里的表是什么状态,发出去客户端就被
> 覆盖成什么状态;用落后的 store(如 1.4.54)对 1.4.125 的客户端发布 = 把表滚回 71 个版本,
> 版本间隙里官方加的 key 全部丢失(实例:item 表缺 10000140 → 仓库 C8601)。
> store 落后时先刷新,两个办法任选:
> - **从你自己的 base CDN 重建**:把 `.cdn/cn/archive-common-full` 和 `archive-common-diff`
>   里的 zip **按版本升序**依次解压到同一目录(后解压覆盖先解压),得到的 `production/upload`
>   树就是链尾基线的 store(表数据全在 common 变体,跑数据工具足够;要编辑语音/立绘再按同法
>   叠 android 链),把 profiles/WF_TARGET_STORE 指过去;
> - **从设备拉**:任何一台跟着你的服更新到当前版本的设备/模拟器,
>   拉 `/sdcard/WorldFlipper/dummy/download/production/upload` 整目录。

1. **纯资产补充包对任何血统都安全**(`archive/pinball-1.4.90-1.4.101-9-modassets07170102.zip`,
   30 个全新路径文件:武器图/横幅/商店图,不含任何表),重命名成你的一跳直接发;
2. 深渊行数据用 [mod-tools](https://github.com/kuronzzhan-droid/startpoint-cn-mod-tools) 在
   **你自己的数据包**上生成(全部行级写入,不动你的存量行):
   `wf_rogue_rewards / wf_rogue_build / wf_rogue_shop / wf_rogue_banner`(武器/掉落/兑换商店/横幅)
   + `wf_chain_build`(700099 楼层写进你的 floor 表);
3. 双新角色不要照抄 charpkg 整表,用角色包工作流(`wf_release` / `wf_character_flow`,
   见工具仓 docs/角色包工作流.md)把 129999/139999 装进你的表;
4. `wf_publish --from-ver <你的当前版本>` 把以上发布成**你自己血统**的增量。

通用备注:救援后你的玩家停在自己的号位,**日后上游再发新内容链时需重做对应步骤**;
修完仍有「数据不足」→ 复现一次,把服务端 `logs/http404.log` 新增的 404 路径发给上游定位。

---

## 内容速览

- **深渊连战(Rush 700099)**:自制无尽/roguelike 活动,每轮不同 boss,通关掉落。
- **15 把深渊武器(`8000101`–`8000115`)**:每属性 2 把 + 通用 3 把,故意超模;代币 `2370099`,兑换商店。
- 门控白名单:武器/能力魂只在 `Rush 700099` · `挑战 2001` · `练习 1–97` 内生效,其余关卡与官方一致。
- **苍海龙王·赛瑞斯(129999,水,★5)**:双形态龙王。技能「苍海雷狱」双属性全屏+麻痹/气绝/湿润+进入「龙王显形」42 秒(全队攻/能伤+300%、技/直伤+300%、充能+50%、贯穿、弱化免疫、速度固定);与雷系互协力时视为雷系。
- **夏日女神·史黛拉(139999,光,★5)**:能力攻击辅助。全队按能力攻击次数滚雪球叠攻/能伤,开幕全队满槽,主位光属性能力伤害引擎。

## 常见坑

- 客户端**只打了免登录+重定向、漏了深渊门控** → 能进服、能拿到武器,但装上在战斗里不生效。
- 客户端**漏了④双形态补丁**但服务端有角色数据 → 领赛瑞斯没事,但他的特殊演出播放即崩;湿润雷伤加成也不生效。四个补丁都要打。
- **没放 CDN 或版本不全** → 客户端卡加载/报错。CDN 是必需的,不是可选。
- 客户端读到自制数据但**没打对应补丁**(如深渊/随机塔/双形态)可能崩 → 数据与客户端补丁要配套,全员换包后再发数据。
