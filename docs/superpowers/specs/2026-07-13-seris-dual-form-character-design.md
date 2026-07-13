# 赛瑞斯双形态原创角色与通用变身基座设计

## 目标

为 World Flipper CN 私服新增一名完全独立的原创角色“赛瑞斯”，并同时建立可复用的双形态客户端基座。赛瑞斯以人形参战，首次及后续每次在人形发动技能后进入龙形 30 秒（1800 帧）；龙形期间使用独立技能、像素动画、演出和语音，状态到期后恢复人形。

本设计必须交付两个可独立版本化、可回滚的产物：

1. 一次安装的通用双形态客户端基座 APK；
2. 可经现有 Mod 工具导入、校验和发布的赛瑞斯角色数据包。

战斗数值、双技能、状态、语音选择和元素伤害均使用客户端现有数据机制；客户端补丁只负责双形态像素、技能 cut-in 和表现状态切换，不接管伤害计算或战斗判定。这样即使客户端未安装表现基座，角色的技能、伤害和语音仍能按数据运行，只会继续显示人形像素。

## 参考图与视觉基准

- 人形参考：`E:/sora——picture/OC/角色设计/狼骑士/赛瑞斯/ChatGPT Image 2026年6月3日 04_37_48.png`
- 龙形参考：`E:/sora——picture/OC/角色设计/狼骑士/赛瑞斯/ChatGPT Image 2026年6月7日 18_22_21.png`

两种形态必须共享同一身份特征：银白鳞片与铠甲、钴蓝鬃发、蓝色发光眼睛、深蓝织物和克制的金色饰边。不得复用或重绘现有黑狼像素角色，也不得在最终资产中出现黑狼、黑色毛皮或红黑铠甲残留。

## 范围

### 包含

- ★5 水属性男性龙族角色的完整主数据、文本、基础数值和玛纳板；
- 人形技能、龙形技能、队长技和六条能力；
- 水、雷两种实际伤害元素的全屏技能；
- 1800 帧龙形状态及人形/龙形往返；
- 基础与进化立绘、全部必要 UI 图、双形态技能 cut-in；
- 完全原创的人形与龙形逐帧像素动作；
- 完全原创的 Flatomo 骨骼演出、贴图、时间轴和音效；
- 中文台词稿、日语游戏语音及语音数据映射；
- 数据驱动的 `ModDualForm` 通用客户端基座；
- Mod 工具中的角色包构建、校验、发布、APK 安装和回滚入口；
- MuMu 真机链路验证和数据/客户端双层回滚。

### 不包含

- 角色剧情、剧情语音、`voice/words`、登录语音；
- 剧情表情差分和角色剧情横幅；
- 战斗 HUD 常驻头像随形态实时切换；
- 新增联机协议或把战斗判定迁入客户端补丁；
- 服务端远程替换 APK 内主 SWF；
- 模仿或克隆现实声优的声音。

## 角色定义

| 字段 | 固定值 |
|---|---|
| 角色 ID | `129999` |
| code name / 技能键 | `seris_dragon_king` |
| 中文名 | 赛瑞斯 |
| 日文名 | セイリス |
| 称号 | 苍海龙王 |
| 稀有度 | ★5 |
| 属性 | 水，`character.c3 = 1` |
| 种族 | `Dragon` |
| 性别 | 男 |
| 职责 | 攻击型 |
| 强化弹射类型 | 射击，`speciality_type = 2` |
| 攻击距离 | 远程 |
| Lv100 HP | 3780 |
| Lv100 ATK | 940 |
| 技能能量 | 520 |
| 客户端表现标签 | `ModDualForm` |
| 队长技键 | `129999` |
| 能力键 | `1299991` 至 `1299996` |

角色简介固定为：

> 统御苍海与风暴的古龙之王。平日以银鳞龙人的姿态行走于人世；解开王印后便显露翼龙真身，以万潮与苍雷肃清战场。

角色创建以现有 ★5 水属性龙族角色的表结构和等级曲线为模板，但所有新键、文本、技能、能力和资产均独立；不得让赛瑞斯继续共享模板角色的 `code_name`、技能键、能力键、玛纳板 ID 或资产路径。

## 战斗设计

### 人形技能

名称：`苍海雷狱・龙王显现`

技能说明：

> 唤起苍海与雷霆，对全体敌人造成水属性与雷属性伤害，降低其水属性与雷属性抗性；随后解开王印，进入龙形 30 秒。

技能行为按以下固定顺序执行：

1. 播放 `human_start` 演出；
2. 对当前存活的全体敌人造成 6 段水属性伤害，倍率依次为 `1.6 / 1.6 / 1.6 / 1.6 / 1.6 / 2.0`，总倍率 `10.0`；
3. 对当前存活的全体敌人造成 4 段雷属性伤害，每段 `1.5`，总倍率 `6.0`；
4. 第 10 段伤害结算后，对命中的敌人施加水属性抗性 `-10%` 与雷属性抗性 `-10%`，持续 1800 帧；
5. 无论场上是否仍有敌人，都向施放者赋予 1 层“龙王显现”，持续 1800 帧；
6. 人形 ActionDsl 在状态赋予后立即触发 `transform`；表现控制器在同一次 `false→true` 边沿只播放一次像素 `form_in`，完成后显示龙形并启动 `dragon_loop`；1800 帧计时从状态真正加入施放者时开始。

