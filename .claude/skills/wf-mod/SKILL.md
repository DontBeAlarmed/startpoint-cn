---
name: wf-mod
description: >-
  世界弹射物语(World Flipper)CN 国服(雷霆)私服的数据修改 + 发布 + 生效全流程工具链。
  当用户想改任何 WF/世界弹射角色数据——词条(ability)、技能倍率、基础数值(HP/ATK)、
  觉醒加成、能力魂(ability_soul)、队长技(leader_ability)、技能能量(action_skill)、
  角色资料(名字/稀有度/元素/描述)、解除主位限制——或想把改动发布到客户端、管理 startpoint-cn
  服务端、同步到 MuMu 模拟器、排查"改了没生效/客户端没更新/全量重下"时,都用这个 skill。
  即使用户只说"改一下火龙的攻击力""把某角色技能改强""发个 mod 包"而没提具体工具,也要用它。
  项目根:D:\WF\startpoint-cn。
---

# 世界弹射物语(CN)Mod 工作流

把「改数据 → 发布 → 客户端生效」固化成可复用流程。所有工具已就位于 `mod-tools/`,
字段语义已完整逆向(见字段手册)。你的任务是根据用户诉求走完整链路,而不是重新摸索。

## 0. 项目常量(硬记)

| 项 | 值 |
|---|---|
| 项目根 | `D:\WF\startpoint-cn` |
| 数据包 store | 由 `mod-tools/profiles.json` 的 active 档案决定(当前锁 `cn` = `弹国服/.../upload`) |
| 服务端 | `http://192.168.0.130:8001`(LAN IP,见 `.env`),启动用 `start-cn.bat` |
| 模拟器 | MuMu 12,adb=`D:\WF\MuMuPlayer\nx_main\adb.exe`,device=`127.0.0.1:16384`,包名=`com.leiting.wf` |
| CDN mod 目录 | `.cdn/cn/archive-common-diff/`(发布的 diff 包落这里) |

Python 脚本统一在 `mod-tools/` 下运行(cwd 建议为项目根)。输出中文时终端可能乱码,
用 `python -c "import sys,io; sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8',errors='replace')"` 包一下即可,路径实际正确。

## 1. 两层数据架构(决定改哪、怎么生效)

| 层 | 位置 | 改后生效 |
|---|---|---|
| **① 服务端层** | `assets/cdndata/*.json`(character.json / character_text.json…) | 重启服务端,客户端 `/load` 拉取。**不走 CDN、不走 adb** |
| **② 客户端层** | 手机包 `弹国服/.../upload/<xx>/<hash>`(ability / status / skill 等 orderedmap) | **必须经 CDN 下发**(见第 4 节)才在游戏内生效 |

战斗数值、词条、HP/ATK、技能全在 ② 层;名字/描述/稀有度显示在 ① 层。
**关键教训**:② 层直接 adb push 到 sdcard **不生效**——客户端只认服务端 CDN 下发的版本。改 ② 层一律走 `wf_publish.py`。

## 2. 核心工作流(改 ② 层数据的标准三步)

```
改数据(dry-run 预览 → 写入 + 自动备份)
  → python mod-tools/wf_publish.py --tables <表名>   # 打增量包到 CDN
  → 用户重启 start-cn.bat + 重启游戏                  # 客户端增量下载生效
```

(GUI 里等价一键:右上角「发布并重启游戏」= 发布 pending + adb 重启游戏,POST `/publish`。)

**改数据的三种方式**,按场景选:

