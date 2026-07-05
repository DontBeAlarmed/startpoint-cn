# Boss 战与全副本分析报告(基于告别版全解锁数据)

> 生成:2026-07-06;数据源:CN store `弹国服/.../production/upload`(res 1.4.54,雷霆国服停服告别版)。
> 解析脚本:scratchpad `wf_lib.py`(压缩索引嵌套 orderedmap 解析,格式见 §2.3)。

---
## 1. 版本验证:确实是"全部战斗解锁"的告别版

- 降临/嘉年华/Raid/Rush 四类活动排期的**最大结束时间 = 2025-08-14 23:59:59**(与雷霆国服停服日一致);
  分数挑战排到 2051 年、爬塔排到 2026-05,即最后一版数据把历史活动全部排开到停服。
- 领主战 quest 起始时间最早 2000-01-01(永久开放),end=(None)。
- 结论:当前 store 就是"全部战斗解锁"版本,**所有历史副本的主数据、敌人数值、AI、动画资源全部在库**,
  缺的只有 iOS 专用 `_iosbundled` 副本(38 张,无影响)。

## 2. 数据架构(quest → 战斗 → boss 的完整链路)

### 2.1 表注册全景
- 客户端 `boot_ffc6.as` 注册 **498 张 master 表**,CN store 实际在库 **418 张**(缺失全是 iosbundled)。
- 表定位:`存储路径 = SHA1(逻辑路径+盐)[:2]/[2:]`,盐 `K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy`,与资源同规则。

### 2.2 战斗引用链(已实测打通)
```
quest 行(如 boss_battle_quest[1][1][1] 维·索拉斯)
  col109 battle_field_data_id ─→ master/battle/field_data (1431行: field,terrain,zone)
       ├─ field  ─→ master/battle/field (256行: 背景/前景/fever槽动画)
       ├─ terrain ─→ battle/terrain/**.amf3.deflate (弹射地形/挡板/机关布置)
       └─ zone   ─→ master/battle/zone (1089行,嵌套: boss1..3(+_multi)/zako01..10/objective/道具掉落)
              boss1 = "owl_multi" ─→ master/battle/boss/general_boss[owl_multi]
                    ├─ 动画: battle/boss/owl/owl(.png/.atlas/.timeline) + _shadow + _marker
                    ├─ AI:  routine_id + initial_state_id → general_boss_state / general_boss_variable
                    ├─ 招式: enemy_action1..50(内嵌 ActionDsl)
                    └─ 数值: 等级带内层键(49/79/100...) × boss_level(531行) × battle/enemy/* 修正曲线
```
- quest 关键列(BossBattleQuestValues 逆向):col0=multiplied_id,col2=名字,col5/6=起止时间,
  col69=体力,col72=推荐属性,col88-92=S~C评价件数,col106=敌人等级,col109=field_data_id,col110=BGM前缀。

### 2.3 三层嵌套 orderedmap(新破解,工具需补写入器)
- quest 系表是**压缩索引变体**:`[u32 idxlen][zlib(u32 n + n×(键尾偏移,行尾偏移) + 键名块)][zlib行blob]`,
  可递归嵌套(boss_battle_quest = 章→quest→multiplied 三层)。`wf_mod_tool` 现有读写只支持两层且索引不压缩,
  **修改 quest/boss 表需要按此格式补一个 writer(格式已完全掌握,工作量小)**。

## 3. 全副本普查(22 类,叶子行=可进入的难度条目)

| 表 | 条目 | 数据时间范围 |
|---|---|---|
| 主线 main_quest | 419 | 2000-01-01 ~ 2024-12-25 |
| 高难 ex_quest | 221 | 2000-01-01 ~ 2024-12-25 |
| 领主战 boss_battle_quest | 232 | 2000-01-01 ~ 2025-07-10 |
| 角色剧情 character_quest | 1318 | 恒常 |
| 训练场 practice_quest | 91 | ~2025-06-26 |
| 降临战 advent_event_quest | 459 | 2019-12-26 ~ 2025-08-14 |
| 嘉年华 carnival_event_quest | 171 | 2023-03-16 ~ 2025-08-14 |
| 挑战迷宫 challenge_dungeon | 46 | 2020-04-30 ~ 2023-10-26 |
| 经验/玛那日常 daily_exp_mana | 6 | 恒常 |
| 每日周常 daily_week_event | 114 | 恒常轮换 |
| 专家单人 expert_single | 28 | 2020-09-10 ~ 2025-06-26 |
| 高难多人 hard_multi_event | 12 | 2024-08-16 ~ 2025-07-10 |
| Raid raid_event_quest | 50 | 2023-09-07 ~ 2025-08-14 |
| 排名赛 ranking_event | 7 | 2020-08-21 ~ 2023-05-14 |
| Rush rush_event_quest | 110 | 2023-11-23 ~ 2025-08-14 |
| 分数挑战 score_attack | 123 | 2024-09-27 ~ 2051(常开) |
| 单人计时 solo_time_attack | 6 | 2023-12-14 ~ 2024-05-02 |
| 剧情活动 story_event_single | 348 | 2019-12-02 ~ 2025-07-06 |
| 爬塔 tower_dungeon(480层) | 480 | 2022-05-12 ~ 2026-05-12 |
| 世界剧情 world_story_event | 913 | 2020-03-13 ~ 2025-06-26 |
| 世界剧情boss world_story_boss | 96 | 2020-03-13 ~ 2025-06-19 |
| 技能预览 skill_preview_quest | 373 | 恒常 |
| **合计** | **5623** | |

## 4. 全部 Boss 名单

### 4.1 领主战节点(51 个,boss_battle_stage_node)

| 节点 | 名称 | quest ids |
|---|---|---|
| 1 | 维·索拉斯讨伐 | 40000,40001,40002 |
| 2 | 雷霆树妖讨伐 | 40010,40011,40012 |
| 3 | 不死王瑞西塔尔讨伐 | 40020,40021,40022 |
| 5 | 废墟守卫·火讨伐 | 40040,40041,40042 |
| 6 | 废墟魔像讨伐 | 40050,40051,40052 |
| 9 | 潮汐巨妖讨伐 | 40080,40081,40082 |
| 10 | 寄居蟹船长讨伐 | 40090,40091,40092 |
| 12 | 诅咒弧魔艾基尔讨伐 | 40110,40111,40112 |
| 13 | 风将獠牙骑士讨伐 | 40120,40121,40122 |
| 14 | 白虎讨伐 | 40130,40131,40132 |
| 16 | Sec-5200Li讨伐 | 40150,40151,40152 |
| 17 | 管理者讨伐 | 40160,40161,40162 |
| 19 | 妖狐讨伐 | 40180,40181,40182 |
| 20 | 八岐大蛇讨伐 | 40190,40191,40192 |
| 22 | 青之女王讨伐 | 40257,40258,40259 |
| 23 | 背鳍三兄弟讨伐 | 40263,40264,40265 |
| 24 | 猩红巨熊讨伐 | 40275,40276,40277 |
| 25 | 伊尔考普斯讨伐 | 40266,40267,40268 |
| 26 | 伊萨巴迪卡讨伐 | 40269,40270,40271 |
| 27 | 伊劳德雷斯讨伐 | 40272,40273,40274 |
| 28 | 伊尔格拉乌讨伐 | 40281,40282,40283 |
| 29 | 伊尔梅塔雷讨伐 | 40284,40285,40286 |
| 30 | 伊尔昂斯拉讨伐 | 40287,40288,40289 |
| 31 | 赤之女王讨伐 | 40293,40294,40295 |
| 32 | 方舟守护者讨伐 | 50700,50701,50702 |
| 33 | 艾基尔·嫉妒讨伐 | 40299,40300,40301 |
| 34 | 碧之女王讨伐 | 40305,40306,40307 |
| 36 | 碧之女王讨伐 | 40305,40306,40307 |
| 41 | 墨之女王讨伐 | 10000081,10000082,10000083 |
| 39 | 皓之女王讨伐 | 10000010,10000011,10000012 |
| 38 | 碧之女王讨伐 | 40305,40306,40307 |
| 40 | 金之女王讨伐 | 10000043,10000044,10000045 |
| 35 | 青之女王讨伐 | 40257,40258,40259 |
| 37 | 赤之女王讨伐 | 40293,40294,40295 |
| 71 | 方舟守护者讨伐 | 70061,70062,70063 |
| 56 | 暗唤精灵兽 | 10000127,10000128,10000129 |
| 55 | 巫光精灵兽 | 10000124,10000125,10000126 |
| 54 | 威风精灵兽 | 10000121,10000122,10000123 |
| 53 | 魁雷精灵兽 | 10000118,10000119,10000120 |
| 52 | 水狂精灵兽 | 10000115,10000116,10000117 |
| 51 | 怨炎精灵兽 | 10000112,10000113,10000114 |
| 58 | 圣夜的淘气鬼 | 10000133,10000134,10000135 |
| 57 | 为你奏响的镇魂歌 | 10000130,10000131,10000132 |
| 70 | 始龙之眼 | 10000140,10000141,10000142 |
| 66 | 暗凛机兵 | 10000091,10000092,10000093 |
| 65 | 闪哭机兵 | 10000091,10000092,10000093 |
| 64 | 碧愁机兵 | 10000091,10000092,10000093 |
| 63 | 橙悚机兵 | 10000091,10000092,10000093 |
| 62 | 苍叹机兵 | 10000091,10000092,10000093 |
| 61 | 红嫉机兵 | 10000091,10000092,10000093 |
| 60 | 无猾机兵 | 10000091,10000092,10000093 |

