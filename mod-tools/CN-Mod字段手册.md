# 世界弹射物语(CN)Mod 字段手册

> 适用:国服(雷霆)res 1.4.54 数据包 · 全部字段/枚举取自 CN 数据包 schema 现场解析与客户端反编译代码(`pinball.master.generated.*` / `pinball.common.data.*`),非猜测。
> 配套工具:startpoint-cn `mod-tools/`(网页修改器 `wf_gui.py` · 命令行 `wf_mod_tool.py` · API 契约见 `API.md`)。

---

## 一、两层数据架构

| 层 | 位置 | 谁读取 | 修改后生效方式 | 内容 |
|---|---|---|---|---|
| **① 服务端层** | `assets/cdndata/*.json`(startpoint-cn 仓库) | 私服 Node 服务端 | 重启服务端,客户端 `/load` 拉取 | 角色身份 37 字段、文本词条 12 字段、抽卡池、养成 |
| **② 客户端层** | 手机包 `WorldFlipper/dummy/download/production/upload/<xx>/<hash>` | AIR 客户端本地读取 | adb push 到模拟器 + 重启游戏 | 词条数值(ability)、基础数值(HP/ATK)、觉醒加成、能力魂、战斗表现 |

**战斗与数值计算全部在客户端本地完成**,服务端只管账号/拥有关系/养成进度。改战斗数值 = 改 ② 层;改名字/描述/稀有度显示 = 改 ① 层。

## 二、② 层数据包格式规范

### 2.1 文件定位(路径哈希)

```
文件名 = SHA1( 规范化(逻辑路径) + "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy" )
存储位置 = <文件名前2位>/<其余38位>
```

例:`master/ability/ability.orderedmap` → `1e/664c1cc8d80f4f9a69aae2c49ae8c01d1c4001`。
前缀目录(`upload` / `medium_upload` / `android_upload`)不参与哈希,只决定放哪个 store。

### 2.2 orderedmap 二进制布局(数据表通用格式)

```
[u32 索引压缩长度][zlib(索引)][行数据区]
索引 = [u32 行数] + N × [u32 key_end][u32 row_end] + key 字符串连拼
```

- `key_end` / `row_end` 均为**结尾偏移**(行 i = 数据区 [row_end(i-1), row_end(i)),行 0 从 0 起)——旧工具当成起始偏移会导致全表键值错位一格
- 普通表:每行 = zlib(CSV 文本),一键可多行(`\n` 分隔),CSV 逗号分列
- **嵌套变体**(character_status 专用):外层行 = **原样存储**的内层 orderedmap 二进制(不再 zlib);内层行才是 zlib CSV

### 2.3 schema(列定义)

每张主表配一个 **AMF3 schema** 文件(raw-deflate 压缩,`zlib.decompress(data, -15)` 解开),内含 `valueSchema`:列号、列名、isDecimal、枚举 constructors。ability 表 schema 在 CN 包内 `2b/6ca08e92d925665614cd48a37167f3618dd6e6`。

### 2.4 资源解密(非数据表文件)

- PNG:头 3 字节被 +0x20,减回即原图
- MP3:首字节最高位被清(0xff→0x7f)或明文 ID3
- 动画/布局等:zlib(可带 4 字节长度前缀)→ AMF3 对象

## 三、核心数据表总览(CN)

| 逻辑路径 | 键 | 行格式 | 用途 |
|---|---|---|---|
| `master/ability/ability.orderedmap` | ability ID(2972 键) | CSV 125 列,1-2 行/键 | 角色词条数值(本手册第四章) |
| `master/ability/leader_ability.orderedmap` | 角色 ID | 同 ability schema | 队长技 |
| `master/ability/ability_soul.orderedmap` | 能力魂 ID(436 键) | 同 ability schema | 能力魂 |
| `master/character/character.orderedmap` | 角色 ID(505 键) | CSV 37 列(第八章) | 角色身份主表(与 ① 层 character.json 同构) |
| `master/character/character_status.orderedmap` | 角色 ID(505 键) | **嵌套 orderedmap**(第十章) | 基础 HP/ATK 成长曲线 |
| `master/character/character_awake_status.orderedmap` | 角色 ID(36 键) | CSV 2 列(第十一章) | 觉醒魔晶板加成 |
| `master/character/level_cap.orderedmap` | 1/2/3 | CSV 5 列 | 等级上限组(40/50/60 级段,语义未全确认) |

---

## 四、ability 词条表 · 125 列全表(CN schema)