- **网页修改器(交互式,推荐给用户自己用)**:`python mod-tools/wf_gui.py` → 浏览器
  `http://127.0.0.1:8765`(8765 常被输入法占用,自动落 8766 等备用口,看启动输出)。
  顶部导航按**角色/武器/全局/系统**四组分区(左栏带角色头像+元素角标,`/` 键聚焦搜索)。
  角色模式:词条编辑(单条主位开关/删行,**基础行与觉醒行
  分区**) / 角色资料(**三层同步**:rarity/element 等 master 字段与文本同时写 ①层 cdndata
  + ②层 character/character_text 表 + `assets/character.json`;底部有**单角色一键快照/还原**
  =②层7表+①层+资产+DSL 打包 zip;底部「**共鸣通用(OmniElement)**」开关=character 表 c5 加/去
  OmniElement 标签,配合 client-patch/omni-element 客户端补丁后该角色匹配**任意元素**的
  共鸣/编成/[限X属性]条件(元素组匹配是严格等值,数据层无通配,详见补丁文档;无补丁时标签无害);
  「**一键通用共鸣**」/共鸣通用开关(端点 `/omni_convert` 或 `/omni_element/set`)=**只挂
  OmniElement 标签(c5),不改 element**——角色保留真实元素(伤害/克制/UI 不变),经
  client-patch/omni-element 补丁(3 处含副位)计入**任意元素**的共鸣/编成/[限X属性];
  dry-run 附属性配对检查报告。⚠ **element=6(真无属性)已禁止**:2026-07-12 实测
  element=6(Colorless 是敌人专属元素)给可玩角色会崩(C7050:forceUncolorless 硬抛+
  连锁数组越界,补丁救不了),已回滚;save_char_fields 硬拦截 element=6、元素下拉去掉「通用」。
  引擎不支持可玩角色「无属性」,方案见 `mod-tools/docs/通用属性方案.md` §0) /
  **角色资产**(2026-07-12 改**三栏**:立绘·UI(ui/+battle 配套)/像素图·pixelart/语音·voice,
  按逻辑路径前缀分栏;像素图栏顶部「**像素图数据**」区 = atlas 排布/frame/timeline 六文件
  **页内 JSON 编辑 + 外部文档上传**(.json 自动编码 AMF3+deflate,.amf3.deflate 原样;
  端点 `/pixelart_data|/pixelart_data/save`,容器 raw deflate(-15),全库字节级往返实测)
  + 「**预览动画**」= timeline+atlas+sprite_sheet 现场拼装(播放/单帧步进/倍速/像素缩放;
  帧号→图块 = `{frame.name}%04d` 缺号保持上一张;fx,fy 为 Starling 负裁剪偏移,
  内容位置=(-fx,-fy);r=旋转存储 rotate(-90°) 还原,与商店切图同规则)。
  ⚠ datamine 的 `fullshot_resized`(500×500)是提取器预览产物,**非游戏资产**,导入照旧跳过。
  顶部有**立绘定位**区:立绘 PNG 是**裁剪图**,`generated/character_image`
  嵌套表(内层0/1)存 内容框x,y=画布内偏移+w,h=**必须等于 PNG 实际宽高**(换不同尺寸立绘
  不更新会错位,「按图自动」一键修);`character/full_shot_image_attribute` 嵌套表存
  pivot_x,pivot_y,scale=**详情页标准立绘位置**(image.x=-pivot*scale)+face_x,face_y=
  **概览页脸部居中点**(偏移=scale*(pivot-face));画布 1440×1920;
  端点 `/char_image_pos|/char_image_pos/save`) /
  (立绘/觉醒立绘/cut-in/图标合集/像素图/头像4组/缩略图3组/战斗UI/连锁cut-in/
  剧情横幅/**story 表情差分**/**语音全量 ally·battle·home·words**(story/words 来自
  `WF_PATHLIST_recovered.txt` 枚举+store 探测)/配套数据,预览+上传替换+尺寸校验;
  **cut-in 特例**:战斗真机只读配对 `skill_cutin_N.atf.deflate`(android 根,ETC1 纹理)
  不读 PNG,替换 PNG 时 GUI 经 `wf_atf.py` 自动重编码 ATF(手动:`python mod-tools/wf_atf.py
  --regen character/<code>/ui/skill_cutin_0.png`);android 根 996 文件实测**全部是 cut-in ATF**,
  其他图无 ATF 配对,换 PNG 即生效;
  **裁剪图 trim 铁律**(2026-07-12 逆向 TrimmedImageRepository/ViewAssetCache):
  `master/generated/trimmed_image`(平表 11778 键,键=图逻辑路径不带 .png,行=x,y,画布w,画布h)
  给 story 表情差分(9792)/skill_cutin(996)/full_shot 立绘(990)的纹理套 frame——
  **换不同尺寸的这三类图必须同步该表,否则游戏内错位/出框**(语音图标等其余资产不在表内)。
  full_shot 的 x,y 与 character_image 表同值(980/980 实测),两表须一起写。
  GUI 替换资产/保存立绘定位时已**自动同步**(保持内容框中心;发布别名 trimmed_image);
  **MP3 严格校验**(wf_assets.mp3_encode):逐帧复核转换覆盖到文件尾+码率恒定,
  VBR/损坏/半截文件直接拒收(报错带 ffmpeg 转码命令;官方语音 400 抽样全 CBR 不误杀)——
  此前半转换文件(前半存储态后半标准态)是"换语音崩溃"的根因;
  顶部「**资产包导入**」= datamine 解包目录一比一批量替换,`POST /asset/import_pack`;
  「**一键导出全部资产**」=`GET /asset/export_char` 整角色打包 zip:character/<code>/ 全量
  (立绘/图标/**点阵像素**/语音/story差分/配套数据)+ 战斗特效动画(**DSL 内 SpecifyEffectDirectly
  提取+哈希探测**,补 pathlist 75% 复原盲区)+ cut-in ATF + 技能/PF DSL;PNG/MP3 解混淆,
  目录树与资产包导入一比一互通,落盘 work/asset_exports/) /
  基础数值 / **技能·倍率**(名称+游戏内效果描述+能量直改,级别移植/删除,整技能替换,
  「**效果词条**」=命令级结构化编辑器(2026-07-12):命令卡片树(嵌套 Block 递归),
  改参数/删除/复制/上下移/**从全库 1024 个技能的命令实例检索插入**(如借别人的
  CreateCondition 加 buff、加伤害段);签名表 `wf_dsl_sig.py`(自反编译 AS3 生成:
  111 命令+6 事件+46 枚举类构造签名,同名命令参数个数全库唯一;42 种 `AC*` 状态词条
  =CreateCondition p2 列表元素,常见三参=[持续帧,强度,层数],0.5=50%、60帧=1秒);
  前端字面量保持 JSON 解析器(int/double 按原文 3/3.0 不失真,无改动保存=字节级一致),
  保存走 `/skill_dsl_json/save`;端点 `/skill_sig`(静态签名)+`/skill_cmd_lib`
  (命令库,name/q 过滤,按 action_skill mtime 缓存),
  「效果参数」=ActionDsl 数值原地补丁,「**JSON**」=整树 JSON 编辑可**增删效果命令**
  (`wf_dsl.encode_amf3` 全库 1035 文件字节级往返验证;int/double 靠 3 与 3.0 区分),
  「**上传效果**」=外部写好的效果文件直接替换该级别(.json=技能JSON格式/.amf3·.deflate=
  二进制自动识别,官方未下发的文件=新建;形态切换区另有**变体效果文件上传**,
  端点 `/skill_dsl_upload`,kind=main/switch),
  「**强化弹射**」区(2026-07-12 逆向落地):角色 PF 种类 = character 表 **c6 speciality_type**
  (0剑士knight/1格斗fighter/2射击ranged/3辅助supporter/4特殊special,同时决定类型图标),
  页内下拉直改;种类定义表 `master/skill/power_flip_action.orderedmap`(键=种类,行=3级动作
  DSL 路径)——**store 里是增量部分**,knight 等基础键在 **APK 内置 base 表**(客户端
  RootMasterBinary 把多文件 union,**键重复=ClientError 7051 崩溃** → 新键禁用标准名);
  DSL 文件**下载 store 优先于 APK 内置**(FileReader.resolveFiles)→「提取到可编辑」按钮把
  内置文件原样字节提进 store 后即可用「效果词条」编辑(PF 动作与技能同为 ActionDsl,
  supporter 的 PF 就是给全队上 3 个 CreateCondition);「克隆新建」= 3 文件复制新路径+表加键,
  **自定义种类激活 = 队长词条 powerflip_override**(效果块 id=表键/levels="1,2,3"/
  description_id,官方例 leader 121177 行4;levels 单元格含逗号带 CSV 引号=官方惯例);
  APK 取 WF_APK 环境变量 > 弹国服/*.apk 最新;端点 `/powerflip|/powerflip/spec|extract|clone`。
  ⚠ PF 定义全局共享:改标准种类=所有该类型角色一起变,只改一个角色用 新建种类+override。
  「**形态切换**」区 = character 表 col9-16(HpHigh/ConditionExist/MultiballNumber/
  ChangeSkillFlag/IsUnison,切换目标限 switched_action_skill 表现有 6 键);
  注意个别角色技能行是**官方短行**(仅名称/描述,无 program_path,如 161177)或效果文件
  官方未下发(如 alk 基础技),效果参数/JSON 按钮自动置灰,只能整技能替换) /
  **Boss·副本**(双模式可见:boss_level 数值编辑 531 条,HP=基础值×等级曲线,改基础值=等比调血;
  22 类全副本列表,quest→field_data→zone 自动解析 boss,点 boss 名定位编辑;后端 `wf_boss.py`,
  quest 系三层压缩索引读写用 `wf_quest_lib.py`) /
  词条移植 / 词条速查 / **JSON 直改**(全局页签,双模式可见:任意支持表整键的 JSON 视图直接编辑,
  ②平表=`[[列,...],...]`可增删行、②嵌套表=`{内层键:[[...]]}`内层键序不可重排、①cdndata=原生节点;
  词条/数值/技能/资产/武器页均有「JSON」按钮带键跳转;端点 `/raw_json|/raw_json/save`) /
  **特殊效果**(固有状态 `master/character/unique_condition` 表 21 键:c0=string_id c1=名称
  c2=图标路径 c3=持续帧(99999999=永续) c4=最大层数;图标 `battle/common/unique_condition/
  <sid>.png` **48×48**;页内可改名称/持续/层数、换图标、**新增条目**(新图标写全新 store 路径);
  词条引用=unique_condition_id 列填表 ID,赋予枚举 461/消耗 525) /
  **商店**(Boss币商店**三处同步写**:②层 `master/shop/boss_coin_shop`(客户端显示,50列,
  c6名称/c10描述/c17-18货币+价格/c25-26时间窗/c28+c31库存/c32-34奖励type·id·数量)+
  ①cdndata/boss_coin_shop.json(②层的 JSON 镜像,已验证 6566 键 100% 一致)+
  服务端 assets/boss_coin_shop.json+类目映射(get_sales_list/buy 校验);改价/改奖励/克隆新增,
  保存后②层走发布、服务端侧点「推送服务端」即时生效。
  (历史注:商店表 desc 含换行曾须专用 `_read_ml/_write_ml`;2026-07-12 起
  `core.read_csv_lines` 已改为 csv.reader 全文本解析,**多行单元格全局安全**——
  此前旧实现按物理行拆,克隆时把 character_text 14 行/character_speech 474 行官方
  多行行写坏 → 客户端 U0000(CharacterTextValues parseUtf8Bytes),已按备份修复;
  selftest 新增「CSV 多行单元格往返(4 表全量)」回归项) /
  **新建角色**(克隆模板→
  全新 ID,可勾「资产独立」=新 code_name+全套资产复制+独立 action_skill,金丝雀流程见页内;
  **2026-07-12 金丝雀实测通过**:111165→119999 零拷贝克隆+OmniElement,邮件发放→领取演出→
  角色一览→详情页(技能/队长技/词条描述)全链路客户端零崩;⚠ 途中揪出的雷:
  ①CSV 多行撕裂(见上);②ability 表 3310041/3310061/2310071 行 c97=22(During 触发需
  trigger_puller)但 c98 空 → 开角色一览 C7050「不存在的构造函数」——那是 0712 13:58 前
  批量词条写入埋的雷,与克隆无关,已补 c98='0';排查手段=离线复刻 AbilityValues.parseAt97/98
  路由扫全表(反编译源在 D:/WF/wf-re-workspace/decompile);**词条组装时凡 During(c5=1)
  触发 c97 落在需 puller 的 case,c98 必填 0-10**) /
  **工具箱**(长任务后台子进程+进度轮询,同时只跑一个,输出均在 store 外:
  **全链路自检**=`wf_selftest.py` 环境检测+功能模拟(deep=金丝雀写入闭环,~3 秒 21 项)、
  **全量解密导出**=`wf_export_assets.py` 全包解密建逻辑目录树、**路径表复原**=
  `wf_recover_pathlist.py` 重建 WF_PATHLIST_recovered、**数据包还原**=
  `弹国服/wf_restore_package.py` 自举复原;端点 `/toolbox/run|status|cancel`) /
  配方 / 改动日志(一键回溯) / 备份。武器模式:**武器·魂珠**(436 件装备含 12 主线魂珠,
  强化词条+同键魂珠效果一页编辑,均可增删改) / Boss·副本 / 速查 / 配方 / 工具箱 / 日志 / 备份。
  魂珠独立页签已删除;S: 键跳转自动进武器模式。
  左栏**角色/武器模式切换**:角色模式隐藏武器词条页,武器模式只留武器/魂珠/速查/配方/日志/备份;
  武器列表 = **全部 424 把**(按属性检测分组:六属性+通用,可筛选),无强化词条的引导去同键魂珠。
  装备映射:`master/item/equipment.orderedmap` 436 键(c1=中文名 c2=kind 0武器1魂珠 c8=品质
  c10=soul_id)与 ability_soul **同键一一对应**;`equipment_enhancement` 29 键 c2=改造名。
  **添加词条行**:词条编辑/武器页每组「＋添加行」= `POST /append_line_adapted`,复制其他键的行并
  **自动适配目标**(元素→目标属性、sid 统一、觉醒门槛清零、武器解锁等级对齐 = U0000 铁律自动化)。
  **词条工坊**(2026-07-12):词条/武器/魂珠每行「工坊」+每组「🛠 组装词条」+速查页每结果「工坊」
  = 结构化组装/编辑单行——按 ability_enum_map 块布局分区表单(头部/前置条件1-3/触发/效果,
  触发方式切换 瞬发/持续/开幕),五大枚举可搜索下拉(中文+使用次数排序)、单位换算提示
  (1000=1%、100000=1次、帧×100000)+**快捷输入**(15%→15000、3次→300000)、
  实时中文效果预览(`/composer/describe`);可拿**全库任意词条当模板**(搜索=/search_abilities,
  行选择带逐行中文描述;跨表仅 角色词条↔队长技 自动列重排 `as_key` 参数);
  编辑模式有「另存为追加新行」;**缺失槽位可新建整键**(角色 abilities 引用了但表中没有的键,
  create_missing);底层状态=完整行(未逆向列原样保留),写入=追加或覆盖行。
  单元格禁引号/换行;**逗号放行**(官方即有 "1,2,3" 引号单元格,write_csv_lines 自动加引号,
  客户端解析器已被官方数据证实支持)。
  端点 `/composer/meta|blank|row|describe|apply`(apply 已验证:追加+删行后表文件字节复原)。
  词条/队长技/魂珠/武器每行都带**行级中文描述**(`wf_describe.py` 按逆向布局+枚举直译生成,
  语义等价非游戏原文——原文由客户端 3.9 万行 AS3 动态拼,离线不可复刻);
  **词条速查** tab 搜四表中文描述/角色名/武器名/键,按效果签名分组显示共用N/专属。
  右上角「发布并重启游戏」按钮 = 第 4 节发布链路一键完成,用户全程不用碰命令行。
  写操作都先 dry-run 预览再确认,自动备份 + 加入 pending。
  API 契约见 `references/api.md`(并入服务端后台时用)。
- **命令行 recipe(批量/可复现)**:`python mod-tools/wf_mod_tool.py apply --recipe <json>`。
  操作:`scale`(倍率)/ `set`(设值)/ `copy_ability`(移植)/ `remove_main_position`。
  用法见 `mod-tools/WF_mod_tool_usage.md`。
- **临时脚本(GUI 未覆盖的边角场景)**:用 `wf_mod_tool` 的底层函数写针对性脚本。
  嵌套表读写见第 3 节。

改完**务必发布**(第 4 节),否则游戏内看不到。

## 3. 三类数据结构的读写(定位后按类处理)

数据表格式不统一,读写前先判断属于哪类。详细字节布局见 `references/字段手册.md` 第二章。

1. **普通 orderedmap**(ability / leader_ability / ability_soul / character):
   每行 = zlib(CSV)。用 `core.read_orderedmap_file` / `write_table`。
2. **嵌套 orderedmap**(character_status / action_skill):外层行 = 原样内层 orderedmap 字节
   (不再 zlib),内层才是 zlib CSV。用 `core.read_orderedmap_file_raw_rows` 读外层、
   `read_orderedmap_file_from_bytes` 解内层、`build_orderedmap`(内层)+
   `build_orderedmap_raw_rows`(外层)写回。**内层键序必须保持原样**。
3. **① 层 JSON**(character.json / character_text.json):直接 `json.loads`,按下标改,
   `wf_char_editor.py` 已封装(FIELD_MAP)。

**列语义 / 枚举 / 单位**:一律查 `references/字段手册.md`。核心速记:
- 强度类 `1000 = 1%`;帧 `60 = 1秒`;threshold `100000 = 1次`。
- 每个数值字段有一对列:`power1`=技能 SLv1 值,`first_max`=SLv 满级值,游戏按当前等级线性插值。
- **主位限制**在 `unisonable` 列(`false`=仅主位=Ⓜ图标)+ 前置条件枚举 `202`(OwnerIsMain)。
  解除 = `unisonable→true` 且 `202→0`。`wf_gui.py` 的 mainpos 或
  `wf_patch_ability_main_position.py` 批量处理。
- **列序陷阱**:CN 实际 126 列,AMF3 schema 只记 125 列(觉醒 col3/4 未计入),
  col3 起 schema 列名整体偏一位。**按列名解析要以生成类 `AbilityValues.as` 为准,不要盲信 schema 下标**。
  安全做法:改数值列时用字段手册核对真实语义,数值列(power1/first_max)本身可信。
- **列序反例**:`character_status` 内层是 `hp,atk`;`character_awake_status` 是 `atk,hp`(相反!)。

## 4. 发布链路(② 层生效的唯一正道)

```bash
python mod-tools/wf_publish.py --tables ability,character_status   # 或用 pending 列表(不带 --tables)
```

原理(与官方增量更新同构):
- 打包结构 `production/upload/<xx>/<hash>`,**原样字节复制**(不重编码,不破坏觉醒列顺序)。
- 版本自动 +0.0.1(扫 CDN 现有最高版本),生成 `pinball-<from>-<to>-1-<tag>.zip`。
- 服务端 `src/routes/cn/asset.ts` **动态扫描** diff 目录,放入即生效,**不用重启服务端**
  (但改了服务端 .ts 代码才需要 `npx tsc` + 重启)。
  ⚠ **版本缓存坑**(2026-07-12 已修):上游 `lib/version.ts` 的 `detectCDNVersion` 把最高版
  缓存进模块变量且永不失效——发布后 diff 列表有新包但 `target_asset_version` 不推进,
  客户端不下载,症状="发布成功但游戏没更新"。已改为按 diff 目录 mtime 失效
  (补丁存档 `mod-tools/server-patch/version.ts.diff`,更新服务端后须套回)。

**触发客户端更新的两个开关**(都已修好,排查时先看这里):
- `load` 端点 `available_asset_version` 必须 > 客户端 res_ver → 客户端才进更新流程。
  (曾经回显客户端版本导致永不更新)
- `get_path` 端点 `is_initial`:客户端报了版本 → `false` → **增量只下小包**;
  不报 → `true` → 全量重下。(曾经硬编码 true 导致每次全量)

排查手段(2026-07-12 rebase 上游后):服务端日志看 `[CN-LOAD] res_ver=...`;get_path 行为直接
curl 验证:`curl -H "res_ver: <客户端版>" -X POST <服务端>/api/index.php/asset/get_path`,
看 `target_asset_version`(应=发布后最高版)与 `is_initial`(报了 res_ver 应为 false=增量)。
版本判定逻辑在上游 `src/lib/version.ts`(computeAssetTarget/getEffectiveVersion)。

`--tables` 别名:`ability` `character` `character_status` `leader_ability` `ability_soul`
`character_awake_status` `action_skill`。新表加别名到 `wf_publish.py` 的 `TABLE_ALIASES`。

**上游 asset-patch 兼容**(2026-07-12 对照上游 main `12047e2`):上游服务端另有
`assets/asset-patch/` 补丁机制(manifest.json 控 enabled,active/*.zip 也进 diff 列表),
`lib/version.ts` 的 getEffectiveVersion = max(CDN 最高版, 启用 patch 版)。与本发布链路
**并行不冲突**;`wf_publish.current_max_version` 已把启用 patch 版本纳入 max(防止版本号
被 patch 越过导致客户端拉不到新包)。上游未动 shop.ts/lib assets/boss_coin_shop.json,
商店三处同步与上游兼容。服务端 mod-admin 补丁见 `mod-tools/server-patch/`(更新服务端后套回)。

## 5. 服务端 / 模拟器管理

- **启动服务端**:双击 `start-cn.bat`(自带端口自检:释放 8001 占用)。或
  `node --env-file=.env out/cn-server.js`。改了 `src/*.ts` 要先 `npx tsc`。
- **热重载(mod-admin)**:`POST /api/mod-admin/reload_assets` 让服务端重读 9 个
  mod 常改 json(商店 7 文件 + assets/character.json,见 `src/lib/assets.ts` 的
  `reloadModAssets`),**不用重启**;`GET /api/mod-admin/ping` 探活。GUI 顶部
  「推送服务端」按钮就是调它(地址取 WF_SERVER_URL > .env CN_LISTEN_* > 127.0.0.1:8001)。
  其余 assets json 仍是静态 import,改了照旧要重启。
- **不要用 preview 面板长期跑服务端**——会随会话回收进程,导致"服务端悄悄退了"。
- **模拟器操作**(adb 路径见第 0 节,Windows 下 shell 命令加 `MSYS_NO_PATHCONV=1` 防路径转换):
  重启游戏 = `am force-stop com.leiting.wf` 然后 `monkey -p com.leiting.wf -c android.intent.category.LAUNCHER 1`。
  **adb 失联兜底**(2026-07-12 实测):MuMu adb 端口会漂移(16384→16416,记录在
  `MuMuPlayer\vms\<实例>\configs\vm_config.json` 的 nat.port_forward.adb)甚至整个不监听;
  此时用 `MuMuManager.exe sh -v <实例号> -c "<命令>"`(自有 RPC 通道,不依赖 adb;实例号看
  `MuMuManager.exe info -v all`,当前=1)。该通道下 monkey 参数会被拆坏,启动必须用
  `am start -n com.leiting.wf/com.leiting.sdk.activity.PrivacyActivity`。
  GUI 的 restart_game 已内置此兜底。
- **验证服务端在线**:`curl http://192.168.0.130:8001/api/server/currentTime`(本机 + 模拟器内都可达才算通)。

## 6. 排查"改了没生效"(按此顺序)

1. **数据真的改了?** 读回目标表核对值(不是看 dry-run,看写入后 `read_orderedmap_file`)。
2. **发布了吗?** `.cdn/cn/archive-common-diff/` 有没有新 `pinball-*-mod*.zip`。
3. **客户端触发更新了吗?** 看服务端日志有无 `[CDN] get_path`。没有 = `available_asset_version` 没推进。
4. **服务端在线吗?** 端口 8001 有没有监听,模拟器内能否 curl 到。
5. **游戏真重启了吗?** 用正确包名 `com.leiting.wf`(不是 `air.com.leiting.wf`)force-stop + 启动。
6. **金丝雀验证**:改一个显眼数值(如某角色 Lv100 HP=9999),生效则链路通,再排查具体字段。

## 7. 资产索引(需要细节时读)

- `references/字段手册.md` — **最重要**。125/126 列全表、枚举、单位、各表结构、CN/global 差异、安全规则。
- `references/api.md` — GUI 的 HTTP API 契约(GET/POST 端点,并入服务端后台时对接用)。
- `mod-tools/wf_mod_tool.py` — 核心引擎(orderedmap 读写 / 嵌套 / AMF3 schema / recipe / profile)。
- `mod-tools/wf_gui.py` + `wf_gui.html` — 网页修改器(前后端)。
- `mod-tools/wf_boss.py` — Boss 数值(boss_level)+ 22 类副本列表 + quest→zone→boss 解析。
- `mod-tools/wf_quest_lib.py` — quest/zone/boss 系**三层压缩索引嵌套表**任意深度读写(自检 `--selftest`)。
- `mod-tools/docs/技能形态切换与资产包导入结论.md` — 形态切换机制(character 表 col9-16)、
  资产包一比一导入、资料三层同步、boss 血量位置(本轮五项功能的逆向依据与落地状态)。
- `mod-tools/docs/强化弹射与boss连战逆向结论.md` — 特殊强化弹射两种机制
  (leader_ability 挂 PowerFlipOverride 722/419 → power_flip_action 表 override_ 键 →
  专属 DSL,仅主位;或弹射触发 InvokeSkill 追击)+ 自定义新弹射配方;
  boss 连战 = zone 节点多 wave 行(ZoneValues 列布局/boss1-3/_multi=多人变体),
  187 个现成连战范本;quest 行难度列;星级品质三层排查与克隆漏写服务端表的修复;
  §6 EX Boost 体系:②ex_ability=效果(发布生效)/服务端 assets/ex_ability.json=抽取池
  (静态 import,改后须重启服务端)/存档 players_characters.ex_boost_* 直接 UPDATE,
  A/B 组按 string_id 前缀、金银铜按 _rN 后缀,概率硬编码 exBoost.ts。
- `mod-tools/wf_describe.py` — 行级中文描述器(布局吃 ability_enum_map.json,枚举中文吃全表 md §6)。
- `mod-tools/wf_selftest.py` — **全链路自检**:环境检测+功能模拟(--deep 金丝雀写入闭环,写完即复原);
  GUI 工具箱「全链路自检」同款。改完大功能/换数据包/排查环境先跑它。
- `mod-tools/wf_dsl_sig.py` — 技能/PF DSL 命令签名表(自反编译 AS3 生成+人工中文标注段)。
- `mod-tools/wf_assets.py` — 角色资产编解码(PNG 魔数/MP3 帧头混淆)+三根定位+清单。
- `mod-tools/wf_dsl.py` — 技能 ActionDsl 数值编辑(AMF3 偏移解析+U29 等长原地补丁)。
- **文件结构约定(2026-07-12)**:mod-tools 代码平铺在根;分析/方案/逆向结论 md 在 `mod-tools/docs/`;
  运行时数据(ability_enum_map.json/词条条件代码全表.md/WF_PATHLIST_recovered.txt/HarvestedPaths.csv)
  留根**勿移动**(工具按固定文件名读取);分析报告生成脚本(wf_all_analysis 等)输出到 docs/。
- `mod-tools/docs/角色资产与全角色替换方案.md` — 资产体系逆向结论、路径模板/尺寸要求、
  整角色替换(code_name 重定向 / 逐项替换)与全新角色可行性分析。
- `mod-tools/wf_publish.py` — CDN 增量发布器(pending 支持 medium:/android: 前缀,自动分包到对应 diff 目录)。
- `mod-tools/wf_char_editor.py` — ① 层角色资料编辑。
- `mod-tools/docs/角色数据逆向与修改指南.md` — 两层逆向过程 + HP/ATK / 觉醒破解结论。
- `mod-tools/docs/版本切换设计.md` — profile 版本档案设计(CN/global 切换)。

## 8. 安全规则(写入前必守)

1. **先 dry-run 预览再写**;写入自动生成 `.bak-wfmod-*` 备份。
2. **还原用备份取原值**,不要凭记忆填(如队长技原值从 `.bak-wfmod-leader-*` 取)。
3. **嵌套表内层键序不可重排**;`build_orderedmap_raw_rows` 保持外层原序。
4. **数值范围** 0 ~ 2³¹-1;千分比语义确认后再改;断点/键白名单(不新增不存在的键)。
5. **① 层改动不发 CDN**(重启服务端生效);**② 层改动必发 CDN**(不走 adb 手推)。
6. 破坏性操作(改 store、删备份)前先确认目标,别动未跟踪的逆向工作区。