### 4.2 general_boss 体系(新式 boss,484 条目 / 391 个美术家族)

条目命名含场景后缀(`_single/_multi/_challenge/_expert/_rush/_tower/_raid`),同家族共用骨骼图集。
两种行形态:固定属性(col1名/col2动画),六属性复用(col3-14 = 6×(名,动画),如假人/精灵兽/巨土俑)。

| 美术家族(battle/boss/…) | 中文名 | 条目数 |
|---|---|---|
| administrator | 支配者、管理者 | 11 |
| alter_sheep_materia | 异质魔晶羊 | 9 |
| anv1_big_boss | 普罗基欧变异体 | 2 |
| arc_guardian | 方舟守护者 | 1 |
| arch_evil | 潮汐弧魔艾基尔、火焰弧魔艾基尔、诅咒弧魔艾基尔、诅咒弧魔艾基尔形态一、诅咒弧魔艾基尔形态三、诅咒弧魔艾基尔形态二、闪光弧魔艾基尔、雷鸣弧魔艾基尔、风暴弧魔艾基尔 | 37 |
| b_collabo_boss | ブラックドラゴン | 1 |
| beasts_big_boss | 玛格诺斯 | 4 |
| benzaiten | 形似弁天的魔物 | 1 |
| bird_boss_fighter | 比翼使魔·拳、风神 | 2 |
| bird_boss_wizard | 比翼使魔·魔 | 1 |
| boar_rider | 光将獠牙骑士、暗将獠牙骑士、水将獠牙骑士、炎将獠牙骑士、雷将獠牙骑士、风将獠牙骑士 | 5 |
| chocolate_bird | 巧克力妖鸟 | 2 |
| dark_matter | 深渊之兽 | 4 |
| desert_bonds_big_boss | 星辰破坏者 | 5 |
| devil_commander_boss | 伊尔比斯 | 1 |
| devil_commander_evil_boss | 诅咒伊尔比斯 | 1 |
| devil_commander_evil_envy | 艾基尔·嫉妒 | 3 |
| devil_leader_boss | 魔族男性 | 1 |
| discarded_dragon_dark | 伊尔昂斯拉 | 2 |
| discarded_dragon_fire | 伊萨巴迪卡 | 3 |
| discarded_dragon_light | 伊尔梅塔雷 | 2 |
| discarded_dragon_thunder | 伊尔考普斯 | 5 |
| discarded_dragon_water | 伊劳德雷斯 | 4 |
| discarded_dragon_wind | 伊尔格拉乌 | 4 |
| double_owl_lich_ability | 不死王 | 1 |
| double_owl_lich_direct | 不死王 | 1 |
| double_owl_lich_pf | 不死王 | 1 |
| double_owl_lich_skill | 不死王 | 1 |
| epuration_boss | 歼灭者 | 2 |
| epuration_boss_variant_ver | 异形歼灭者 | 1 |
| eye_dragon_boss | 始龙之眼 | 2 |
| eye_dragon_multibattle_boss | 始龙之眼 | 1 |
| flame_witch_boss | 红发老战士 | 1 |
| general_16dots | 伊野里翔太 | 2 |
| ghost_fox | 妖狐、岚狐、彗狐、焰狐、瑞狐、雷狐 | 6 |
| grizzly | 猩红巨熊 | 2 |
| guardian_golem | 光之魔像、废墟魔像、水之魔像 | 13 |
| guardian_totem | 废墟守卫·光、废墟守卫·暗、废墟守卫·水、废墟守卫·火、废墟守卫·雷、废墟守卫·风、诅咒图腾 | 9 |
| halloween_jack | 杰克南瓜灯 | 3 |
| haniwa_great_dark | 宵暗土机巨土俑、宵暗强振巨土俑、宵暗必杀巨土俑、宵暗直击巨土俑 | 4 |
| haniwa_great_fire | 闪火土机巨土俑、闪火强振巨土俑、闪火必杀巨土俑、闪火直击巨土俑 | 4 |
| haniwa_great_light | 溢光土机巨土俑、溢光强振巨土俑、溢光必杀巨土俑、溢光直击巨土俑 | 4 |
| haniwa_great_thunder | 奔雷土机巨土俑、奔雷强振巨土俑、奔雷必杀巨土俑、奔雷直击巨土俑 | 4 |
| haniwa_great_water | 云水土机巨土俑、云水强振巨土俑、云水必杀巨土俑、云水狂乱巨土俑 | 4 |
| haniwa_great_wind | 旋风土机巨土俑、旋风强振巨土俑、旋风必杀巨土俑、旋风直击巨土俑 | 4 |
| hermit_crab | 寄居蟹船长、深海寄居蟹 | 8 |
| hero_big_boss | 统领AI | 5 |
| hero_middle_boss | 全自动警卫SecMk2 | 4 |
| high_epuration_boss | 歼灭者 | 2 |
| hujin | 风神 | 1 |
| hungry_dragon | 古拉托顿 | 1 |
| kadomatsu_new_year | 门松、门松轰星号、门松轰星号二式 | 6 |
| lich | 不死王瑞西塔尔、闪击魅影 | 8 |
| light_guardian_boss | 白色精灵守护像、精灵守护像、精灵守护像白、精灵守护像红、精灵守护像绿、精灵守护像蓝、精灵守护像黄、精灵守护像黑、红色精灵守护像、绿色精灵守护像、蓝色精灵守护像、 | 6 |
| maou_2nd | 魔王 | 1 |
| maou_org | 丑王奥格 | 1 |
| mechanic_dragon_eater | 噬龙者 | 6 |
| middle_boss_dragon_anv1 | 黑龙 | 8 |
| middle_boss_dragon_smr20 | 基因巨龙 | 7 |
| orochi | 一闪之首、再生之首、冰狱之首、召唤之首、暴风之首、炼狱之首、轰雷之首、重力之首 | 24 |
| owl | 亚咖・索拉斯、托雷诺・索拉斯、维・索拉斯、费戈・索拉斯、连珂・索拉斯、鲁兹・索拉斯 | 4 |
| owl_ability | 亚咖・索拉斯、托雷诺・索拉斯、维・索拉斯、费戈・索拉斯、连珂・索拉斯、鲁兹・索拉斯 | 1 |
| owl_direct | 亚咖・索拉斯、托雷诺・索拉斯、维・索拉斯、费戈・索拉斯、连珂・索拉斯、鲁兹・索拉斯 | 1 |
| owl_pf | 亚咖・索拉斯、托雷诺・索拉斯、维・索拉斯、费戈・索拉斯、连珂・索拉斯、鲁兹・索拉斯 | 1 |
| owl_skill | 亚咖・索拉斯、托雷诺・索拉斯、维・索拉斯、费戈・索拉斯、连珂・索拉斯、鲁兹・索拉斯 | 1 |
| raijin | 雷神 | 1 |
| rec_android_boss | 雷克·雷吉斯塔 | 1 |
| runaway_romero | 狂暴的罗梅罗 | 1 |
| security_armor | Sec-5200Da、Sec-5200Fi、Sec-5200Li、Sec-5200Th、Sec-5200Wa、Sec-5200Wi | 5 |
| shark | 背鳍三兄弟 | 2 |
| simon_golem | 步兵人偶 | 3 |
| simon_golem_g | 忘却遗城 | 6 |
| smr21_big_boss | 噬星兽泰奥弗拉索斯 | 4 |
| smr21_middle_boss | 虚假达令Ⅱ | 3 |
| spirit_beast_fire | 火魔奥尔塔尼亚 | 1 |
| spirit_beast_thunder | 雷龟普罗格雷奥 | 2 |
| spirit_beast_water | 水鬼斯拉姆冈 | 4 |
| treant | 潮汐树妖、火焰树妖、诅咒树妖、闪光树妖、雷霆树妖、风暴树妖 | 8 |
| variant_empress | 青之女王 | 4 |
| vcollabo_towa_boss | C·F·奇迹 | 1 |
| waraboss | 守护假人、守护假人・光、守护假人・暗、守护假人・水、守护假人・火、守护假人・雷、守护假人・风、强力假人・光、强力假人・暗、强力假人・水、强力假人・火、强力假人・ | 14 |
| white_tiger_ghost | 岚爪幻虎、白虎 | 10 |
| xmas_golem_boss | 圣夜的雪像 | 1 |
| xmas_golem_green_boss | 圣夜的雪像G | 2 |
| yokai_emaki_big_boss | 前鬼后鬼 | 5 |
| yokai_emaki_middle_boss | 画龙 | 2 |
| zegura_boss_smr20 | 超人泽古拉 | 3 |
| battle/funnel/ghost_fox_avator | 瑞狐 | 1 |
| character/admin_human/pixelart | 管理者 | 1 |
| character/boss_big_bear_monster/pixelart | 疾风狂熊 | 2 |
| character/boss_big_bear_monster_dark/pixelart | 暗夜狂熊 | 2 |
| character/boss_big_bear_monster_fire/pixelart | 燃烧狂熊 | 2 |
| character/boss_big_bear_monster_light/pixelart | 闪光狂熊 | 2 |
| character/boss_big_bear_monster_thunder/pixelart | 电闪狂熊 | 2 |
| character/boss_big_bear_monster_water/pixelart | 暴雪狂熊 | 2 |
| character/boss_bug1_dark/pixelart | LIMBA-Da | 2 |
| character/boss_bug1_fire/pixelart | LIMBA-Fi | 2 |
| character/boss_bug1_light/pixelart | LIMBA-Li | 2 |
| character/boss_bug1_thunder/pixelart | LIMBA-Th | 2 |
| character/boss_bug1_water/pixelart | LIMBA-Wa | 2 |
| character/boss_bug1_wind/pixelart | LIMBA-Wi | 2 |
| character/boss_bug2_dark/pixelart | iBOW-Da | 2 |
| character/boss_bug2_fire/pixelart | iBOW-Fi | 2 |
| character/boss_bug2_light/pixelart | iBOW-Li | 2 |
| character/boss_bug2_thunder/pixelart | iBOW-Th | 2 |
| character/boss_bug2_water/pixelart | iBOW-Wa | 2 |
| character/boss_bug2_wind/pixelart | iBOW-Wi | 2 |
| character/boss_chimera/pixelart | 鲜奶奇美拉 | 1 |
| character/boss_chimera_aqua/pixelart | 水化奇美拉 | 1 |
| character/boss_clione/pixelart | 蓝色海妖 | 2 |
| character/boss_clione_dark/pixelart | 黑色海妖 | 2 |
| character/boss_clione_fire/pixelart | 红色海妖 | 2 |
| character/boss_clione_light/pixelart | 白色海妖 | 2 |
| character/boss_clione_thunder/pixelart | 黄色海妖 | 2 |
| character/boss_clione_wind/pixelart | 绿色海妖 | 2 |
| character/boss_cobra/pixelart | 红蝮蛇 | 2 |
| character/boss_cobra_dark/pixelart | 黑蝮蛇 | 2 |
| character/boss_cobra_light/pixelart | 白蝮蛇 | 2 |
| character/boss_cobra_thunder/pixelart | 黄蝮蛇 | 2 |
| character/boss_cobra_water/pixelart | 蓝蝮蛇 | 2 |
| character/boss_cobra_wind/pixelart | 绿蝮蛇 | 2 |
| character/boss_cube/pixelart | 机枪魔块·雷 | 2 |
| character/boss_cube_dark/pixelart | 机枪魔块·暗 | 2 |
| character/boss_cube_fire/pixelart | 机枪魔块·火 | 2 |
| character/boss_cube_light/pixelart | 机枪魔块·光 | 2 |
| character/boss_cube_water/pixelart | 机枪魔块·水 | 2 |
| character/boss_cube_wind/pixelart | 机枪魔块·风 | 2 |
| character/boss_curse_eye/pixelart | 恶魔之卵・黑 | 2 |
| character/boss_curse_eye_fire/pixelart | 恶魔之卵・红 | 2 |
| character/boss_curse_eye_light/pixelart | 恶魔之卵・白 | 2 |
| character/boss_curse_eye_thunder/pixelart | 恶魔之卵・黄 | 2 |
| character/boss_curse_eye_water/pixelart | 恶魔之卵・蓝 | 2 |
| character/boss_curse_eye_wind/pixelart | 恶魔之卵・绿 | 2 |
| character/boss_cyclops/pixelart | 红皮独眼巨魔 | 2 |
| character/boss_cyclops_dark/pixelart | 黑皮独眼巨魔 | 2 |
| character/boss_cyclops_light/pixelart | 白皮独眼巨魔 | 2 |
| character/boss_cyclops_thunder/pixelart | 黄皮独眼巨魔 | 2 |
| character/boss_cyclops_water/pixelart | 蓝皮独眼巨魔 | 2 |
| character/boss_cyclops_wind/pixelart | 绿皮独眼巨魔 | 2 |
| character/boss_desert_diver/pixelart | 黄毛狂奔地鼠 | 2 |
| character/boss_desert_diver_dark/pixelart | 黑毛狂奔地鼠 | 2 |
| character/boss_desert_diver_fire/pixelart | 红毛狂奔地鼠 | 2 |
| character/boss_desert_diver_light/pixelart | 白毛狂奔地鼠 | 2 |
| character/boss_desert_diver_water/pixelart | 蓝毛狂奔地鼠 | 2 |
| character/boss_desert_diver_wind/pixelart | 绿毛狂奔地鼠 | 2 |
| character/boss_desert_soldier/pixelart | 沙漠士兵、沙漠的士兵 | 3 |
| character/boss_desert_soldier_dark/pixelart | 沙漠士兵、沙漠的士兵 | 3 |
| character/boss_desert_soldier_light/pixelart | 沙漠士兵、沙漠的士兵 | 3 |
| character/boss_desert_soldier_thunder/pixelart | 沙漠士兵、沙漠的士兵 | 3 |
| character/boss_desert_soldier_water/pixelart | 沙漠士兵、沙漠的士兵 | 3 |
| character/boss_desert_soldier_wind/pixelart | 沙漠士兵、沙漠的士兵 | 3 |
| character/boss_doll_soldier_a/pixelart | 人偶兵 | 1 |
| character/boss_doll_soldier_b/pixelart | 人偶兵 | 1 |
| character/boss_enemy_demonspider/pixelart | 光罪诅咒魔蛛、冰怨诅咒魔蛛、暗虐诅咒魔蛛、焰唆诅咒魔蛛、雷恨诅咒魔蛛、风仇诅咒魔蛛 | 2 |
| character/boss_enemy_evilgiant/pixelart | 光罪诅咒魔将、冰怨诅咒魔将、暗虐诅咒魔将、焰唆诅咒魔将、雷恨诅咒魔将、风仇诅咒魔将 | 2 |
| character/boss_enemy_eviltower/pixelart | 光罪诅咒悲魔、冰怨诅咒悲魔、暗虐诅咒悲魔、焰唆诅咒悲魔、雷恨诅咒悲魔、风仇诅咒悲魔 | 2 |
| character/boss_enemy_orc/pixelart | 冰冷兽人领主 | 2 |
| character/boss_enemy_orc_dark/pixelart | 暗黑兽人领主 | 2 |
| character/boss_enemy_orc_fire/pixelart | 火焰兽人领主 | 2 |
| character/boss_enemy_orc_light/pixelart | 辉光兽人领主 | 2 |
| character/boss_enemy_orc_thunder/pixelart | 雷电兽人领主 | 2 |
| character/boss_enemy_orc_wind/pixelart | 疾风兽人领主 | 2 |
| character/boss_enemy_snowbat/pixelart | 冰冷大蝙蝠 | 2 |
| character/boss_enemy_snowbat_dark/pixelart | 暗黑大蝙蝠 | 2 |
| character/boss_enemy_snowbat_fire/pixelart | 火焰大蝙蝠 | 2 |
| character/boss_enemy_snowbat_light/pixelart | 辉光大蝙蝠 | 2 |
| character/boss_enemy_snowbat_thunder/pixelart | 雷电大蝙蝠 | 2 |
| character/boss_enemy_snowbat_wind/pixelart | 疾风大蝙蝠 | 2 |
| character/boss_enemy_snowgiant/pixelart | 冰冷阿玛斯 | 2 |
| character/boss_enemy_snowgiant_dark/pixelart | 暗黑阿玛斯 | 2 |
| character/boss_enemy_snowgiant_fire/pixelart | 火焰阿玛斯 | 2 |
| character/boss_enemy_snowgiant_light/pixelart | 辉光阿玛斯 | 2 |
| character/boss_enemy_snowgiant_thunder/pixelart | 雷电阿玛斯 | 2 |
| character/boss_enemy_snowgiant_wind/pixelart | 疾风阿玛斯 | 2 |
| character/boss_enemy_snowspirit/pixelart | 冰冷魅影 | 2 |
| character/boss_enemy_snowspirit_dark/pixelart | 暗黑魅影 | 2 |
| character/boss_enemy_snowspirit_fire/pixelart | 火焰魅影 | 2 |
| character/boss_enemy_snowspirit_light/pixelart | 辉光魅影 | 2 |
| character/boss_enemy_snowspirit_thunder/pixelart | 雷电魅影 | 2 |
| character/boss_enemy_snowspirit_wind/pixelart | 疾风魅影 | 2 |
| character/boss_enemy_snowwisp/pixelart | 冰冷灵魄 | 2 |
| character/boss_enemy_snowwisp_dark/pixelart | 暗黑灵魄 | 2 |
| character/boss_enemy_snowwisp_fire/pixelart | 火焰灵魄 | 2 |
| character/boss_enemy_snowwisp_light/pixelart | 辉光灵魄 | 2 |
| character/boss_enemy_snowwisp_thunder/pixelart | 雷电灵魄 | 2 |
| character/boss_enemy_snowwisp_wind/pixelart | 疾风灵魄 | 2 |
| character/boss_enemy_wooden_dummy/pixelart | 辉光楹树精 | 2 |
| character/boss_enemy_wooden_dummy_dark/pixelart | 暗黑楹树精 | 2 |
| character/boss_enemy_wooden_dummy_fire/pixelart | 火焰楹树精 | 2 |
| character/boss_enemy_wooden_dummy_thunder/pixelart | 雷电楹树精 | 2 |
| character/boss_enemy_wooden_dummy_water/pixelart | 冰冷楹树精 | 2 |
| character/boss_enemy_wooden_dummy_wind/pixelart | 疾风楹树精 | 2 |
| character/boss_evil/pixelart | 魔神・艾基尔 | 2 |
| character/boss_evil_fire/pixelart | 地狱之火・艾基尔 | 2 |
| character/boss_evil_light/pixelart | 地狱之光・艾基尔 | 2 |
| character/boss_evil_thunder/pixelart | 地狱之雷・艾基尔 | 2 |
| character/boss_evil_water/pixelart | 地狱之水・艾基尔 | 2 |
| character/boss_evil_weak/pixelart | 厄运艾基尔・暗 | 2 |
| character/boss_evil_weak_fire/pixelart | 厄运艾基尔・火 | 2 |
| character/boss_evil_weak_light/pixelart | 厄运艾基尔・光 | 2 |
| character/boss_evil_weak_thunder/pixelart | 厄运艾基尔・雷 | 2 |
| character/boss_evil_weak_water/pixelart | 厄运艾基尔・水 | 2 |
| character/boss_evil_weak_wind/pixelart | 厄运艾基尔・风 | 2 |
| character/boss_evil_wind/pixelart | 地狱之风・艾基尔 | 2 |
| character/boss_fox/pixelart | 风刃镰鼬 | 2 |
| character/boss_fox_dark/pixelart | 暗刃镰鼬 | 2 |
| character/boss_fox_fire/pixelart | 火刃镰鼬 | 2 |
| character/boss_fox_light/pixelart | 光刃镰鼬 | 2 |
| character/boss_fox_thunder/pixelart | 雷刃镰鼬 | 2 |
| character/boss_fox_water/pixelart | 水刃镰鼬 | 2 |
| character/boss_haniwa/pixelart | 哈宁白Z、哈宁红Z | 2 |
| character/boss_haniwa_blue/pixelart | 哈宁蓝Z | 2 |
| character/boss_haniwa_dark/pixelart | 哈宁黑Z | 2 |
| character/boss_haniwa_green/pixelart | 哈宁绿Z | 2 |
| character/boss_haniwa_yellow/pixelart | 哈宁黄Z | 2 |
| character/boss_harpy/pixelart | 风暴哈比 | 2 |
| character/boss_harpy_dark/pixelart | 地狱哈比 | 2 |
| character/boss_harpy_fire/pixelart | 灼热哈比 | 2 |
| character/boss_harpy_light/pixelart | 神圣哈比 | 2 |
| character/boss_harpy_thunder/pixelart | 雷电哈比 | 2 |
| character/boss_harpy_water/pixelart | 冰冻哈比 | 2 |
| character/boss_killer_whale/pixelart | 冰冻虎鲸 | 2 |
| character/boss_killer_whale_dark/pixelart | 地狱虎鲸 | 2 |
| character/boss_killer_whale_fire/pixelart | 灼热虎鲸 | 2 |
| character/boss_killer_whale_light/pixelart | 神圣虎鲸 | 2 |
| character/boss_killer_whale_thunder/pixelart | 雷电虎鲸 | 2 |
| character/boss_killer_whale_wind/pixelart | 风暴虎鲸 | 2 |
| character/boss_land_dragon_dark/pixelart | 暗巨蜥 | 2 |
| character/boss_land_dragon_fire/pixelart | 火巨蜥 | 2 |
| character/boss_land_dragon_light/pixelart | 光巨蜥 | 2 |
| character/boss_land_dragon_thunder/pixelart | 雷巨蜥 | 2 |
| character/boss_land_dragon_water/pixelart | 水巨蜥 | 2 |
| character/boss_land_dragon_wind/pixelart | 风巨蜥 | 2 |
| character/boss_middle_level_ghost/pixelart | 暗黑大入道 | 2 |
| character/boss_middle_level_ghost_fire/pixelart | 灼热大入道 | 2 |
| character/boss_middle_level_ghost_light/pixelart | 光明大入道 | 2 |
| character/boss_middle_level_ghost_thunder/pixelart | 迅雷大入道 | 2 |
| character/boss_middle_level_ghost_water/pixelart | 苍天大入道 | 2 |
| character/boss_middle_level_ghost_wind/pixelart | 风轮大入道 | 2 |
| character/boss_oct_helm/pixelart | 冰冻八爪盔 | 2 |
| character/boss_oct_helm_dark/pixelart | 地狱八爪盔 | 2 |
| character/boss_oct_helm_fire/pixelart | 灼热八爪盔 | 2 |
| character/boss_oct_helm_light/pixelart | 神圣八爪盔 | 2 |
| character/boss_oct_helm_thunder/pixelart | 雷电八爪盔 | 2 |
| character/boss_oct_helm_wind/pixelart | 风暴八爪盔 | 2 |
| character/boss_one_eyed_rabbit/pixelart | 风暴恶魔拉比 | 2 |
| character/boss_one_eyed_rabbit_dark/pixelart | 地狱恶魔拉比 | 2 |
| character/boss_one_eyed_rabbit_fire/pixelart | 灼烧恶魔拉比 | 2 |
| character/boss_one_eyed_rabbit_light/pixelart | 神圣恶魔拉比 | 2 |
| character/boss_one_eyed_rabbit_thunder/pixelart | 雷电恶魔拉比 | 2 |
| character/boss_one_eyed_rabbit_water/pixelart | 冰冻恶魔拉比 | 2 |
| character/boss_oni/pixelart | 暗黑大鬼 | 2 |
| character/boss_oni_fire/pixelart | 灼热大鬼 | 2 |
| character/boss_oni_light/pixelart | 光明大鬼 | 2 |
| character/boss_oni_thunder/pixelart | 迅雷大鬼 | 2 |
| character/boss_oni_water/pixelart | 苍天大鬼 | 2 |
| character/boss_oni_wind/pixelart | 风轮大鬼 | 2 |
| character/boss_paralysis_hedgehog/pixelart | 帕拉鼠·咚 | 2 |
| character/boss_paralysis_hedgehog_dark/pixelart | 帕拉鼠·铛 | 2 |
| character/boss_paralysis_hedgehog_fire/pixelart | 帕拉鼠·蹦 | 2 |
| character/boss_paralysis_hedgehog_light/pixelart | 帕拉鼠·嗖 | 2 |
| character/boss_paralysis_hedgehog_water/pixelart | 帕拉鼠·砰 | 2 |
| character/boss_paralysis_hedgehog_wind/pixelart | 帕拉鼠·哄 | 2 |
| character/boss_psychic_projection/pixelart | 影丘龙一 | 1 |
| character/boss_psychic_tomboygirl/pixelart | 绯河凛音 | 1 |
| character/boss_ruins_ghost/pixelart | 废墟幽灵·雷 | 2 |
| character/boss_ruins_ghost_dark/pixelart | 废墟幽灵·暗 | 2 |
| character/boss_ruins_ghost_fire/pixelart | 废墟幽灵·火 | 2 |
| character/boss_ruins_ghost_light/pixelart | 废墟幽灵·光 | 2 |
| character/boss_ruins_ghost_water/pixelart | 废墟幽灵·水 | 2 |
| character/boss_ruins_ghost_wind/pixelart | 废墟幽灵·风 | 2 |
| character/boss_runaway_drone_a/pixelart | 无人侦察机 | 1 |
| character/boss_runaway_drone_b/pixelart | 无人警备机 | 1 |
| character/boss_security_robot/pixelart | Sec-2600Li | 2 |
| character/boss_security_robot_dark/pixelart | Sec-2600Da | 2 |
| character/boss_security_robot_fire/pixelart | Sec-2600Fi | 2 |
| character/boss_security_robot_large/pixelart | Sec-3000Li | 2 |
| character/boss_security_robot_large_dark/pixelart | Sec-3000Da | 2 |
| character/boss_security_robot_large_fire/pixelart | Sec-3000Fi | 2 |
| character/boss_security_robot_large_thunder/pixelart | Sec-3000Th | 2 |
| character/boss_security_robot_large_water/pixelart | Sec-3000Wa | 2 |
| character/boss_security_robot_large_wind/pixelart | Sec-3000Wi | 2 |
| character/boss_security_robot_thunder/pixelart | Sec-2600Th | 2 |
| character/boss_security_robot_water/pixelart | Sec-2600Wa | 2 |
| character/boss_security_robot_wind/pixelart | Sec-2600Wi | 2 |
| character/boss_slango_blue/pixelart | 蓝波露公爵 | 2 |
| character/boss_slango_dark/pixelart | 黑波露公爵 | 2 |
| character/boss_slango_green/pixelart | 绿波露公爵 | 2 |
| character/boss_slango_light/pixelart | 白波露公爵 | 2 |
| character/boss_slango_red/pixelart | 红波露公爵 | 2 |
| character/boss_slango_yellow/pixelart | 黄波露公爵 | 2 |
| character/boss_spirit_dark/pixelart | 暗灵 | 2 |
| character/boss_spirit_fire/pixelart | 火灵 | 2 |
| character/boss_spirit_green/pixelart | 风灵 | 2 |
| character/boss_spirit_light/pixelart | 光灵 | 2 |
| character/boss_spirit_thunder/pixelart | 雷灵 | 2 |
| character/boss_spirit_water/pixelart | 水灵 | 2 |
| character/boss_turtle_striker/pixelart | 水波先锋 | 2 |
| character/boss_turtle_striker_dark/pixelart | 恶魔先锋 | 2 |
| character/boss_turtle_striker_fire/pixelart | 炽热先锋 | 2 |
| character/boss_turtle_striker_light/pixelart | 神灵先锋 | 2 |
| character/boss_turtle_striker_thunder/pixelart | 雷电先锋 | 2 |
| character/boss_turtle_striker_wind/pixelart | 疾风先锋 | 2 |
| character/chunin_dark/pixelart | 暗夜中忍 | 2 |
| character/chunin_fire/pixelart | 绯色中忍 | 2 |
| character/chunin_light/pixelart | 闪光中忍 | 2 |
| character/chunin_thunder/pixelart | 雷鸣中忍 | 2 |
| character/chunin_water/pixelart | 流水中忍 | 2 |
| character/chunin_wind/pixelart | 疾风中忍 | 2 |
| character/cyberpunk_mutant_a/pixelart | 废渣变异体 | 1 |
| character/cyberpunk_mutant_b/pixelart | 废渣变异体 | 1 |
| character/cyberpunk_soldier/pixelart | DAN警卫兵 | 1 |
| character/cyberpunk_soldier_e/pixelart | 精英DAN警卫 | 1 |
| character/desert_commander_no_piercing/pixelart | 哈里达尔 | 5 |
| character/dog_soldier/pixelart | 见习兵 | 2 |
| character/dog_soldier_dark/pixelart | 见习兵 | 2 |
| character/dog_soldier_light/pixelart | 见习兵 | 2 |
| character/dog_soldier_thunder/pixelart | 见习兵 | 2 |
| character/dog_soldier_water/pixelart | 见习兵 | 2 |
| character/dog_soldier_wind/pixelart | 见习兵 | 2 |
| character/dog_tribe/pixelart | 雷斧蛮族 | 2 |
| character/dog_tribe_dark/pixelart | 暗斧蛮族 | 2 |
| character/dog_tribe_fire/pixelart | 火斧蛮族 | 2 |
| character/dog_tribe_light/pixelart | 光斧蛮族 | 2 |
| character/dog_tribe_soldier_fire/pixelart | 红枪一等兵 | 2 |
| character/dog_tribe_soldier_thunder/pixelart | 黄枪一等兵 | 2 |
| character/dog_tribe_soldier_water/pixelart | 白枪一等兵、蓝枪一等兵、黑枪一等兵 | 2 |
| character/dog_tribe_soldier_wind/pixelart | 绿枪一等兵 | 2 |
| character/dog_tribe_water/pixelart | 水斧蛮族 | 2 |
| character/dog_tribe_wind/pixelart | 风斧蛮族 | 2 |
| character/enemy_devil_rascal/pixelart | 魔族匪徒 | 1 |
| character/enemy_devil_rascal_fire/pixelart | 魔族匪徒 | 1 |
| character/enemy_devil_rascal_light/pixelart | 魔族匪徒 | 1 |
| character/enemy_devil_rascal_thunder/pixelart | 魔族匪徒 | 1 |
| character/enemy_devil_rascal_water/pixelart | 魔族匪徒 | 1 |
| character/enemy_devil_rascal_wind/pixelart | 魔族匪徒 | 1 |
| character/enemy_devil_soldier/pixelart | 魔族战士 | 1 |
| character/enemy_devil_soldier_fire/pixelart | 魔族战士 | 1 |
| character/enemy_devil_soldier_light/pixelart | 魔族战士 | 1 |
| character/enemy_devil_soldier_thunder/pixelart | 魔族战士 | 1 |
| character/enemy_devil_soldier_water/pixelart | 魔族战士 | 1 |
| character/enemy_devil_soldier_wind/pixelart | 魔族战士 | 1 |
| character/fox_oracle/pixelart | 玉藻・稻穗 | 1 |
| character/genin/pixelart | 黑之下忍 | 2 |
| character/genin_fire/pixelart | 红之下忍 | 2 |
| character/genin_light/pixelart | 白之下忍 | 2 |
| character/genin_thunder/pixelart | 黄之下忍 | 2 |
| character/genin_water/pixelart | 蓝之下忍 | 2 |
| character/genin_wind/pixelart | 绿之下忍 | 2 |
| character/ghost_girl/pixelart | 水灵幽魂 | 2 |
| character/ghost_girl_dark/pixelart | 暗灵幽魂 | 2 |
| character/ghost_girl_fire/pixelart | 火灵幽魂 | 2 |
| character/ghost_girl_light/pixelart | 光灵幽魂 | 2 |
| character/ghost_girl_thunder/pixelart | 雷灵幽魂 | 2 |
| character/ghost_girl_wind/pixelart | 风灵幽魂 | 2 |
| character/low_level_ghost/pixelart | 黑色山童 | 2 |
| character/low_level_ghost_fire/pixelart | 红色山童 | 2 |
| character/low_level_ghost_light/pixelart | 白色山童 | 2 |
| character/low_level_ghost_thunder/pixelart | 黄色山童 | 2 |
| character/low_level_ghost_water/pixelart | 蓝色山童 | 2 |
| character/low_level_ghost_wind/pixelart | 绿色山童 | 2 |
| character/mermaid_oldman/pixelart | 人鱼老人 | 1 |
| character/mob_ticket_counter/pixelart | 自动贩卖机 | 1 |
| character/onmyoji_boy/pixelart | 五行・水善 | 1 |
| character/pirates_big/pixelart | 水之海盗 | 2 |
| character/pirates_big_dark/pixelart | 暗之海盗 | 2 |
| character/pirates_big_fire/pixelart | 火之海盗 | 2 |
| character/pirates_big_light/pixelart | 光之海盗 | 2 |
| character/pirates_big_thunder/pixelart | 雷之海盗 | 2 |
| character/pirates_big_wind/pixelart | 风之海盗 | 2 |
| character/pirates_enemy/pixelart | 恶行海盗 | 2 |
| character/pirates_enemy_captain/pixelart | 海盗船长潮汐 | 2 |
| character/pirates_enemy_captain_dark/pixelart | 海盗船长噩梦 | 2 |
| character/pirates_enemy_captain_fire/pixelart | 海盗船长火焰 | 2 |
| character/pirates_enemy_captain_light/pixelart | 海盗船长闪光 | 2 |
| character/pirates_enemy_captain_thunder/pixelart | 海盗船长雷涡 | 2 |
| character/pirates_enemy_captain_wind/pixelart | 海盗船长音速 | 2 |
| character/pirates_enemy_dark/pixelart | 恶行海盗 | 2 |
| character/pirates_enemy_fire/pixelart | 恶行海盗 | 2 |
| character/pirates_enemy_light/pixelart | 恶行海盗 | 2 |
| character/pirates_enemy_thunder/pixelart | 恶行海盗 | 2 |
| character/pirates_enemy_wind/pixelart | 恶行海盗 | 2 |
| character/stella_copy_maskoff/pixelart | 史黛拉 | 1 |
| character/white_tiger/pixelart | 白虎兽人 | 1 |
| character/wolf_assassin/pixelart | 克劳斯 | 1 |
| character/wolf_soldier/pixelart | 雷枪近卫兵 | 2 |
| character/wolf_soldier_dark/pixelart | 暗枪近卫兵 | 2 |
| character/wolf_soldier_fire/pixelart | 火枪近卫兵 | 2 |
| character/wolf_soldier_light/pixelart | 光枪近卫兵 | 2 |
| character/wolf_soldier_water/pixelart | 水枪近卫兵 | 2 |
| character/wolf_soldier_wind/pixelart | 风枪近卫兵 | 2 |