> 列名是**结构模板**:`trigger.values.<触发块>.values.<字段>` 层级展开。同一列在不同词条类型下具体含义随 col2 类别与各触发块枚举变化,以数值对面板为准。
> 「数值」= schema 标记 isDecimal;「枚举(N)」= 该列取值对应 N 种构造器(见第六章);其余为文本/数值混合。

| 列 | 英文列名 | 中文含义 | 类型 |
|---|---|---|---|
| 0 | `string_id` | 文本标识(词条描述引用键) | 文本 |
| 1 | `unisonable` | 可协力入队(`false`=仅主位生效,见 12.8) | 布尔 |
| 2 | `rarity` | **词条类别码**(列名叫 rarity,实际存 `attack_common` 等类别串,→ 6.1) | 类别码(20 种) |
| 3 | `battle_power` | 战力值 | 数值 |
| 4 | `trigger` | 触发器 | 枚举(3) |
| 5 | `trigger.values.precondition` | 前置条件 | 枚举(209) |
| 6 | `trigger.values.precondition.values.trigger_puller` | 前置条件·触发来源 | 枚举(11) |
| 7 | `trigger.values.precondition.values.trigger_puller.values.character_groups` | 前置条件·触发来源·角色组 | 文本/数值 |
| 8 | `trigger.values.precondition.values.threshold.power1` | 前置条件·阈值·SLv1值 | 数值 |
| 9 | `trigger.values.precondition.values.threshold.first_max` | 前置条件·阈值·SLv满级值 | 数值 |
| 10 | `trigger.values.precondition.values.character_groups` | 前置条件·角色组 | 文本/数值 |
| 11 | `trigger.values.precondition.values.unique_condition_id` | 前置条件·唯一条件ID | 文本/数值 |
| 12 | `trigger.values.precondition2` | 前置条件2 | 枚举(209) |
| 13 | `trigger.values.precondition2.values.trigger_puller` | 前置条件2·触发来源 | 枚举(11) |
| 14 | `trigger.values.precondition2.values.trigger_puller.values.character_groups` | 前置条件2·触发来源·角色组 | 文本/数值 |
| 15 | `trigger.values.precondition2.values.threshold.power1` | 前置条件2·阈值·SLv1值 | 数值 |
| 16 | `trigger.values.precondition2.values.threshold.first_max` | 前置条件2·阈值·SLv满级值 | 数值 |
| 17 | `trigger.values.precondition2.values.character_groups` | 前置条件2·角色组 | 文本/数值 |
| 18 | `trigger.values.precondition2.values.unique_condition_id` | 前置条件2·唯一条件ID | 文本/数值 |
| 19 | `trigger.values.precondition3` | 前置条件3 | 枚举(209) |
| 20 | `trigger.values.precondition3.values.trigger_puller` | 前置条件3·触发来源 | 枚举(11) |
| 21 | `trigger.values.precondition3.values.trigger_puller.values.character_groups` | 前置条件3·触发来源·角色组 | 文本/数值 |
| 22 | `trigger.values.precondition3.values.threshold.power1` | 前置条件3·阈值·SLv1值 | 数值 |
| 23 | `trigger.values.precondition3.values.threshold.first_max` | 前置条件3·阈值·SLv满级值 | 数值 |
| 24 | `trigger.values.precondition3.values.character_groups` | 前置条件3·角色组 | 文本/数值 |
| 25 | `trigger.values.precondition3.values.unique_condition_id` | 前置条件3·唯一条件ID | 文本/数值 |
| 26 | `trigger.values.instant_trigger` | 瞬发触发 | 枚举(262) |
| 27 | `trigger.values.instant_trigger.values.trigger_puller` | 瞬发触发·触发来源 | 枚举(10) |
| 28 | `trigger.values.instant_trigger.values.trigger_puller.values.character_groups` | 瞬发触发·触发来源·角色组 | 文本/数值 |
| 29 | `trigger.values.instant_trigger.values.threshold.power1` | 瞬发触发·阈值·SLv1值 | 数值 |
| 30 | `trigger.values.instant_trigger.values.threshold.first_max` | 瞬发触发·阈值·SLv满级值 | 数值 |
| 31 | `trigger.values.instant_trigger.values.threshold2.power1` | 瞬发触发·阈值2·SLv1值 | 数值 |
| 32 | `trigger.values.instant_trigger.values.threshold2.first_max` | 瞬发触发·阈值2·SLv满级值 | 数值 |
| 33 | `trigger.values.instant_trigger.values.trigger_limit` | 瞬发触发·触发次数上限 | 文本/数值 |
| 34 | `trigger.values.instant_trigger.values.cooltime` | 瞬发触发·冷却(帧) | 文本/数值 |
| 35 | `trigger.values.instant_trigger.values.character_groups` | 瞬发触发·角色组 | 文本/数值 |
| 36 | `trigger.values.instant_trigger.values.unique_condition_id` | 瞬发触发·唯一条件ID | 文本/数值 |
| 37 | `trigger.values.instant_trigger.values.multiball_group_id` | 瞬发触发·多球组 | 文本/数值 |
| 38 | `trigger.values.instant_precontent` | 瞬发前置效果 | 枚举(4) |
| 39 | `trigger.values.instant_precontent.values.target` | 瞬发前置效果·目标 | 枚举(5) |
| 40 | `trigger.values.instant_precontent.values.target.values.character_groups` | 瞬发前置效果·目标·角色组 | 文本/数值 |
| 41 | `trigger.values.instant_precontent.values.threshold.power1` | 瞬发前置效果·阈值·SLv1值 | 数值 |
| 42 | `trigger.values.instant_precontent.values.threshold.first_max` | 瞬发前置效果·阈值·SLv满级值 | 数值 |
| 43 | `trigger.values.instant_precontent.values.limit` | 瞬发前置效果·上限 | 文本/数值 |
| 44 | `trigger.values.instant_precontent.values.unique_condition_id` | 瞬发前置效果·唯一条件ID | 文本/数值 |
| 45 | `trigger.values.instant_delay` | 瞬发延迟(帧) | 文本/数值 |
| 46 | `trigger.values.instant_content` | 瞬发效果 | 枚举(724) |
| 47 | `trigger.values.instant_content.values.target` | 瞬发效果·目标 | 枚举(15) |
| 48 | `trigger.values.instant_content.values.target.values.character_groups` | 瞬发效果·目标·角色组 | 文本/数值 |
| 49 | `trigger.values.instant_content.values.target.values.multiball_group_id` | 瞬发效果·目标·多球组 | 文本/数值 |
| 50 | `trigger.values.instant_content.values.strength.power1` | 瞬发效果·强度·SLv1值 | 数值 |
| 51 | `trigger.values.instant_content.values.strength.first_max` | 瞬发效果·强度·SLv满级值 | 数值 |
| 52 | `trigger.values.instant_content.values.strength2.power1` | 瞬发效果·强度2·SLv1值 | 数值 |
| 53 | `trigger.values.instant_content.values.strength2.first_max` | 瞬发效果·强度2·SLv满级值 | 数值 |
| 54 | `trigger.values.instant_content.values.strength3.power1` | 瞬发效果·强度3·SLv1值 | 数值 |
| 55 | `trigger.values.instant_content.values.strength3.first_max` | 瞬发效果·强度3·SLv满级值 | 数值 |
| 56 | `trigger.values.instant_content.values.frame.power1` | 瞬发效果·帧数·SLv1值 | 数值 |
| 57 | `trigger.values.instant_content.values.frame.first_max` | 瞬发效果·帧数·SLv满级值 | 数值 |
| 58 | `trigger.values.instant_content.values.number.power1` | 瞬发效果·次数·SLv1值 | 数值 |
| 59 | `trigger.values.instant_content.values.number.first_max` | 瞬发效果·次数·SLv满级值 | 数值 |
| 60 | `trigger.values.instant_content.values.max_accumulation` | 瞬发效果·最大累积数 | 文本/数值 |
| 61 | `trigger.values.instant_content.values.flip_limit` | 瞬发效果·弹射次数上限 | 文本/数值 |
| 62 | `trigger.values.instant_content.values.power_flip_limit` | 瞬发效果·强化弹射次数上限 | 文本/数值 |
| 63 | `trigger.values.instant_content.values.end_power_flip_limit` | 瞬发效果·结束时强化弹射上限 | 文本/数值 |
| 64 | `trigger.values.instant_content.values.end_power_flip_accepted_levels` | 瞬发效果·结束时强化弹射等级 | 枚举(5) |
| 65 | `trigger.values.instant_content.values.character_groups` | 瞬发效果·角色组 | 文本/数值 |
| 66 | `trigger.values.instant_content.values.cancelable` | 瞬发效果·可取消 | 枚举(2) |
| 67 | `trigger.values.instant_content.values.unique_condition_id` | 瞬发效果·唯一条件ID | 文本/数值 |
| 68 | `trigger.values.instant_content.values.time` | 瞬发效果·时间 | 文本/数值 |
| 69 | `trigger.values.instant_content.values.string_id` | 瞬发效果·文本标识 | 文本/数值 |
| 70 | `trigger.values.instant_content.values.action_path` | 瞬发效果·动作路径 | 文本/数值 |
| 71 | `trigger.values.instant_content.values.by_each_trigger_puller` | 瞬发效果·按触发者分别计数 | 文本/数值 |
| 72 | `trigger.values.instant_content.values.element` | 瞬发效果·属性 | 枚举(7) |
| 73 | `trigger.values.instant_content.values.initial_multiply` | 瞬发效果·初始倍增 | 文本/数值 |
| 74 | `trigger.values.instant_content.values.multiply_trigger` | 瞬发效果·倍增触发 | 枚举(4) |
| 75 | `trigger.values.instant_content.values.multiply_trigger.values.additional_multiply` | 瞬发效果·倍增触发·追加倍增 | 文本/数值 |
| 76 | `trigger.values.instant_content.values.multiply_trigger.values.trigger_puller` | 瞬发效果·倍增触发·触发来源 | 枚举(10) |
| 77 | `trigger.values.instant_content.values.multiply_trigger.values.trigger_puller.values.character_groups` | 瞬发效果·倍增触发·触发来源·角色组 | 文本/数值 |
| 78 | `trigger.values.instant_content.values.multiply_trigger.values.threshold.power1` | 瞬发效果·倍增触发·阈值·SLv1值 | 数值 |
| 79 | `trigger.values.instant_content.values.multiply_trigger.values.threshold.first_max` | 瞬发效果·倍增触发·阈值·SLv满级值 | 数值 |
| 80 | `trigger.values.instant_content.values.multiply_trigger.values.trigger_limit` | 瞬发效果·倍增触发·触发次数上限 | 文本/数值 |
| 81 | `trigger.values.instant_content.values.powerflip_override.id` | 瞬发效果·强化弹射覆盖·ID | 文本/数值 |
| 82 | `trigger.values.instant_content.values.powerflip_override.levels` | 瞬发效果·强化弹射覆盖·等级组 | 文本/数值 |
| 83 | `trigger.values.instant_content.values.powerflip_override.description_id` | 瞬发效果·强化弹射覆盖·描述ID | 文本/数值 |
| 84 | `trigger.values.during_accumulation_trigger` | 持续累积触发 | 枚举(262) |
| 85 | `trigger.values.during_accumulation_trigger.values.trigger_puller` | 持续累积触发·触发来源 | 枚举(10) |
| 86 | `trigger.values.during_accumulation_trigger.values.trigger_puller.values.character_groups` | 持续累积触发·触发来源·角色组 | 文本/数值 |
| 87 | `trigger.values.during_accumulation_trigger.values.threshold.power1` | 持续累积触发·阈值·SLv1值 | 数值 |
| 88 | `trigger.values.during_accumulation_trigger.values.threshold.first_max` | 持续累积触发·阈值·SLv满级值 | 数值 |
| 89 | `trigger.values.during_accumulation_trigger.values.threshold2.power1` | 持续累积触发·阈值2·SLv1值 | 数值 |
| 90 | `trigger.values.during_accumulation_trigger.values.threshold2.first_max` | 持续累积触发·阈值2·SLv满级值 | 数值 |
| 91 | `trigger.values.during_accumulation_trigger.values.trigger_limit` | 持续累积触发·触发次数上限 | 文本/数值 |
| 92 | `trigger.values.during_accumulation_trigger.values.cooltime` | 持续累积触发·冷却(帧) | 文本/数值 |
| 93 | `trigger.values.during_accumulation_trigger.values.character_groups` | 持续累积触发·角色组 | 文本/数值 |
| 94 | `trigger.values.during_accumulation_trigger.values.unique_condition_id` | 持续累积触发·唯一条件ID | 文本/数值 |
| 95 | `trigger.values.during_accumulation_trigger.values.multiball_group_id` | 持续累积触发·多球组 | 文本/数值 |
| 96 | `trigger.values.during_trigger` | 持续触发 | 枚举(230) |
| 97 | `trigger.values.during_trigger.values.trigger_puller` | 持续触发·触发来源 | 枚举(11) |
| 98 | `trigger.values.during_trigger.values.trigger_puller.values.character_groups` | 持续触发·触发来源·角色组 | 文本/数值 |
| 99 | `trigger.values.during_trigger.values.threshold.power1` | 持续触发·阈值·SLv1值 | 数值 |
| 100 | `trigger.values.during_trigger.values.threshold.first_max` | 持续触发·阈值·SLv满级值 | 数值 |
| 101 | `trigger.values.during_trigger.values.trigger_limit` | 持续触发·触发次数上限 | 文本/数值 |
| 102 | `trigger.values.during_trigger.values.character_groups` | 持续触发·角色组 | 文本/数值 |
| 103 | `trigger.values.during_trigger.values.unique_condition_id` | 持续触发·唯一条件ID | 文本/数值 |
| 104 | `trigger.values.during_trigger.values.start_threshold.power1` | 持续触发·起始阈值·SLv1值 | 数值 |
| 105 | `trigger.values.during_trigger.values.start_threshold.first_max` | 持续触发·起始阈值·SLv满级值 | 数值 |
| 106 | `trigger.values.during_trigger.values.multiball_group_id` | 持续触发·多球组 | 文本/数值 |
| 107 | `trigger.values.even_if_owner_dead` | 死亡后仍生效 | 文本/数值 |
| 108 | `trigger.values.during_content` | 持续效果 | 枚举(422) |
| 109 | `trigger.values.during_content.values.target` | 持续效果·目标 | 枚举(15) |
| 110 | `trigger.values.during_content.values.target.values.character_groups` | 持续效果·目标·角色组 | 文本/数值 |
| 111 | `trigger.values.during_content.values.target.values.multiball_group_id` | 持续效果·目标·多球组 | 文本/数值 |
| 112 | `trigger.values.during_content.values.strength.power1` | 持续效果·强度·SLv1值 | 数值 |
| 113 | `trigger.values.during_content.values.strength.first_max` | 持续效果·强度·SLv满级值 | 数值 |
| 114 | `trigger.values.during_content.values.strength2.power1` | 持续效果·强度2·SLv1值 | 数值 |
| 115 | `trigger.values.during_content.values.strength2.first_max` | 持续效果·强度2·SLv满级值 | 数值 |
| 116 | `trigger.values.during_content.values.character_groups` | 持续效果·角色组 | 文本/数值 |
| 117 | `trigger.values.during_content.values.unique_condition_id` | 持续效果·唯一条件ID | 文本/数值 |
| 118 | `trigger.values.during_content.values.element` | 持续效果·属性 | 枚举(7) |
| 119 | `trigger.values.during_content.values.powerflip_override.id` | 持续效果·强化弹射覆盖·ID | 文本/数值 |
| 120 | `trigger.values.during_content.values.powerflip_override.levels` | 持续效果·强化弹射覆盖·等级组 | 文本/数值 |
| 121 | `trigger.values.during_content.values.powerflip_override.description_id` | 持续效果·强化弹射覆盖·描述ID | 文本/数值 |
| 122 | `trigger.values.opening` | 开幕效果 | 枚举(3) |
| 123 | `trigger.values.opening.values.strength.power1` | 开幕效果·强度·SLv1值 | 文本/数值 |
| 124 | `trigger.values.opening.values.strength.first_max` | 开幕效果·强度·SLv满级值 | 文本/数值 |

