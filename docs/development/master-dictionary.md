# 全表列语义字典（master-dictionary）

状态：基座已建成（2026-10-26），418 表全量字典 + 守卫 + 生成器

## 1. 这是什么、解决什么

服务端对客户端内容表曾长期采用"按需裁剪 + 手工转写"，发生过三类失效：

| 失效形态 | 实证案例 |
|---|---|
| **丢列**——转换层静默丢弃列，服务端从不知道存在 | boss_battle_quest 的 viewable_need_quest 前置链（124 列只携带 ~13），跳关缺口由此而来 |
| **手抄值漂移**——键知道、值抄错 | config.json 累计 40 处错值（星碎片/玛纳上限小 10 倍、boss boost 上限 3/10 vs 官方 30/20、疯狂扭蛋上限 999 vs 50、新手倍率 1 vs 1.5） |
| **列义无字典**——位置索引裸奔，无机器可查的列名映射 | 转换器与救援计数里的 row[2]/row[7]/row[11] 魔法下标 |

本基座把客户端**权威列字典**（`wf-cn-client-as3-20261014/scripts/pinball/master/generated/*Values.as`——每表一个，字段声明序=列序，构造器逐列写出解析表达式）全量收割为服务端可查的 JSON 字典，配守卫测试防回归。

## 2. 产出物

| 产物 | 位置 |
|---|---|
| 表主清单（418/423 boot 映射 + 三源对照 + 裁剪率） | `tools/master-dictionary/inventory.json` |
| 每表列字典（列号/名称/解析规则/抽样统计/状态标记/权威来源） | `docs/master-dictionary/<table>.json` |
| 生成器（幂等，重跑一字节不差） | `tools/master-dictionary/generate.cjs` |
| 表名别名（服务端↔客户端命名差异，如 mission_regular↔regular_mission） | `tools/master-dictionary/aliases.json` |
| 服务端 bundle 键名别名（含分类标记） | `tools/master-dictionary/bundle-key-aliases.json` |
| config_iosbundled 权威 fixture（APK 解码 CSV + 解码方法） | `tools/master-dictionary/fixtures/` |
| 守卫测试（完备性审计/值漂移/字典完整性/幂等） | `tools/master_dictionary.test.cjs`（quick:runtime） |

## 3. 状态体系（每列必居其一）

- `server-used`：服务端 bundle 携带该字段（按 camelCase/snake 键名匹配）
- `client-only`：客户端消费、服务端当前不携带——**激活场景的候选清单**
- `always-empty`：CN 1.4.54 全表 (None)/空（如 boss 表 viewable_need_quest_2——本版本未启用第二前置）
- `unknown-semantics`：超出客户端读取上界（param1 最大索引）的尾巴列——客户端也不解析
- `unparsed-fragment`：Values 构造器存在反编译未还原片段，如实标记不猜

bundle 键名分类标记（`bundle-key-aliases.json`）：`__server-derived__`（服务端计算字段，如 availableFromMs）、`__cross-table__`（客户端权威列在伴随表，如 main_quest 行上的 battle_reward 族）、`__server-only__`（服务端自用键，如 support_url）。

## 4. 激活工作流（遇到新内容需求时）

1. **查字典**：`docs/master-dictionary/<table>.json` 找目标列（名称/列号/解析规则/抽样值域）；
2. **扩转换器**：在 `src/content/converters/` 增加该列的读取与产出（列号以字典为权威，不再手数下标）；
3. **翻状态**：重跑 `node tools/master-dictionary/generate.cjs`，该列自动从 client-only 变 server-used；注册表计数与守卫随提交更新。

实证案例：R-G04 领主战参加门即第一次完整走通（查 viewable 列 → 派生 join-gate 表 → 状态翻转）。

## 5. config_iosbundled 解码方法（特例权威）

CDN `orderedmap/config/config.json` 是 3 字节空表——config 真值在 **APK 内置 bundle**：

```
apk/com.leiting.wf.apk
  → assets/bundle.zip
    → production/android_bundle/20/18bd1c45a711780cd9318d786927e8457c5b0  (213B)
      = 4B 小端长度头 + 两个 zlib 流；第二流解压 = 逗号分隔 CSV（52 值）
列序权威 = ConfigValues.as 构造器的 param1[N] 声明序
```

解码结果固化在 `fixtures/config_iosbundled.csv`；值漂移守卫据此对 `assets/config.json` 全键对账（两轮共修 40 处，不得回退）。

## 6. 边界与未覆盖

- 5 表未入清单（合法 unresolved）：gacha_odds 族 4 张是**动态路径模板**（`master/gacha_odds/{oddsId}.orderedmap`，服务端已有专门的动态源定义）、scenario_command 走独立加载器；
- 字典记录的是**客户端如何解析**（列名/类型/规则）；"这列业务上什么意思"仍需结合消费点代码——抽样统计（distinct/int 范围/(None) 占比）是辅助线索；
- wf-assets-cn 视图版本 1.4.54；内容版本升级后重跑生成器即可刷新抽样与 always-empty 判定；
- 补全版源码存在少量 §§ 未还原片段，涉及表标 `unparsed-fragment`。