### 4.3 standard_boss(旧式标准 boss,87 条)

| 名称 | 条目 |
|---|---|
| STM-帕里德斯 | summer22_helicopter_expert, summer22_helicopter_multi, summer22_helicopter_single, summer22_helicopter_story |
| U塔罗斯∞ | halfanv3_boss_expert, halfanv3_boss_hell, halfanv3_boss_multi, halfanv3_boss_single, halfanv3_boss_story |
| 伊尔梅塔雷 | discarded_dragon_light_lv80_multi, discarded_dragon_light_lv80_single, discarded_dragon_light_rush |
| 僧正歼灭者 | high_epuration_boss_3anv |
| 光蛛杜梅欧 | spirit_beast_light_multi, spirit_beast_light_single |
| 圣夜的雪像G | xmas_golem_22_multi, xmas_golem_22_single |
| 墨之女王 | variant_empress_dark_form1_multi, variant_empress_dark_form1_single, variant_empress_dark_form2_multi, variant_empress_d |
| 女帝歼灭者 | epuration_boss_highest_main, epuration_boss_highest_multi, epuration_boss_highest_single |
| 岚之圣杯 | white_tiger_ghost_another_wind_ex |
| 异形歼灭者 | boss_epuration_boss_variant_ver_3anv |
| 德拉古寄生兽 | epuration_boss_dragon_main |
| 支配者 | administrator_another_dark_ex |
| 方舟守护者 | arc_guardian_pcollab_02_multi, arc_guardian_pcollab_02_single |
| 暗凤希亚特利欧 | spirit_beast_dark_multi, spirit_beast_dark_single |
| 暗机兵德古兰 | steampunk_dark_hard_multi, steampunk_dark_multi |
| 机工神兵菲诺梅纳 | steampunk_another_foom2_multi, steampunk_another_multi |
| 橙机兵吉布西兹 | steampunk_thunder_hard_multi, steampunk_thunder_multi, steampunk_thunder_single |
| 步兵歼灭者 | epuration_boss_3anv_multi, epuration_boss_3anv_single |
| 水之魔像 | guardian_golem_another_water_ex |
| 深海寄居蟹 | hermit_crab_another_light_ex |
| 深渊之兽云 | abyss_cloud, abyss_cloud_p3 |
| 深渊寄生兽 | anv3_big_boss_expert, anv3_big_boss_multi, anv3_big_boss_single, anv3_big_boss_story |
| 猩红巨熊 | grizzly_ex |
| 皓之女王 | variant_empress_light_form1_multi, variant_empress_light_form1_single, variant_empress_light_form2_multi, variant_empres |
| 碧之女王 | variant_empress_wind_form1_multi, variant_empress_wind_form1_single, variant_empress_wind_form2_multi, variant_empress_w |
| 碧机兵克拉格 | steampunk_wind_hard_multi, steampunk_wind_multi |
| 红机兵海茵莱特 | steampunk_fire_hard_multi, steampunk_fire_multi, steampunk_fire_single |
| 终始之龙 | chapter12_boss_story |
| 苍机兵维尔努斯 | steampunk_water_hard_multi, steampunk_water_multi, steampunk_water_single |
| 荒龙伊尔弗里德 | halfanv25_big_boss_expert, halfanv25_big_boss_multi, halfanv25_big_boss_single, halfanv25_big_boss_story |
| 赤之女王 | reine_rouge_form1_multi, reine_rouge_form1_single, reine_rouge_form2_multi, reine_rouge_form2_single |
| 金之女王 | variant_empress_thunder_form1_multi, variant_empress_thunder_form1_single, variant_empress_thunder_form2_multi, variant_ |
| 闪击魅影 | lich_another_thunder_ex |
| 闪机兵艾赞 | steampunk_light_hard_multi, steampunk_light_multi |
| 除草魔像 | turf_boss_multi, turf_boss_single |
| 风师亚特摩西亚 | spirit_beast_wind |
| 黏黏波露王 | big_slime_boss_multi, big_slime_boss_single |