---

## 五、数值单位与通用规则

| 规则 | 说明 |
|---|---|
| **千分比** | 强度/阈值类数值 `1000 = 1%`(如 25000 = 25%) |
| **帧** | 时间类数值以帧计,`60 帧 = 1 秒`(cooltime/frame/instant_delay) |
| **计数阈值** | threshold `100000 = 1 次`(如 300000 = 累计 3 次触发) |
| **SLv 两端值** | 每个数值字段有一对列:`power1` = 技能等级(SLv)1 时的值,`first_max` = SLv 满级值;游戏按当前 SLv 在两端**线性插值**(依据 `AbilityPowerValue.resolve`) |
| **多行词条** | 一个 ability 键可有 1-2 行(CSV 多行),两行常为效果 A/B 或等级两端,行结构相同 |
| **布尔** | `true` / `false` 文本(如 unisonable、col108 某些用法) |
| **空值** | 空串 = 未使用;`(None)` = 显式空 |

### 面板数值合成公式(反编译 BattleCharacterLogic)

```
HP  = 基础HP(等级插值) + 突破加成 + round(0.25 × 协力者HP) + 觉醒大节点数 × hp_plus_value
ATK = 基础ATK(等级插值) + 突破加成 + round(0.25 × 协力者ATK) + 觉醒大节点数 × atk_plus_value
```