上述倍率均为相对于施放者攻击力的技能伤害倍率。两组攻击在 ActionDsl 中必须为显式元素伤害：前 6 段写水元素，后 4 段写雷元素。不得依赖角色主属性自动推断第二组雷伤，也不得用只改颜色的伪雷击表现代替雷属性伤害。减抗在本次伤害结束后施加，因此本次人形技能本身不享受新减抗。

### 龙形技能

名称：`天穹万潮・王龙雷息`

技能说明：

> 以龙王真身引动天海，对全体敌人造成水属性与雷属性伤害，并在终击使敌人麻痹。

技能行为按以下固定顺序执行：

1. 播放 `dragon_attack` 演出；
2. 对当前存活的全体敌人造成 5 段水属性伤害，每段 `2.0`，总倍率 `10.0`；
3. 对当前存活的全体敌人造成 5 段雷属性伤害，每段 `2.0`，总倍率 `10.0`；
4. 第 10 段命中后，对命中的敌人施加麻痹，持续 300 帧；
5. 不赋予、不延长、也不刷新“龙王显现”。

技能开始时只要“龙王显现”仍存在，本次施法就锁定为龙形技能。状态即使在施法中途到期，已经开始的龙形 ActionDsl 仍完整执行；表现层在技能动作结束后再播放 `form_out` / `dragon_end` 并恢复人形。

### 龙形状态

新增特殊效果：

| 字段 | 固定值 |
|---|---|
| unique condition ID | `22` |
| string id | `unique_seris_dragon_king` |
| 名称 | 龙王显现 |
| icon_image 表值 | `battle/common/unique_condition/unique_seris_dragon_king`，不带扩展名 |
| 物理图标资产 | `battle/common/unique_condition/unique_seris_dragon_king.png`，48×48 PNG |
| 持续时间 | 1800 帧 |
| 最大层数 | 1 |
| 行为标志 | `false,true,0,0,true` |
| extra | `(None)` |

行为标志依次表示：`cancelable=false`、`force_apply=true`、`condition_direction=0 (Good)`、`overwrite_mode=0`、`remove_if_encoffin=true`。因此“龙王显现”是正向状态，不受普通净化或 debuff 抗性阻挡，技能可稳定自赋予；进入棺材时移除。真机测试必须分别覆盖净化、debuff 抗性、死亡和进棺材。

角色表形态切换字段固定为：

- `action_skill_switching.kind = 1`，即 `ConditionExist`；
- 条件种类列为 `28`，即 `ConditionMasterKind.Unique`；
- unique condition 参数列为 `22`；
- 切换技能键为 `seris_dragon_king`，指向 `master/skill/switched_action_skill.orderedmap`；
- `no_voice = false`；
- `no_ready_voice = false`。

`action_skill` 与 `switched_action_skill` 都新增外层键 `seris_dragon_king`，并提供基础/进化所需的完整内层等级及各自独立 program path。龙形技能语音走客户端已有的 `matched_skill_ready` 与 `matched_skill_*` 分支。

### 队长技

名称：`苍海龙王的敕令`

说明：

> 水属性角色攻击力 +100%，技能伤害 +150%。

两项效果都只匹配水属性角色，常驻生效，不限制主位，不要求赛瑞斯处于龙形。

### 六条能力

| 能力 | 效果 | 约束 |
|---|---|---|
| `1299991` | 自身技能伤害 +75% | 常驻，可作为副位生效 |
| `1299992` | 每当自身发动技能，自身技能伤害 +30%，最多 3 次，合计 +90% | 人形和龙形技能都计数；战斗开始时清零 |
| `1299993` | 战斗开始时自身技能槽 +100%；龙形期间自身攻击力 +100% | 仅主位；开场充能只触发一次 |
| `1299994` | 自身技能伤害 +40% | 常驻，可作为副位生效 |
| `1299995` | 水属性角色技能伤害 +30% | 全队水属性角色生效 |
| `1299996` | 每次真正进入龙形时自身技能槽 +30%，最多 3 次；龙形期间自身技能伤害 +50% | 仅主位；同一层状态的场景重建不重复计数 |

能力 1 至 3 属于基础玛纳板，能力 4 至 6 属于第二玛纳板/觉醒扩展。能力 2 的“发动技能”在技能启动时计数，本次技能可以获得新增层数。能力 6 的充能只在“龙王显现”由不存在变为存在时触发；切换场景、重建像素或恢复显示不算新的进入。龙形期间加成统一以 unique condition `22` 是否存在为门槛。

能力 2 使用已有官方模式：`trigger=SkillInvoke(23)`、`trigger_limit=3`、`content=SkillDamage(34)`、`strength=30000`。必须验证触发发生在本次 ActionDsl 第一段伤害之前。

能力 6 的进入充能先做最小纯数据 canary：`trigger=ConditionUnique(185)`、`puller=Myself`、`unique_condition_id=22`、`threshold=1`、`trigger_limit=3`、`content=SkillGauge(211)`、`target=Myself`、`strength=30000`。由于当前 CN ability 语料没有该 trigger 的官方使用行，只有 canary 证明每次 `0→1` 恰触发一次，且换 zone、表现重建和状态恢复不误触发后，才能进入正式角色数据；canary 失败时停止该能力的实现并回到设计评审，不得把技能槽逻辑塞进客户端表现控制器。

