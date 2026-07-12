# 特殊强化弹射 + Boss 连战 逆向结论(2026-07-12)

本轮四项逆向/排查的完整依据。参照角色:炎龙王瓦格纳=111183(fire_dragon_zenith)、
炎之守护者莉莉丝=111165(resistance_princess_3halfanv)、可能性的新娘索维=121177
(psycho_reaper_meteor23)、星之剑圣希尔媞=141201(wind_spgirl_4anv)。
客户端源码根:`弹国服/scripts/`(AS3 反编译)。

## 1. 强化弹射的默认链路

- 每个角色的默认弹射动作由 **character 表 col6 = speciality_type** 决定
  (0=剑士knight 1=格斗fighter 2=射手ranged 3=辅助supporter 4=特殊special,
  `SpecialityTypeTools.getPowerFlipActionId`)。
- type 名作为键查 **`master/skill/power_flip_action.orderedmap`**:
  每行 = 3 个 ActionDsl 路径(弹射 Lv1/Lv2/Lv3),如
  `battle/action/power_flip/action/special$special_lv1..3`。
- 资产解析时路径带元素后缀 `:<element>`(`PowerFlipLogic.resolvePathCollection`,
  colorless 化),同一个 DSL 按队长属性套不同演出色。
- CN 复原 store 里该表只有 5 键(special / ruin_girl / thunder_dragon /
  override_psycho_reaper_meteor23 / override_wind_spgirl_4anv),没有 knight 等默认键,
  而游戏正常 → **佐证客户端对 master orderedmap 是"行级合并进本地表",CDN 下发的是行级补丁**
  (与我们整表下发兼容:merge(本地, 全表) = 全表)。knight/fighter 等基础行在初回全量包里。
  ⚠ 推论级结论,新增键前先金丝雀(§3 步骤 6)。

## 2. 特殊强化弹射的两种官方实现

### 2A. PowerFlipOverride —— 整段替换弹射动作(索维/希尔媞式)

- 效果枚举:**instant 722 / during 419 = PowerFlipOverride**,参数三元组
  `powerflip_override.{id, levels, description_id}`。
- **挂在 leader_ability(队长技表)行上**,且客户端只在 `isLeader()` 时查
  (`MemberImpl.startPowerFlip` → `abilityTotalizer.getPowerFlipOverrides(level)`),
  即**只有主位才发动**。
- id → power_flip_action 表键(官方命名 `override_<code_name>`),该键 3 列指向专属 DSL:
  `battle/action/power_flip/action/override/override_<code>$override_<code>_lv{1,2,3}.action.dsl.amf3.deflate`
  (复原 store 已确认 6 个文件都在,600-750B,可用 wf_dsl 解析/改数值)。
- levels = 覆盖哪些蓄力等级(两例均 `1,2,3` 全覆盖);description_id →
  `master/string/custom_ability_power_up_string` 表(CN 复原 store 未见该表文件,
  在初回全量包里;新增描述键时同样按行级补丁发布)。
- 实测行(leader_ability):
  - 索维 121177 line3:during 型 col107=419,col118=id,col119='1,2,3',col120=desc,
    发动条件挂捧花等级(during_trigger 194 / start_threshold col102=18)。
  - 希尔媞 141201 line1:instant 型 col45=722,col80=id,col81='1,2,3',col82=desc,
    前置 = HP≥60%(col4=2, col7/8=600000)。
- ability / ability_soul / equipment_enhancement_ability / ex_ability 的生成类里
  同样有该枚举的解析分支(AbilityValues.parseAt82/120 等)——理论上词条/魂珠也能带,
  但官方样本只用队长技,且客户端只查主位,放非队长技意义不大。

### 2B. 弹射触发追击 —— 不换动作,弹射时插入专属技能(瓦格纳/莉莉丝式)

- 瓦格纳/莉莉丝**不在** power_flip_action 表,他们的"特殊弹射感"来自词条:
  - instant_trigger 65 = PowerFlipLv3(强化弹射Lv3 命中/发动时触发);
    precondition/during 188 = ContinuousPowerFlipLv3(连续弹射3状态中)。
  - content 629 = **InvokeSkill**:string_id + action_path 两列指向专属技能 DSL
    `battle/action/skill/action/ability_skill/ability_skill_<code>$ability_skill_<code>`。
    例:瓦格纳 leader line4、莉莉丝 leader line4(ability_skill_resistance_princess_3halfanv)。
  - 配套:content 0(追加伤害段)、461/525(固有状态赋予/消耗)、during 23(PF伤害提升)。

## 3. 设计全新特殊弹射(可行,全数据驱动,无需改客户端)

路线 A(整段替换,还原度最高):
1. `power_flip_action` 表加键 `override_<code>`,3 列填 DSL 路径
   (起步可直接指向现有 override_wind_spgirl_4anv 的三个文件,先验证链路)。
2. 目标角色 leader_ability 加一行:克隆希尔媞 141201 line1(instant 722 最简),
   col80 改成新键,col81='1,2,3';前置条件按需(HP阈值/固有状态/无条件)。