## 六、枚举速查

### 6.1 词条类别码(col2,实测 3974 行分布)

> schema 中列名为 `rarity`,实际存**类别字符串**,决定词条图标与大类。

| 类别码 | 含义 | 实测行数 |
|---|---|---|
| `attack_common` | 攻击强化(通用) | 1122 |
| `action_skill` | 技能相关(充能/伤害等) | 822 |
| `power_flip` | 强化弹射 | 360 |
| `special` | 特殊 | 338 |
| `hp_skill` | 生命/技能 | 202 |
| `condition` | 状态(赋予/抵抗) | 171 |
| `attack_black` / `attack_white` / `attack_blue` / `attack_red` / `attack_green` / `attack_yellow` | 属性攻击强化(暗/光/水/火/风/雷) | 162/133/129/89/87/85 |
| `fever` | 狂热 | 94 |
| `defense_common` | 防御强化(通用) | 54 |
| `defense_blue/black/white/green/yellow/red` | 属性防御强化 | 33/23/21/20/18/11 |

### 6.2 小枚举全表(值=存储值)

**col4 触发器**(trigger): `0`=Instant · `1`=During · `2`=Opening

**col6 前置条件·触发来源**(trigger_puller): `0`=Myself · `1`=Leader · `10`=OneOfMultiball · `2`=Second · `3`=Third · `4`=OneOfExceptMyself · `5`=OneOfParty · `6`=TotalOfExceptMyself · `7`=TotalOfParty · `8`=PreconditionTriggerPuller · `9`=SumOfParty