## 双形态状态机

### 战斗权威状态

“龙王显现”是唯一战斗权威状态。技能选择、能力加成、剩余时长和恢复人形均由原生 condition / `switched_action_skill` 机制决定。客户端表现控制器只读取这一结果，不维护第二套战斗计时器。

技能启动时只锁定本次选中的 ActionDsl、matched voice 和 matched cut-in。Unique 到期后，依赖该状态的攻击力/技能伤害加成立即按原生实时状态撤销；表现层只把龙形像素锁到当前技能动作结束。`TransformOutPending` 不延长、不重加 Unique，也不改变后续伤害计算。

表现状态机包含五个状态：

1. `Human`：人形像素与人形技能；
2. `TransformIn`：播放 `form_in`，逻辑上已处于龙形；
3. `Dragon`：龙形像素与龙形技能；
4. `TransformOutPending`：状态已到期，但当前龙形技能动作尚未完成；
5. `TransformOut`：播放 `form_out` 后回到 `Human`。

### 生命周期规则

- 正常赋予状态：condition `false→true` 时，表现控制器只触发一次像素 `form_in`，然后 `Human → TransformIn → Dragon`；
- 正常到期且没有正在执行的龙形技能动作：condition `true→false` 时，表现控制器只触发一次像素 `form_out` 与 `dragon_end`，然后 `Dragon → TransformOut → Human`；
- 技能中到期：`Dragon → TransformOutPending → TransformOut → Human`；
- 场景切换时状态仍在：新场景直接以 `Dragon` 重建，不重播 `form_in`，保留原生剩余帧数；
- 场景切换时状态已无：以 `Human` 重建；
- 掉出场地、移动和碰撞期间到期：在不破坏当前物理状态的前提下切换显示；
- 死亡：原生进棺材流程依据 `remove_if_encoffin=true` 移除“龙王显现”，表现层先撤销龙形显示，再使用人形 `into_coffin`、`ghost_raise`、`ghost_neutral`；
- 复活：使用人形 `revive`，不会自动恢复已消失的龙形状态；
- 战斗结束：强制清理表现控制器和循环特效，不把形态带到下一场战斗；
- 作为副位/共鸣角色发动切换技能时，允许使用 `switched_action_skill` 和 matched voice，但不替换当前可见主位角色的像素。

## 通用双形态客户端基座

### 设计原则

客户端基座不得硬编码角色 ID `129999` 或 `seris_dragon_king`。`dual_form_v1` 的保证范围只覆盖 `ConditionExist + ConditionMasterKind.Unique`；其他四种 switching kind（HpHigh、MultiballNumber、ChangeSkillFlag、IsUnison）继续使用原生技能切换，但表现控制器记录一次“不受支持”并保持标准像素，直到各自的边沿抖动、重建和生命周期另行设计并通过 canary。

角色同时满足以下契约时使用 v1 控制器：

1. `character_tag` 含 `ModDualForm`；
2. 角色的原生 `action_skill_switching` 为 `ConditionExist + Unique`；
3. 标准人形像素位于 `character/<code_name>/pixelart/`；
4. 替代形态像素位于 `character/<code_name>/pixelart_matched/`；
5. 人形时间线含 `form_in`，替代形态时间线含 `form_out`。

控制器从原生技能切换条件读取当前 matched 状态，并以 code name 计算资产路径。hook 必须在 `BattleCharacterLogic.resolvePathCollection` 的战斗资源收集阶段追加 `character/<code_name>/pixelart_matched/pixelart`、`character/<code_name>/pixelart_matched/special`、当前进化等级对应的 matched cut-in，以及 `<code_name>_dragon_loop` / `<code_name>_dragon_end` 两个形态效果；下载与纹理解码在进入战斗前完成。单位创建阶段只绑定已经收集好的资源，不得临时加载或解码。控制器不解析赛瑞斯专属 manifest，也不自己倒计时。

形态循环与结束效果使用固定命名空间 `battle/effect/skill_unique/<code_name>/<code_name>_<effect_key>`。控制器只需从 code name 派生 `dragon_loop` 与 `dragon_end` 路径，并监听 condition 的进入/退出边沿；`human_start`、`transform` 和 `dragon_attack` 由两套 ActionDsl 显式触发。可选表现文件缺失时按降级规则继续战斗。

### 运行时行为

- 切换时保留单位的世界坐标、旋转、缩放、颜色、可见性、碰撞与 HUD 锚点；
- 动画名在两套资源中同名时保持当前语义动作；不存在时回退到 `neutral`；
- 人形与龙形统一使用 `unit_body` 和 `hp_gauge` 锚点，避免血条跳动；
- 像素纹理 `smoothing = false`；
- 两套资源都在战斗资源收集阶段预载，形态切换不得临时阻塞战斗；
- `skill_cutin_0/1` 保持客户端原生的基础/进化语义；
- `ModDualForm` 角色处于 matched 状态时，按同一进化索引改读 `skill_cutin_matched_0/1`；
- 角色立绘、头像、队伍缩略图仍按正常基础/进化索引工作；
- v1 不修改战斗 HUD 常驻头像。

### 降级与错误处理