### 4.4 专用硬编码 boss 表(初代大型 boss,各有独立表+专属机制)

- `kraken`: kraken_single, kraken_multi, kraken_multi_80, kraken_rush, kraken_single_tower
- `orochi`: orochi_all_head_single, orochi_all_head_multi, orochi_all_head_multi_plus
- `orochi_ex`: orochi_ex
- `orochi_ex_head`: orochi_ex_head1, orochi_ex_head2, orochi_ex_head3, orochi_ex_phase1_center, orochi_ex_phase1_left, orochi_ex_phase1_right, orochi_ex_phase3_center, orochi_ex_phase3_left, orochi_ex_phase3_right
- `touyakiren_ceo`: touyakiren_ceo_single, touyakiren_ceo_multi, touyakiren_ceo_expert_90
- `conductor`: boss_conductor_single, boss_conductor_expert_80, boss_conductor_multi
- `fire_sphere`: fire_sphere
- `water_sphere`: water_sphere_single
- `thunder_sphere`: thunder_sphere
- `wind_sphere`: wind_sphere
- `holy_sphere`: holy_sphere_single

### 4.5 小怪 general_zako(115 种,像素图与角色同管线 character/{code}/pixelart)

```
  abyss_beast1, abyss_beast1_weak, abyss_beast2, abyss_beast2_weak, big_bear_monster, bug1, bug2, chunin
  clione, cobra, cube, curse_eye, curse_eye_multi, cyberpunk_mutant_a, cyberpunk_mutant_b, cyberpunk_soldier
  cyberpunk_soldier_e, cyclops, desert_diver, desert_soldier, discarded_snake_dark, discarded_snake_thunder, discarded_snake_thunder_multi, discarded_spider_dark
  discarded_spider_thunder, discarded_spider_thunder_multi, discarded_tiny_dragon_dark, discarded_tiny_dragon_thunder, discarded_tiny_dragon_thunder_multi, dog_soldier, dog_tribe, dog_tribe_soldier
  enemy_biocreature, enemy_demonspider, enemy_demonspider_new, enemy_devil_rascal, enemy_devil_soldier, enemy_doll_soldier_a, enemy_doll_soldier_a_multi, enemy_doll_soldier_b
  enemy_doll_soldier_b_multi, enemy_dragon_human, enemy_dragon_human_funnel, enemy_evilgiant, enemy_evilgiant_new, enemy_eviltower, enemy_eviltower_new, enemy_orc
  enemy_orc_new, enemy_snowbat, enemy_snowbat_new, enemy_snowgiant, enemy_snowgiant_new, enemy_snowspirit, enemy_snowspirit_new, enemy_snowwisp
  enemy_snowwisp_new, evil, evil_multi, evil_skill_preview, evil_weak, evil_weak_multi, evil_weak_skill_preview, fox
  genin, ghost_girl, haniwa, harpy, hero_turret_a, hero_turret_b, killer_whale, kinoko
  land_dragon, low_level_ghost, magic_academy_golem_event, mermaid_residents, middle_level_ghost, mob_desert_soldier, mob_desert_soldier2, oct_helm
  one_eyed_rabbit, oni, paralysis_hedgehog, pirates, pirates_big, pirates_enemy, pirates_enemy_captain, ruins_ghost
  runaway_drone_a, runaway_drone_b, security_robot, security_robot_large, seimei_staff, shadow_snake, shadow_snake_funnel, shikigami
  slango, slango_campaign, slango_new_year, slango_new_year_5, spear_needle, spirit, tentacle_left, tentacle_left_multi
  tentacle_right, tentacle_right_multi, turtle_striker, wander_armor, wolf_soldier, wooden_dummy, wooden_dummy_new, yokai_emaki_oni
  yokai_emaki_oni_multi, yokai_emaki_oni_rush, zako_epuration_funnel
```