**col13 前置条件2·触发来源**(trigger_puller): `0`=Myself · `1`=Leader · `10`=OneOfMultiball · `2`=Second · `3`=Third · `4`=OneOfExceptMyself · `5`=OneOfParty · `6`=TotalOfExceptMyself · `7`=TotalOfParty · `8`=PreconditionTriggerPuller · `9`=SumOfParty

**col20 前置条件3·触发来源**(trigger_puller): `0`=Myself · `1`=Leader · `10`=OneOfMultiball · `2`=Second · `3`=Third · `4`=OneOfExceptMyself · `5`=OneOfParty · `6`=TotalOfExceptMyself · `7`=TotalOfParty · `8`=PreconditionTriggerPuller · `9`=SumOfParty

**col27 瞬发触发·触发来源**(trigger_puller): `0`=Myself · `1`=Leader · `2`=Second · `3`=Third · `4`=OneOfExceptMyself · `5`=OneOfParty · `6`=TotalOfExceptMyself · `7`=TotalOfParty · `8`=PreconditionTriggerPuller · `9`=OneOfMultiball

**col38 瞬发前置效果**(instant_precontent): `0`=Combo · `1`=ConsumeAllUniqueCondition · `2`=ConsumeUniqueCondition · `3`=UniqueCondition

**col39 瞬发前置效果·目标**(target): `0`=Myself · `1`=Leader · `2`=Second · `3`=Third · `4`=ContentTarget