- 未安装基座：原生技能、伤害、状态和 matched voice 正常，人形像素持续显示，cut-in 继续使用当前进化等级的标准人形 `_0/1`；
- 缺少 `pixelart_matched`：记录一次带 code name 的错误，保持人形像素，不崩溃；
- 替代时间线缺少当前动作：回退同形态 `neutral`，仍保留战斗状态；
- `form_in` 或 `form_out` 缺失：直接切换纹理，不阻断技能；
- 资产加载失败不得修改 condition、技能槽或伤害结果；
- 控制器释放时必须停止 `dragon_loop`，防止换场后残留特效或泄漏监听器。

### 补丁验证

基座修改 APK 内 `assets/worldflipper_android_release.swf`，不能通过服务端 CDN 自行安装。构建流程必须执行：

1. 从固定基线 APK 导出主 SWF；
2. 注入通用控制器与 hook；
3. 重新导出或反编译产物，验证目标 P-code/ABC 中实际存在标签判断、替代路径和回退分支；
4. 禁止只凭 FFDec 显示的 AS3 源码或“编译成功”判定补丁有效；
5. 替换 APK 内主 SWF，执行 zipalign；
6. 使用固定项目签名密钥签名；
7. 执行 `apksigner verify --print-certs` 与安装前证书比对；
8. 证书一致时通过 `adb install -r --no-incremental` 覆盖安装；证书不一致时停止并提示用户，只有用户另行授权备份、卸载和重装后才能继续；
9. 安装后 force-stop 游戏，只删除 `/data/data/com.leiting.wf/cache/app/` 的 AIR 编译缓存，绝不执行 `pm clear`；
10. 重启客户端并读取基座 runtime marker，只有 marker 版本与 APK 内主 SWF hash 同时匹配本次构建记录时才写入 capability `dual_form_v1`。

## 原创视觉资产

### 立绘与 UI

基础立绘表现人形赛瑞斯的克制王者姿态；进化立绘强化风暴、海潮和龙翼剪影，但保持同一服装、鳞片、头部轮廓和配色。人形 UI 从经审核的基础/进化两张透明母版确定性裁切；另制作一张独立龙形透明母版，作为 matched cut-in、龙形像素和 Flatomo 的身份基准。禁止为不同 UI 单独重新生成身份不一致的脸、鳞片或铠甲。

标准必要 UI PNG 共 25 张：

- `full_shot_1440_1920_0/1.png`；
- `skill_cutin_0/1.png`；
- `illustration_setting_sprite_sheet.png`；
- `square_0/1.png`；
- `square_132_132_0/1.png`；
- `square_round_95_95_0/1.png`；
- `square_round_136_136_0/1.png`；
- `thumb_level_up_0/1.png`；
- `thumb_party_main_0/1.png`；
- `thumb_party_unison_0/1.png`；
- `battle_control_board_0/1.png`；
- `battle_member_status_0/1.png`；
- `cutin_skill_chain_0/1.png`。

双形态角色再新增 2 张龙形 UI PNG：`skill_cutin_matched_0.png` 与 `skill_cutin_matched_1.png`，分别对应基础/进化状态下的龙形技能。角色 UI PNG 因此共 27 张；另有 1 张不计入 UI 的 48×48 unique condition 图标。

四张 cut-in PNG 都要生成平台纹理：`skill_cutin_0/1.atf.deflate` 与 `skill_cutin_matched_0/1.atf.deflate`。普通 cut-in 表现人形发动“龙王显现”，matched cut-in 表现龙形发动“王龙雷息”。`illustration_setting_sprite_sheet.atlas.amf3.deflate` 必须随新 code name 复制并重写内部引用。两张 full shot 同步 `generated/character_image`、`full_shot_image_attribute` 和 `generated/trimmed_image`；四张 cut-in 同步 `generated/trimmed_image`。PNG 实际宽高、内容框与 trim 画布必须一致。

### 完全原创像素角色

角色像素不从官方狼、龙或其他角色的 sprite sheet 调色。制作流程为：

1. 根据两张参考图绘制人形与龙形正交设定和统一色板；
2. 分别建立原创人形、四足翼龙骨架和动作草模；
3. 用骨架输出关键姿势和运动弧线；
4. 逐帧重绘为受限色板像素图，人工修正轮廓、鳞片、鬃发、翼膜和拖尾；
5. 用确定性打包器生成 sprite sheet、atlas、frame 和 timeline；
6. 逐动作播放检查，不以 AI 直接生成的多帧图作为最终 atlas。

游戏内角色主体仍使用逐帧 sprite sheet；原创骨架是离线动作创作与一致性工具，不要求把新的骨骼运行时塞入战斗角色类。

人形路径 `character/seris_dragon_king/pixelart/` 的 `pixelart.timeline` 固定包含以下 9 个标准序列：

- `neutral`
- `walk_back`
- `walk_front`
- `skill_ready`
- `kachidoki`
- `into_coffin`
- `ghost_raise`
- `ghost_neutral`
- `revive`

人形 `special.timeline` 另含 `form_in`。龙形路径 `character/seris_dragon_king/pixelart_matched/` 的 `pixelart.timeline` 固定包含：

- `neutral`
- `walk_back`
- `walk_front`
- `skill_ready`
- `kachidoki`

龙形 `special.timeline` 固定包含 `matched_skill` 与 `form_out`。