### 4.6 降临战(85 期,advent_event)

| id | 内部代号 | 名称 |
|---|---|---|
| 1 | advent_discarded_dragon_thunder_single | 黑雷的荒龙讨伐 |
| 2 | advent_discarded_dragon_fire | 灼炎的荒龙讨伐 |
| 3 | advent_discarded_dragon_light | 光芒的荒龙讨伐 |
| 4 | advent_elements | 美食的冒险家 |
| 5 | advent_discarded_dragon_water | 水蚀的荒龙讨伐 |
| 6 | advent_discarded_dragon_fire2 | 灼炎的荒龙讨伐复刻 |
| 7 | advent_discarded_dragon_dark | 凶暗的荒龙讨伐 |
| 9 | advent_hw20 | 为你奏响的镇魂歌 |
| 10 | advent_discarded_dragon_thunder2 | 雷废龙讨伐复刻 |
| 11 | advent_xm20 | 圣夜的淘气鬼 |
| 12 | advent_discarded_dragon_water2 | 水废龙讨伐复刻 |
| 13 | advent_discarded_dragon_wind | 歼风的荒龙 |
| 14 | advent_spirit_beast_thunder | 魁雷精灵兽 |
| 15 | advent_spirit_beast_water | 水狂精灵兽 |
| 16 | advent_hw21 | 为你奏响的镇魂歌 |
| 17 | advent_xm21 | 圣夜的淘气鬼 |
| 19 | advent_spirit_beast_fire | 怨炎精灵兽 |
| 18 | advent_discarded_dragon_dark_1 | 凶暗的荒龙讨伐 |
| 20 | advent_spirit_beast_light | 巫光精灵兽 |
| 21 | advent_spirit_beast_thunder2 | 魁雷精灵兽 |
| 22 | advent_spirit_beast_storm | 威风精灵兽 |
| 23 | advent_spirit_beast_dark | 暗唤精灵兽 |
| 3000 | advent_discarded_dragon_fire2_1 | 灼炎的荒龙讨伐复刻 |
| 3001 | advent_discarded_dragon_light_2022 | 光废龙讨伐复刻 |
| 100001 | advent_Zcollab_event | 阻止暴走的罗梅罗~另一个SAGA的传奇 |
| 100002 | advent_Rcollab_event | 异界漂泊谭 |
| 100003 | advent_Zcollab_event2 | 阻止暴走的罗梅罗~另一个SAGA的传奇 |
| 100004 | advent_Gcollab_event | Cross Blue |
| 100005 | advent_discarded_dragon_fire2_2 | 灼炎的荒龙讨伐复刻 |
| 100006 | advent_Scollab_event | 凉宫春日的跳跃 |
| 100007 | advent_discarded_dragon_light_2023 | 光废龙讨伐复刻 |
| 100008 | advent_spirit_beast_thunder_re_2023 | 魁雷精灵兽复刻 |
| 200002 | advent_spirit_beast_storm2 | 威风精灵兽 |
| 200004 | advent_spirit_beast_water2 | 水狂精灵兽 |
| 200006 | advent_revival_Rcollab_event | 异界漂泊谭 |
| 200009 | advent_spirit_beast_thunder3 | 魁雷精灵兽 |
| 200011 | advent_spirit_beast_light2 | 巫光精灵兽 |
| 200014 | advent_steam_robot_fire | 红嫉机兵 |
| 3002 | advent_spirit_beast_water1_1 | 水狂精灵兽 |
| 100010 | advent_eye_dragon_multibattle_202310 | 始龙之眼讨伐 |
| 200012 | advent_spirit_beast_water3 | 水狂精灵兽 |
| 200017 | advent_steam_robot_wind | 碧愁机兵 |
| 200018 | advent_steam_robot_water | 苍叹机兵 |
| 300003 | advent_eye_dragon_202503_multibattle | 始龙之眼讨伐 |
| 300004 | advent_Gcollab_constant | Cross Blue |
| 100009 | advent_u_collabo_event | 摇曳彼方的新大门 |
| 300005 | advent_u_collabo_constant | 摇曳彼方的新大门 |
| 200080 | kc_yokai_emaki_big_boss | 鹄和凉月的特别训练！ |
| 200055 | kc_summer_2023 | 鹄和凉月的特别训练！ |
| 200028 | kc_summer_2021 | 鹄和凉月的特别训练！ |
| 200063 | kc_hero_big_boss | 鹄和凉月的特别训练！ |
| 200068 | kc_guardian_golem_light | 鹄和凉月的特别训练！ |
| 200075 | kc_discarded_dragon_water | 鹄和凉月的特别训练！ |
| 200037 | kc_anv1 | 鹄和凉月的特别训练！ |
| 300000 | advent_k_collabo_event | 为奇迹的邂逅献上祝福！ |
| 200021 | boss_epuration_event_02 | 歼灭者讨伐战 |
| 200013 | boss_epuration_event_01 | 歼灭者讨伐战 |
| 300001 | advent_b_collabo_event | 不諦の魔道士 |
| 200015 | advent_xm22 | 圣夜的淘气鬼 |
| 200072 | advent_variant_hw_fire_20231031_20231113 | 为你奏响的镇魂歌 |
| 200069 | advent_variant_empress_wind_20230929_20231012 | 碧之女王 |
| 200070 | advent_variant_empress_thunder_20231013_20231022 | 金之女王 |
| 200062 | advent_variant_empress_light_20230814_20230828 | 皓之女王 |
| 200079 | advent_variant_empress_dark_20231130_20231213 | 墨之女王 |
| 200064 | advent_steam_robot_thunder_20230831_20230914 | 橙悚机兵 |
| 200053 | advent_steam_robot_light_20230531_20230616 | 闪哭的机兵 |
| 200077 | advent_steam_robot_dark_20231130_20231214 | 暗凛机兵 |
| 200081 | advent_steam_robot_another_20231220_20240108 | 无猾机兵 |
| 200059 | advent_spirit_beast_water_20230707_20230721 | 水狂精灵兽 |
| 200025 | advent_spirit_beast_thunder4 | 魁雷精灵兽 |
| 200052 | advent_spirit_beast_storm_20230608_20230622 | 威风精灵兽 |
| 200056 | advent_spirit_beast_light_20230616_20230630 | 巫光精灵兽 |
| 200038 | advent_spirit_beast_light_20230414_20230428 | 巫光精灵兽 |
| 200020 | advent_spirit_beast_light3 | 巫光精灵兽 |
| 200065 | advent_spirit_beast_fire_20231006_20231020 | 怨炎精灵兽 |
| 200051 | advent_spirit_beast_fire_20230515_20230531 | 怨炎精灵兽 |
| 200019 | advent_spirit_beast_fire3 | 怨炎精灵兽 |
| 200005 | advent_spirit_beast_fire2 | 怨炎精灵兽 |
| 200074 | advent_spirit_beast_dark_20231031_20231113 | 暗唤精灵兽 |
| 200016 | advent_spirit_beast_dark2 | 暗唤精灵兽 |
| 200010 | advent_hw22 | 为你奏响的镇魂歌 |
| 300002 | advent_hw23 | 为你奏响的镇魂歌 |
| 200076 | advent_boss_epuration_5 | 歼灭者讨伐战 |
| 200071 | advent_boss_epuration_20230929_20231012 | 歼灭者讨伐战 |
| 200050 | advent_boss_epuration_20230515_20230531 | 歼灭者讨伐战 |