**col47 瞬发效果·目标**(target): `0`=Myself · `1`=ExceptMyself · `10`=MinHpRelative · `11`=MinHpAbsoluteExceptMyself · `12`=MinHpRelativeExceptMyself · `13`=MultiballByGroupId · `14`=MultiballByCharacterGroup · `2`=Leader · `3`=Second · `4`=Third · `5`=Party · `6`=UnisonParty · `7`=TriggerPuller · `8`=Multiball · `9`=MinHpAbsolute

**col64 瞬发效果·结束时强化弹射等级**(end_power_flip_accepted_levels): `1`=Lv1 · `11`=Lv1OrHigher · `12`=Lv2OrHigher · `2`=Lv2 · `3`=Lv3

**col66 瞬发效果·可取消**(cancelable): `0`=Default · `1`=NotCancelable

**col72 瞬发效果·属性**(element): `0`=All · `1`=Red · `2`=Blue · `3`=Yellow · `4`=Green · `5`=White · `6`=Black

**col74 瞬发效果·倍增触发**(multiply_trigger): `0`=None · `1`=PowerFlip · `2`=SkillInvoke · `3`=Fever

**col76 瞬发效果·倍增触发·触发来源**(trigger_puller): `0`=Myself · `1`=Leader · `2`=Second · `3`=Third · `4`=OneOfExceptMyself · `5`=OneOfParty · `6`=TotalOfExceptMyself · `7`=TotalOfParty · `8`=PreconditionTriggerPuller · `9`=OneOfMultiball

**col85 持续累积触发·触发来源**(trigger_puller): `0`=Myself · `1`=Leader · `2`=Second · `3`=Third · `4`=OneOfExceptMyself · `5`=OneOfParty · `6`=TotalOfExceptMyself · `7`=TotalOfParty · `8`=PreconditionTriggerPuller · `9`=OneOfMultiball