龙形死亡不使用龙形棺材/幽灵资源，而是按状态机先回人形。每个像素目录都必须提供以下 8 个 common-root 文件，两种形态合计 16 个：

- `sprite_sheet.png`
- `special_sprite_sheet.png`
- `sprite_sheet.atlas.amf3.deflate`
- `special_sprite_sheet.atlas.amf3.deflate`
- `pixelart.frame.amf3.deflate`
- `pixelart.timeline.amf3.deflate`
- `special.frame.amf3.deflate`
- `special.timeline.amf3.deflate`

两套像素的统一运行参数为：

- 逻辑画布：256×256；
- pivot：`x = -128`、`y = -128`；
- scale：`6`；
- smoothing：`false`；
- `unit_body` 与 `hp_gauge` 锚点在所有序列中保持不变。

打包器必须按客户端真实语义生成帧后缀：数字后缀表示整条 timeline 中该图块的 inclusive 绝对结束 tick，不是图块的开始 tick；若相邻后缀为 `p` 与 `q`，后一个图块覆盖 `p + 1 ... q`。第一个图块从对应序列 `begin` 覆盖到首个后缀。预览器、编译器和 QA 使用同一 tick 映射函数；任何序列都要逐 tick 对照 atlas，禁止再次出现黑狼残帧、空白帧、错帧、边缘黑底或累计时长漂移。

### 原创 Flatomo 演出

仓库当前没有可直接承担原创资产生产的完整 Flatomo 语义编译器，因此先建立不可跳过的编译器硬门：

1. 定义可读 IR，覆盖贴图、部件树、关键帧、补间、循环、声音事件和 `IntMatrix`；
2. 编译为客户端可读的 raw-deflate AMF3；
3. 对官方 fixture 执行 `decode → encode → decode` 并验证结构、键序和数值类型等价；
4. 校验部件引用、关键帧单调、纹理范围、循环闭合和所有整数边界；
5. 在真机上跑一个最小 golden effect，确认加载、播放、循环和释放都正确；
6. 以上门禁通过后才允许生产赛瑞斯的五个效果。

`IntMatrix` 固定使用六分量 `a,b,c,d,tx,ty`，按 `RESOLUTION = 4096` 的 Q12 规则量化，并检查每个结果都在 int32 范围内。

新增五个稳定 effect key：

| effect key | 用途 |
|---|---|
| `human_start` | 海潮法阵、银蓝水流与第一轮水伤 |
| `transform` | 王印破裂、银鳞扩张、翼与尾展开 |
| `dragon_loop` | 龙形期间低强度潮雾与蓝色电弧循环 |
| `dragon_attack` | 翼龙抬首、全屏潮汐与雷息终击 |
| `dragon_end` | 电弧熄灭、龙形收束并恢复人形 |

逻辑根固定为 `battle/effect/skill_unique/seris_dragon_king/`，每个 effect 的完整名称为 `seris_dragon_king_<effect_key>`。五个 effect 共享一张纹理时，最少交付 12 个 common-root 文件：1 张 PNG、1 张 atlas、5 个 `.parts.amf3.deflate` 和 5 个 `.timeline.amf3.deflate`。不得把“5 个效果 key”误报成“5 个文件”。

每个演出使用原创分层贴图、骨骼/部件和时间轴。玩法命中区、伤害倍率、状态与演出严格分离：Flatomo 只负责视觉，ActionDsl 负责实际伤害和状态。五个 effect 都必须在独立预览和真机战斗中通过，结束时清理全部临时节点。

### 音效

新增 6 个原创 MP3，位于 common-root 的 `sound_effect/unique/`：

| 文件 | effect | begin | end | loop | volume |
|---|---|---:|---:|---|---:|
| `se_seris_water_rise.mp3` | `human_start` | 12 | 71 | false | 0.85 |
| `se_seris_thunder_crack.mp3` | `human_start` | 54 | 71 | false | 0.90 |
| `se_seris_transform.mp3` | `transform` | 8 | 59 | false | 0.90 |
| `se_seris_dragon_roar.mp3` | `transform` | 42 | 59 | false | 0.82 |
| `se_seris_dragon_breath.mp3` | `dragon_attack` | 18 | 95 | false | 0.95 |
| `se_seris_thunder_crack.mp3` | `dragon_attack` | 72 | 95 | false | 0.90 |
| `se_seris_form_end.mp3` | `dragon_end` | 6 | 47 | false | 0.75 |

各 timeline 中的声音逻辑路径写为 `sound_effect/unique/se_seris_*`，不带 `.mp3` 后缀。`human_start` 总长 72 tick，`transform` 60 tick，`dragon_loop` 120 tick 并无缝循环，`dragon_attack` 96 tick，`dragon_end` 48 tick。

六个 SFX 同样交付为 44.1 kHz、单声道、96 kbps CBR MP3。音效不得含受版权限制的游戏素材采样。水流、雷击、鳞甲与低吼分层制作，技能终击优先保证打击点清晰，避免与日语台词争夺中频。

## 语音设计

### 生成与后期

使用有商业/项目授权的日语 TTS 或本地合成声音，固定同一说话人 seed 和音色参数。不得克隆现实声优，也不得提示模仿具体声优。