3. 要独立演出:把 6 个 override DSL 复制成新逻辑路径再用 wf_dsl JSON 编辑
   (伤害倍率/弹道/命中数都在 DSL 里;文件是官方未下发路径 = 新建文件,发布器支持)。
4. (可选)custom_ability_power_up_string 加 `override_string_<code>` 描述行。
5. 发布:power_flip_action + leader_ability(+新 DSL 文件 + 字符串表)进 pending。
   power_flip_action 需在 wf_publish TABLE_ALIASES 加别名(还没加)。
6. **金丝雀顺序**:先只发 power_flip_action(加键不引用)→ 进游戏用剑士队长确认
   普通弹射没坏(验证行级合并推论)→ 再发 leader_ability 引用行 → 目标角色主位弹射验证。

路线 B(追击式,门槛最低):任意角色词条/队长技加一行
"instant_trigger=65 + content=629 + action_path=任意技能 DSL"。
GUI 现有的词条 JSON 编辑 + 上传效果就能做,不用碰 power_flip_action。

## 3.5 实证补充(2026-07-12 晚,GUI 落地时二次逆向)

- **§1 的"行级合并"推论修正为实证**:master 表是 **RootMasterBinary 多文件 union**
  (`MasterSource`/`RootMasterBinary.getStringMap`)——APK 内置 base 文件 + 下载 store 文件
  按**整文件为单位**联合,**键重复 = ClientError 7051 直接崩**(不是行级覆盖!)。
  实测 APK bundle.zip(android_bundle 根)里有 knight/ranged/supporter 的 lv1-3 DSL,
  base 表键与 store 表 5 键互斥。⇒ 新键安全;**改 base 键的行不可行**(不能在 store 表重复它)。
- **DSL/资产文件解析是"下载优先"**(`FileReader.resolveFiles`:downloaded 存在则用,
  否则回落 bundle)⇒ 想改 knight 等内置 PF 动作:把 APK 内置文件**原样字节提进 store**
  再编辑即可(GUI 强化弹射区「提取到可编辑」按钮)。
- **GUI 已落地**(技能·倍率页「强化弹射」区):改角色种类(c6)/每级「效果词条」命令级编辑/
  「提取到可编辑」/「克隆新建」(= 本文路线 A 的 1+3 步一键化,激活词条仍照 §2A 手工挂)。
  wf_publish `TABLE_ALIASES` 已加 `power_flip_action`(§3 步骤 5 的缺口已补)。
- **动画资源链路核验**(索维/希尔媞全部 √):ShowEffect 用 `SpecifyEffectDirectly` 指
  `battle/effect/powerflip/<code>/<code>_powerflip_*`,动画 = 配对
  `.parts.amf3.deflate + .timeline.amf3.deflate`(索维每级 2 组:弹道+玩家侧;
  希尔媞每级 5 组:主体 + hit_0/90/180/270 四向命中,ConditionalsProbability 随机选一)。
  这些路径**大多不在 WF_PATHLIST_recovered**(75% 复原盲区),定位要走 DSL 提取+哈希探测
  ——「角色资产→一键导出全部资产」已按此把特效动画一并打包;自制新 PF 演出 =
  克隆种类后在 DSL 里把 SpecifyEffectDirectly 路径指到自己新建的 parts/timeline 对。

## 4. Boss 连战(多波次)编排 —— zone 表

数据链路:quest 行.battle_field_data_id → field_data col2=zone id → **zone 节点**。

- zone 节点(嵌套表)下 **每一行 = 一个 wave**,键 '0','1','2'... 顺序推进。
  全库有 187 个多 wave 且多行带 boss 的 zone(如 yokai_emaki_01_12:
  wave0=low_level_ghost+ghost_girl → wave1=middle_level_ghost×2),都是现成连战范本。
- wave 行列布局(`ZoneValues.as`):
  - col0 = objective:0=ZakoKill(col1=击杀数) 1=BossClear 2=Unspecified —— 该 wave 的过关条件
  - col2-21 = zako01..zako10:10 组 (敌人id, 出现间隔) 对,(None)=空位
  - col22 = boss_group_kind
  - col23 起 = boss1 / boss1_multi / boss2 / boss2_multi / boss3 / boss3_multi:
    每组 (kind, code) 对;kind 0=StandardBoss 1=GeneralBoss 2=Kraken 3=Orochi
    10-15=各属性 Sphere;`_multi` = 多人战变体,不是第二只
  - 尾部:instant_item_odds×3、outhole/dash_panel/rotation_panel 装置路径、装饰
- 一个 wave 最多 boss1-3 三只同场;连战 = 多行,每行一只/多只 boss,
  行 objective=1(BossClear) 打完进下一行。
- 维·索拉斯领主战(quest 1001001-1001003,multi_normal_1_1_1):单 wave,
  boss1=GeneralBoss(owl_multi) + boss1_multi 同码 —— 是"单场双人变体"结构,
  不是连战;真连战抄 187 个多 wave zone(rush/tower/活动类最多)。