**col97 持续触发·触发来源**(trigger_puller): `0`=Myself · `1`=Leader · `10`=OneOfMultiball · `2`=Second · `3`=Third · `4`=OneOfExceptMyself · `5`=OneOfParty · `6`=TotalOfExceptMyself · `7`=TotalOfParty · `8`=PreconditionTriggerPuller · `9`=SumOfParty

**col109 持续效果·目标**(target): `0`=Myself · `1`=ExceptMyself · `10`=MinHpRelative · `11`=MinHpAbsoluteExceptMyself · `12`=MinHpRelativeExceptMyself · `13`=MultiballByGroupId · `14`=MultiballByCharacterGroup · `2`=Leader · `3`=Second · `4`=Third · `5`=Party · `6`=UnisonParty · `7`=TriggerPuller · `8`=Multiball · `9`=MinHpAbsolute

**col118 持续效果·属性**(element): `0`=All · `1`=Red · `2`=Blue · `3`=Yellow · `4`=Green · `5`=White · `6`=Black

**col122 开幕效果**(opening): `0`=MyselfExpBoost · `1`=AllyExpBoost · `2`=ManaBoost

### 6.3 大枚举(触发/效果类型库)

以下列的枚举是 Haxe enum 构造器库,种类多、且部分行存布尔/结构标记而非枚举序号,**修改时以现有词条的写法为模板**,不要凭空填枚举号:

| 列 | 中文 | 枚举种数 | 实测高频值 |
|---|---|---|---|
| col5/12/19 | 前置条件 1/2/3 | 209 | `0`=Always(恒真,3166 行)· `1`=AlwaysWithoutConditionString(805)· 少量 Member/ConditionBuff/ConditionDebuff/Multiball/HpLow/Fever |
| col26/84/96 | 瞬发触发 / 持续累积触发 / 持续触发 | 262/262/230 | 多数行留空(触发语义由效果块内字段表达) |
| col46 | 瞬发效果 | 724 | `0`=ConditionAttackPoint(3164 行) |
| col108 | 持续效果 | 422 | 实际多存 `false`/`true`(803/2 行,结构开关用法) |

> 完整枚举名单可运行 `mod-tools/wf-mod.bat schema` 或调 `GET /api/mod/schema`(`enums` 字段)获取;网页修改器中枚举值旁自动标注英文名。

---

## 七、① 层 · character.json(角色身份,37 字段/角色)

结构:`{"<角色ID>": [[37 个字符串字段]]}`。与 ② 层 `character.orderedmap` 字段级一致(505 角色实测零差异)。

| 下标 | 字段 | 含义 / 取值规则 |
|---|---|---|
| 0 | code_name | 内部代号(如 `pirates_girl`),关联资源路径 `character/{code_name}/...` |
| 1 | (未确认) | 常为 `1` |
| 2 | rarity | 稀有度 `1`–`5` |
| 3 | element | 元素:`0`火 `1`水 `2`雷 `3`风 `4`光 `5`暗 |
| 4 | race | 种族,逗号分隔多值:Human人型 Beast兽型 Element精灵 Machine机械 Undead不死 Mystery神秘 Dragon龙族 Devil魔族 Plants植物 Aquatic水栖 |
| 5–6 | (未确认) | — |
| 7 | gender | `Male` / `Female` / 空 |
| 8 | action_skill | 主动技标识(常同 code_name) |
| 9–16 | (未确认) | 含 `(None)` 占位 |
| 17 | 键别名 | 与角色 ID 相关(如 `3`;白虎=10 行此列为 `3`) |
| 18 | leader_ability_title | 队长技称号(中文) |
| 19–24 | ability_1–6 | 六个词条槽的 ability ID(指向 ability 表键) |
| 25 | mana_board_kind | 魔晶板类型 |
| 26 | role | 定位:Attacker / Balance / Healer / Jammer / Supporter / Tank |
| 27 | base_character_id | 变体角色的原型 ID;`(None)` = 非变体 |
| 28–35 | (未确认) | 布尔/数值杂项 |
| 36 | max_ability_powers | 六槽技能等级串,如 `6,6,6,6,6,6` |

> 「未确认」列修改前先对比多个角色找规律;工具写回时未暴露字段按下标原样保留。

## 八、① 层 · character_text.json(文本词条,12 字段/角色)

| 下标 | 字段 | 示例(玛丽娜 111002) |
|---|---|---|
| 0 | 名字(中) | 玛丽娜 |
| 1 | 名字(英) | MALINA |
| 2 | 角色描述 | 率领"朱之刃"海盗团的女船长… |
| 3 | 称号 | 横渡星海的海盗船长 |
| 4 | 技能名 | 海盗猛击 |
| 5 | 技能描述 | 召唤海盗船,对领域上方的敌人… |
| 6 | 技能名＋ | 海盗猛击＋ |
| 7 | 技能描述＋ | (强化版) |
| 8–9 | (保留) | 常 `(None)` |
| 10 | 队长技称号 | 领袖船长 |
| 11 | 声优 CV | 伊藤静 |