## 5. Boss 战动画资源流程(完整管线)

### 5.1 资源族与格式
```
battle/boss/{family}/{form}/
  ├─ {form}.png                    图集纹理(PNG头3字节+0x20混淆,wf_assets.py 可解)
  ├─ {form}.atlas.amf3.deflate     图集切片表(zlib+AMF3)
  ├─ {form}.timeline.amf3.deflate  骨骼/帧动画时间轴(zlib+AMF3)
  ├─ {form}_shadow.timeline...     影子动画(general_boss col26 引用)
  └─ {form}_marker(.timeline)      弱点/锁定标记(col25 引用;弱点组另见 boss_weak_point_marker_set)
```
- 实测 118 个去重动画根路径中 **81 个三件套(png+atlas+timeline)齐全**;其余 37 个是子部件
  (如八岐大蛇 8 首各自只有 timeline,**共享父家族的 png/atlas**),并非缺资源。
- 人形 boss(如管理者人形/联动角色)直接用 `character/{code}/pixelart/pixelart` 像素表,与可用角色同管线。
- standard_boss 用 `battle/enemy/boss/*` 路径(名称+路径两列的轻量表)。
- 小怪 zako:六属性各一套 `character/{code}_{elem}/pixelart/pixelart`。
- 战场:背景动画在 field 表,地形在 `battle/terrain/**`(1211 个文件),场景物件 `battle/field_object/**`(785)。
- 通用特效:`battle/boss/common/*`(潮水/龙卷/护盾/死亡爆炸等),攻击 cut-in `battle/common/layer1/enemy_attack_cutin`。
- BGM:quest col110 前缀 → battle_bgm_group(203 行) → bgm/** mp3(首字节混淆)。

### 5.2 加载顺序(客户端 FileReader 逆向)
1. 进关卡:读 quest 行 → field_data → 并行拉 field 背景、terrain 地形、zone;
2. zone 列出的 boss/zako code → 各 boss 表行 → 收集 animation/shadow/marker 路径;
3. 所有逻辑路径经 SHA1+盐 → store 文件名,zlib/AMF3 解码后进入渲染;
4. AI 按 routine_id 驱动 general_boss_state 状态机,招式为行内 enemy_action1..50 的 ActionDsl。

## 6. 修改/添加 Boss 战可行性(按难度分级)

| 级 | 目标 | 可行性 | 要点 |
|---|---|---|---|
| S0 | 改 boss 数值/掉落/体力 | ✅ 立即可行 | boss_level(平表)、quest 奖励列;发布走 wf_publish(需加表别名) |
| S1 | 换 boss(现有关卡换敌人) | ✅ 可行 | 改 zone 行 boss1/zako 字段指向任意现有 code;zone 是嵌套表,保持键序 |
| S2 | "新"boss(克隆美术+改AI/数值) | ✅ 可行 | 资源字节复制到新逻辑路径(哈希可算),general_boss 加行,换名换数值换招式 |
| S3 | 新增关卡节点(新领主战入口) | ⚠️ 需补工具 | stage_node+quest 三层压缩索引写入器;服务端 assets/boss_battle_quest.json 加条目 |
| S4 | 全新骨骼动画 | ❌ 不建议 | timeline AMF3 重编码成本高;建议 S2 换皮(改 png 即可换外观) |

### 6.1 服务端耦合(startpoint-cn)
- 出发/结算:`src/routes/api/singleBattleQuest.ts`(start/finish),quest 元数据来自 `assets/*.json`
  (boss_battle_quest.json 232 条,键形如 1001001 ≈ 1e6+quest×1000+multiplied,与客户端上报 quest_id 一致);
- 前置校验:`src/lib/quest/start-handler.ts` 只查前置 quest 完成度与体力/道具,**不校验 quest 是否"存在于客户端"**;
- 因此 S1/S2(不加新 quest id)**服务端零改动**;S3 需同步给 assets/*.json 加条目(①层,重启即生效)。

### 6.2 落地工具缺口(按优先级)
1. `wf_publish.py` TABLE_ALIASES 增加:`general_boss`、`boss_level`、`zone`、`field_data`、`boss_battle_quest`、`boss_battle_stage_node` 等;
2. `wf_mod_tool.py` 增加压缩索引 zmap 读写(读已在 scratchpad wf_lib.py 验证,写=对称重打包);
3. (可选)GUI 加"Boss/关卡"tab:zone 换怪、boss 数值、领主战列表。

## 7. 关键表存储定位(速查)

| 逻辑路径 | store 相对位置 |
|---|---|
| master/battle/boss/general_boss.orderedmap | ec/d8f66b60947ca05643c4080a6cc925c750b9d6 |
| master/battle/boss/general_boss_state.orderedmap | 0b/97162ce6d40c473cbac39fa21427688922a48a |
| master/battle/boss/general_boss_variable.orderedmap | 82/93e535e806d70640f45950db1fe14ed9482bdf |
| master/battle/boss/boss_level.orderedmap | 19/a4aa442b3249499356e7a3f6370e530bfe355e |
| master/battle/boss/standard_boss.orderedmap | d1/73e8ff929070d4c0bbef95fa679afcfa1c203f |
| master/battle/zako/general_zako.orderedmap | 40/7bd387079092ff09744d22f4aaf0ba27c3817e |
| master/battle/zone.orderedmap | cd/6336795a27ea33bf8d0c5d5a9bfb466bedcf1e |
| master/battle/field_data.orderedmap | 30/363f8364e183905b2d0b48b8718b7165135bc2 |
| master/battle/field.orderedmap | ec/e713173d2a64a77c28c927869135297ba5d074 |
| master/quest/boss_battle_quest.orderedmap | eb/f8ef19148af9c1330b78c7fb3ce75e3f202e64 |
| master/quest/boss_battle_stage_node.orderedmap | 97/efacb322621f7bf6671dad3bdf7bdc55cb350b |
| master/quest/event/advent_event_quest.orderedmap | 6b/ef338822b2c963eb40c67b3d43a3b3f911ad73 |

---
*解析工具与中间数据:会话 scratchpad(`wf_lib.py`/`master_census.py`/`bosses.json`/`analysis.json`);*
*正式并入 mod-tools 前请先补 zmap writer 并金丝雀验证。*