人形声线为外观年龄约 35 至 45 岁的低沉男中音，演绎克制、古老、从容；龙形使用同一身份重新演绎，增加胸腔共鸣、轻微 formant 下移和很短的低吼尾音，不把人形成品简单粗暴降调。

交付格式固定为：

- 44.1 kHz；
- 单声道；
- MP3 96 kbps CBR；
- 综合响度约 `-16 LUFS`；
- true peak 不高于 `-1 dBTP`；
- 每个文件从首帧到文件尾都必须通过逐帧 CBR/解码校验。

### 台词与文件

所有逻辑路径均位于 `character/seris_dragon_king/voice/`。共 22 个文件：

| 相对路径 | 中文台词稿 | 日语游戏语音 |
|---|---|---|
| `ally/join.mp3` | 我名赛瑞斯，乃统御苍海的古龙之王。就让我见证你的旅途吧。 | 我が名はセイリス。蒼海を統べる古竜の王だ。そなたの旅路を、見届けよう。 |
| `ally/evolution.mp3` | 这份力量还能抵达更深处吗……很好。我会以王的身份回报你的信赖。 | この力も、なお深みへ至るか……。よい。そなたの信に、王として報いよう。 |
| `home/human_form.mp3` | 人形也并不坏。毕竟不必高声，话语也能传达出去。 | 人の姿も悪くない。声を荒らげずとも、言葉は届くからな。 |
| `home/storm.mp3` | 潮声躁动，风暴不久便会到来。若要出海，现在先等等。 | 潮の声が騒がしい。遠からず嵐が来る。船を出すなら、今は待て。 |
| `home/memory.mp3` | 活得越久，失去的便越多。但唯独不能遗忘——那是王的职责。 | 長く生きれば、多くを失う。だが、忘れることだけはせぬ。それが王の務めだ。 |
| `home/courage.mp3` | 你很特别。并非不懂恐惧，却仍带着恐惧前行……我并不讨厌。 | そなたは妙だな。恐れを知らぬのではない。恐れながら、なお進む……嫌いではない。 |
| `home/true_form.mp3` | 想看我的龙身？那可不是供人观赏的东西。若有必要，你自然会见到。 | 竜の姿が見たいのか？　見世物ではない。必要とあらば、いずれ目にするだろう。 |
| `home/tea.mp3` | 茶倒是不错。在海底宫殿里，可没有欣赏热气的机会。 | 茶は悪くない。海底の宮では、湯気を眺める機会などなかったからな。 |
| `battle/battle_start_0.mp3` | 退下。我无意取你性命。 | 退け。命まで奪うつもりはない。 |
| `battle/battle_start_1.mp3` | 潮水已满。开始吧。 | 潮は満ちた。始めるぞ。 |
| `battle/power_flip_0.mp3` | 苍雷，贯穿！ | 蒼雷よ、穿て！ |
| `battle/power_flip_1.mp3` | 扫清他们！ | 薙ぎ払え！ |
| `battle/outhole_0.mp3` | 唔……！ | ぐっ……！ |
| `battle/outhole_1.mp3` | 大意了……！ | 不覚……！ |
| `battle/skill_ready.mp3` | 解开王印。 | 王印を解く。 |
| `battle/skill_0.mp3` | 苍海化作雷狱——龙王显现！ | 蒼海雷獄――龍王顕現！ |
| `battle/skill_1.mp3` | 苍海啊，披上雷霆——龙王，显现！ | 蒼海よ、雷を纏え――龍王、顕現！ |
| `battle/matched_skill_ready.mp3` | 天与海，皆回应我的吐息。 | 天も海も、我が息吹に応えよ。 |
| `battle/matched_skill_0.mp3` | 天穹万潮——王龙雷息！ | 天穹万潮――王龍雷息！ |
| `battle/matched_skill_1.mp3` | 万千潮汐，充盈天穹——王龙雷息！ | 万潮よ、天を満たせ――王龍雷息！ |
| `battle/win_0.mp3` | 平息了吗？那么便无需再战了。 | 静まったか。ならば、これ以上は要るまい。 |
| `battle/win_1.mp3` | 胜负已定。趁潮退之前回去吧。 | 勝敗は決した。潮が引く前に戻るぞ。 |

技能名固定读音：

- `蒼海雷獄・龍王顕現`：`そうかいらいごく・りゅうおうけんげん`；
- `天穹万潮・王龍雷息`：`てんきゅうばんちょう・おうりゅうらいそく`。

`character_speech` 必须显式注册 8 行非战斗语音映射，且 `voice_path` 不带 `.mp3` 后缀：

| voice_path | kind | constraint | evolution_level |
|---|---:|---:|---:|
| `home/human_form` | 0 / Home | 0 | 空 |
| `home/storm` | 0 / Home | 2 | 空 |
| `home/memory` | 0 / Home | 2 | 空 |
| `home/courage` | 0 / Home | 1 | 空 |
| `home/true_form` | 0 / Home | 1 | 空 |
| `home/tea` | 0 / Home | 1 | 空 |
| `ally/evolution` | 1 / Evolution | 空 | 1 |
| `ally/join` | 2 / Join | 空 | 空 |

其余 14 条战斗语音由客户端 `CharacterShortVoiceLogic` 按固定相对路径发现。资产发现器的固定语音表必须补入 `matched_skill_ready.mp3`、`matched_skill_0.mp3`、`matched_skill_1.mp3`，克隆、导出、导入和模板检查都不得漏掉 matched voice。