## 九、② 层 · character_status(基础 HP/ATK)

**嵌套 orderedmap**:外层键=角色 ID(505,行=原样内层二进制);内层键=等级断点,行=zlib CSV。

| 项 | 规则 |
|---|---|
| 内层键 | 等级断点字符串:`1` / `10` / `80` / `100`(505 角色全部此四断点;168 个角色键序为 `10,1,80,100`,**写回必须保持原键序**) |
| 内层行 | `"hp,atk"` 两列整数 —— **列0=HP,列1=ATK**(依据 `CharacterStatusValues.as`) |
| 插值 | 客户端对断点排序后二分,任意等级 = 两断点线性插值**向上取整**(`Math.ceil`) |
| 取值范围 | 0 ~ 2³¹-1 整数;示例:玛丽娜 Lv1=56,9 → Lv100=3709,640 |
| 约束 | 断点等级**不可增删**(低于最小断点的等级会抛客户端错误 2268) |

## 十、② 层 · character_awake_status(觉醒加成)

平表,36 键(=国服现有觉醒魔晶板角色),每键单行 2 列。

| 项 | 规则 |
|---|---|
| 行格式 | `"atk_plus_value,hp_plus_value"` —— **列0=ATK,列1=HP,与 character_status 列序相反!**(依据 `CharacterAwakeStatusValues.as`) |
| 生效 | 面板加成 = **已点亮觉醒大节点数 × plus_value**(线性累加) |
| 示例 | 瓦格纳 `31,0` = 每大节点 ATK+31;凉月 `12,176` = 每大节点 ATK+12 & HP+176 |
| 约束 | 仅修改已有 36 键;给无觉醒板的角色新增键无效果 |

## 十一、其他相关表

| 表 | 说明 |
|---|---|
| `leader_ability` | 键=角色 ID,同 ability schema;leader 表 unisonable 列用 `0/1`,移植为常驻词条时需改 `true` |
| `ability_soul`(436 键) | 同 ability schema 全套规则(千分比 / SLv 两端值) |
| `level_cap`(键 1/2/3) | 行如 `40,12,5,0.4,0.4`,对应 40/50/60 级段的升级参数(具体列义未全确认) |
| `assets/mana_node.json`(① 层) | 魔晶板节点:manaCost、材料、能力引用 |
| `assets/ex_ability.json` / `ex_status.json`(① 层) | EX 能力 / EX 数值 |

## 十二、修改安全规则(工具已内置,手改时必读)

1. **改前备份**:工具自动生成 `.bak-wfmod-*`;手改务必先复制原文件
2. **键序不可重排**(尤其 character_status 内层)——工具按原键序写回
3. **row_end 是结尾偏移**——自写解析器最常见的坑,错一位全表位移
4. **列序陷阱**:character_status=(hp,atk) 而 awake_status=(atk,hp)
5. **取值校验**:数值 0~2³¹-1;千分比语义确认后再改;断点白名单
6. **写回压缩**:zlib 参数与原文件不同没关系(字节可不同),客户端只 inflate;格式(索引/偏移)必须严格正确
7. **同步生效**:② 层改动需 adb push 到 `/sdcard/WorldFlipper/dummy/download/production/upload/<xx>/<hash>` + 重启游戏;① 层改动重启私服服务端
8. **主位限制**:词条 unisonable=false 或字段值 202(OwnerIsMain)限制主位;解除=改 true / 202→0

## 十三、CN 与国际服(global)差异(重要)

| 项 | CN(雷霆 1.4.54) | global |
|---|---|---|
| ability schema 列数 | **125** | 119 |
| 差异点 | col81–83 多出 `powerflip_override.*`,其后整体位移 | — |
| 例:持续效果·强度·SLv1值 | **col112** | col109 |
| 角色数 | 505 | 475(缺 30 个 CN 角色) |

**任何按列号写死的工具/教程跨版本必错**;按列名解析(schema)才版本安全。本手册列号均为 **CN 125 列版**。

---

*生成于 2026-07-05 · 数据来源:CN 数据包现场解析 + wf-2.1.125-cn 反编译代码 · 配套:mod-tools/(GUI/CLI/API.md/docs/版本切换设计.md/docs/角色数据逆向与修改指南.md)*