- 难度控制在 quest 行(`BossBattleQuestValues.as`):battle_enemy_level、
  battle_{hp,atk,tp}_correction_value_{boss,zako,funnel}、battle_time_limit(帧)、
  battle_enemy_condition_1..5(敌方开场状态)、battle_stamina_cost、报酬列等。
- 读写都走 wf_quest_lib(三层压缩索引),GUI「JSON 直改」页支持 zone/field_data/quest 系表。

设计自定义连战配方:选一个现成 quest(或克隆行)→ 其 field_data 指向的 zone 节点
加 wave 行(从范本 zone 抄行改 boss code)→ 发布 zone(+quest)表 → 金丝雀。
boss code 必须在 general_boss/standard_boss 有对应等级行,血量在 boss_level 表调。

## 5. 星级品质三层排查结论(2026-07-12)

- 全 505 角色三层(①cdndata / ②character 表 / 服务端 assets/character.json)
  rarity/element **当前零错位**;save_char_fields 三层同步链路复核无 bug
  (老角色键≠character_id 的 10 行,①②键一致,同步不受影响)。
- **已修实锤缺口**:克隆角色只写①层两 json,漏写服务端 assets/character.json
  (邮件/admin 发放校验、升级经验上限 characterExpCaps[rarity] 都读它,
  缺条目=新角色发不进存档/服务端报错)。已补:克隆时按 row col2/col3 写
  {name,rarity,element,skill_count},删除角色时同步删条目。
- 改星级的客户端边界(改前须知):
  - EX 觉醒 cutin 只支持 3/4/5 星(`ExAbilityCutin.as`,1/2星→ClientError 3473);
  - 等级/突破校验 `CharacterLevelLogic` 按新星级查上限,已拥有角色的
    level/over_limit_step 超出新星级上限 → ClientError 2275。
    **已实锤复现**(2026-07-12):白(键10)4★→5★ 后游戏内查看即 C2275 崩溃,
    存档 over_limit_step=6 > 5★上限4(各星级上限 1★12/2★10/3★8/4★6/5★4,
    exp 上限见 src/lib/character.ts characterExpCaps,index=突破段)。
    **已修**:GUI 保存星级时自动钳制全部存档该角色的 突破段+exp
    (`wf_gui._clamp_save_for_rarity`,直连 .database/wdfp_data.db,dry-run 可预览,
    改后重启游戏生效);历史越界行已手工修复(白: 6→4,exp 379988 恰为5★满级值保留);
  - 星级还影响:玛纳板开板条件表(按 rarity 查)、进化加成表、抽卡演出档位。

## 6. EX Boost 体系(词条库/效果/存档,2026-07-12 补)

三层结构,全部可改:

| 层 | 位置 | 改什么 | 生效方式 |
|---|---|---|---|
| **效果本体** | ② `master/ex_boost/ex_ability.orderedmap`(63键,125列标准 ability schema:col0=string_id,col2=rarity,col46=效果枚举,col47=对象,col50/51=强度千分比) | 词条效果类型/强度 | 发布 CDN,客户端战斗读这里 |
| **抽取池** | 服务端 `assets/ex_ability.json`(63键镜像,**静态 import**) | 能抽到什么 | **重启服务端**(reload_assets 不覆盖) |
| **存档已有** | DB `players_characters.ex_boost_status_id` + `ex_boost_ability_id_list`(逗号分隔 id 串) | 某角色当前 EX | UPDATE 后客户端重新登录/load |

- 配套表:`ex_status`(9档:col0=string_id,col1=HP固定加成,col2=ATK固定加成,col3=rarity;
  higher_atk/balanced/higher_hp × r3/r4/r5)、`ex_boost`(素材id→tier/组,破星结晶10001-10003
  全槽,崇高辉石14001-14018 按属性)。三表已加 wf_publish 别名 + GUI「JSON 直改」
  (ex_ability/ex_status/ex_boost)。
- 服务端抽取逻辑在 `src/routes/api/exBoost.ts`:按 string_id **前缀分 A/B 组**
  (atk_self_/skilldamage_/…=A,powerflipdamage_buffextend_ 等=B)、
  **后缀 _r3/_r4/_r5 分铜银金**;每次抽 = 1 个 status + 至多 A/B 各 1 条;
  概率表 MATERIAL_PROBS 硬编码在该文件。**加新 EX 词条**:②表加键 + 服务端 json 加同键,
  string_id 必须符合前缀/后缀规则才会进对应池;改概率直接改 exBoost.ts(要 npx tsc + 重启)。
- 给存档角色直接塞任意 EX:`UPDATE players_characters SET ex_boost_status_id=<1-9>,
  ex_boost_ability_id_list='<id,id,...>' WHERE player_id=? AND id=<角色id>`。
  官方结果恒为 ≤2 条(1A+1B);塞 >2 条客户端是否全生效未验证,属金丝雀实验。
  web_api 现有端点只有 clear_ex_boost(清除),按角色设置的编辑器是候选新功能。