## 数据与角色包

### 数据变更

角色包需要原子地描述并校验以下逻辑数据：

- 服务端层：`assets/cdndata/character.json`、`assets/cdndata/character_text.json`、`assets/character.json` 与新角色玛纳节点所需的 `assets/mana_node.json` 镜像；
- 客户端角色层：`character`、`character_text`、`character_status`、`character_awake_status`、玛纳板相关表；
- 能力层：`ability`、`leader_ability` 及能力描述字符串；
- 技能层：`action_skill`、`switched_action_skill`、两套 ActionDsl；
- 状态层：`unique_condition`、48×48 图标及 unique condition 文案；
- 语音层：`character_speech` 与 22 个 MP3；
- 图像定位层：`character_image`、`full_shot_image_attribute`、`trimmed_image`；
- 表现层：UI、pixelart、pixelart_matched、Flatomo、SFX 和 cut-in ATF。

新建角色工具必须支持独立创建 `switched_action_skill`，不能继续只克隆基础 `action_skill`；形态编辑器必须能写 `ConditionMasterKind.Unique` 的参数列，不能只写 condition 种类列；删除/回滚角色时也要清理这两个新增引用。

发布根映射固定为：

- 服务端 JSON 只写项目 `assets/`，按实际静态/热重载能力提示重载或重启，不进入 CDN；
- common `production/upload`：orderedmap、ActionDsl、22 个角色语音、`illustration_setting_sprite_sheet.atlas`、unique condition 图标、两套共 16 个像素文件、Flatomo 最少 12 文件和 6 个 SFX；
- medium `production/medium_upload`：27 张角色 UI PNG；
- android `production/android_upload`：4 张 cut-in ATF。

发布器必须根据以上根生成 pending 前缀，不能把 medium/android 文件误装进 common 包。

角色包发布采用事务式激活：先在真实 store 和 CDN 扫描目录之外完成 staging 写入、全表读回、文件 hash、三根 zip 构建和 zip 内容校验；随后取得发布锁，原子替换服务器 JSON，把三根 zip 移入各自归档目录，最后以单次原子 replace 写入活动 release manifest。服务端 CDN 扫描器只公布活动 manifest 同时引用且三根均存在的 release，因此移动过程中的半套包不可见。任一步失败都删除 staging、恢复服务器 JSON，并保持上一活动 manifest 不变；不得在 common 已对客户端可见后再尝试补齐 medium 或 android。

### 包结构与 manifest

赛瑞斯角色包使用稳定包 ID `seris_dragon_king`，manifest 必须包含：

- `schema_version`；
- `character_id = 129999`；
- `code_name = seris_dragon_king`；
- `package_version`；
- `requires_client_base = dual_form_v1`；
- `required_capabilities = [ModDualForm, MatchedCutin, MatchedPixelart]`；
- unique condition ID 与技能键；
- common / medium / android / server 文件清单；
- 每个文件的 SHA-256；
- 生成工具版本、参考图来源记录和 QA 报告路径；
- 安装前快照与回滚包标识。

逻辑路径资产先落入 `work/character_packs/seris_dragon_king/`，通过校验后再进入真实 store。导入前必须检查所有键和路径冲突：首次安装时若发现同 ID 或 code name 已被非本包占用则停止；升级时只有已安装 manifest 的包 ID 同为 `seris_dragon_king` 才允许继续，并必须先显示版本差异和 dry-run。任何情况都不做隐式覆盖。

### 发布分层

发布入口分为两块：

1. **客户端基座**：构建、签名、安装和回滚 APK；
2. **角色数据包**：写入服务端 JSON、common/medium/android store，并经 `wf_publish.py` 生成增量包。

角色数据可以通过现有 CDN 增量链下发；APK 内主 SWF 不能由服务端 diff 替换。Mod 工具可以在本机通过 ADB 安装基座，但界面不得把它描述成“服务端推送客户端补丁”。

角色包发布前检查当前客户端基座 capability。缺少 `dual_form_v1` 时允许用户明确确认后只发布数据，并清楚提示“玩法正常、像素保持人形”；不得静默声称双形态视觉已完整生效。

## Mod 工具界面

### 客户端基座页

- 显示基线 APK、补丁版本、目标 API 地址和签名证书摘要；
- 构建、P-code 校验、zipalign、签名验证；
- 自动读取 MuMu `vm_config.json` 发现漂移的 ADB 端口；
- 明确选择 APK，不从目录中猜第一个文件；
- `adb install -r --no-incremental` 安装；
- 安装失败或签名不一致时显示原始错误并停止，不自动卸载；
- 安装成功后 force-stop、仅清 AIR `cache/app/`、重启并验证 runtime marker；
- 可回滚到上一个已验证 APK；
- runtime marker 验证成功后记录 capability `dual_form_v1`。

### 角色包页

- 创建/导入 `seris_dragon_king` 包；
- 检查 ID、能力键、队长技键、技能键、unique condition 键；
- 检查 27 张角色 UI PNG、1 张状态图标、4 张 ATF、16 个双形态像素文件、5 个 Flatomo effect key/最少 12 个效果文件、22 个角色语音和 6 个 SFX；
- 预览人形/龙形像素和逐 tick 时间线；
- 预览两套技能 DSL 的分段倍率、元素、状态和帧数；
- dry-run 数据写入并展示变更；
- 写入时自动快照和逐文件备份；
- 发布 common / medium / android 增量包并提示服务端 JSON 重载或重启要求；
- 一键回滚角色数据、资产和发布版本。

## 失败处理与回滚

- 任一数据表写入、资产校验、ATF 编码、MP3 校验或 DSL 往返失败时，不进入发布阶段；
- 写入前按 manifest 逐项快照全部 table key、嵌套技能表、服务端 JSON、玛纳板、三根资产和 DSL，不使用“角色七表”这类不可验收的简称；
- APK 安装前保留当前 APK 版本、证书摘要和可恢复安装包；
- CDN 发布生成新的连续版本，不覆盖旧 diff；
- 角色回滚恢复表与 store 后，发布一个新的反向增量版本，不能要求客户端降版本；
- 客户端基座回滚使用同签名上一版 APK 覆盖安装；
- 不执行 `pm clear`、不自动卸载、不删除用户下载目录；
- 发布中断时保持上一已验证角色包为活动版本，新包只有在校验和全部匹配后才标记成功。

## 验证计划

### 静态与编译验证

- `129999`、`1299991–1299996`、队长技 `129999`、技能键和 unique condition `22` 在写入前仍为空闲；
- 所有普通表与嵌套表可读回，内层键序保持原样；
- 玛纳板节点按新角色 ID 重映射，不能指回模板角色；
- 正式技能制作前先用最小混合元素 canary，在不同水抗/雷抗敌人上证明一份 ActionDsl 可按每段显式元素分别结算；
- 人形 ActionDsl 逐段元素/倍率数组精确为 `[水1.6×5, 水2.0, 雷1.5×4]`；双减抗严格位于第 10 段之后，unique condition `22` 的自赋予位于敌人 subject 分支之外；
- 龙形 ActionDsl 逐段元素/倍率数组精确为 `[水2.0×5, 雷2.0×5]`；300 帧麻痹严格位于第 10 段之后，整棵 DSL 不含赋予/刷新 unique condition `22` 的命令；
- `switched_action_skill` 具备基础/进化完整级别和有效 program path；
- `character_speech` 可解析 8 行非战斗台词，`CharacterShortVoiceLogic` 可发现 14 个战斗 MP3，合计 22 条；
- 所有 MP3 为完整 96 kbps CBR，所有 PNG/ATF 可解码；
- 像素逐 tick 映射与 inclusive 绝对结束 tick 规则一致；
- 客户端补丁的最终 ABC/P-code 包含标签判断、matched 路径、cut-in 路径和回退分支；
- APK 通过 zipalign 和 apksigner 验证。

### 游戏内验证

1. 通过邮件发放并领取赛瑞斯，检查获取演出、角色一览、详情、玛纳板和编队；
2. 检查名称、称号、属性、种族、性别、职责、技能说明、队长技和六条能力；
3. 人形发动技能后只在最终伤害结算后进入龙形；
4. 使用具有不同水抗/雷抗的敌人分别验证 6+4 与 5+5 段实际伤害元素；
5. 用帧计数验证龙形状态为 1800 帧，龙形技能不刷新剩余时间；
6. 在同一战斗完成至少 3 次完整“人形 → 龙形 → 人形”循环；
7. 验证能力 2 和能力 6 的最多 3 次上限，换场重建不重复计数；
8. 分别在移动、掉出场地、龙形技能中途、死亡、复活、换 zone 和战斗结束时让状态到期；
9. 分别在基础/进化状态检查龙形技能名、`skill_cutin_matched_<evolution>`、matched ready/skill 语音和 dragon effect 正确切换；
10. 作为主位与副位分别验证技能选择，副位施法不得替换可见主位像素；
11. 人形检查标准 9 序列与 `form_in`；龙形检查 5 个存活序列、`matched_skill` 与 `form_out`；死亡时确认先切回人形再走棺材/幽灵/复活，全流程无黑狼、黑底、闪烁、空帧或锚点跳动；
12. 临时移除 matched 像素资源，验证安全回退到人形且战斗结果不变；
13. 在未安装基座的客户端验证数据技能、双元素伤害和 matched voice 仍可运行；
14. 验证客户端基座 APK 回滚与角色数据包反向增量回滚；
15. 对已完成基线下载、持有受支持 `res_ver` 且版本链连续的客户端，确认本次发布只下载 common/medium/android 增量。

## 完成标准

以下条件全部满足才算交付完成：

- 通用 `dual_form_v1` 基座可构建、验证、覆盖安装和回滚；
- 赛瑞斯角色包可从干净基线一次导入并通过完整模板检查；
- 角色数据、双技能、队长技、六能力和 1800 帧状态按本规格运行；
- 人形、龙形、Flatomo、UI、语音和 SFX 均为新资产且无模板角色残留；
- 22 条日语语音与中文台词稿一一对应，无剧情/words 资产；
- 对已完成基线下载、持有受支持 `res_ver` 且版本链连续的客户端，本角色发布只进行增量更新；新装、清数据或版本链断档不纳入“不触发全量”的承诺；
- 异常和缺资产场景不导致客户端崩溃或战斗判定分歧；
- 角色包和客户端基座均有经真机验证的回滚路径。
