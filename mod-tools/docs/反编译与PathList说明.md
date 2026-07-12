# 客户端反编译 · PathList · 觉醒系统 说明

## 一、从代码统计资源路径(不完整反编译,不超时)

游戏客户端把资源逻辑路径(如 `master/ability/ability.orderedmap`)以**字符串常量**存在 SWF 的 ActionScript 字节码(ABC)里。存储文件名 = `SHA1(逻辑路径 + 盐)`,盐已知。

`wf_extract_paths.py` 只解析 ABC 的**字符串常量池**(不反编译方法体),秒级完成:

```bash
python mod-tools/wf_extract_paths.py 弹国服/wf_M358262.apk
# 或对 2.1.125 / 1.8.1 的 SWF:
python mod-tools/wf_extract_paths.py wf-2.1.125.swf --store <你的 upload 目录>
```

输出 `mod-tools/PathList.csv`:逻辑路径 → 存储位置(hash) → 键数 → 首行样本。

**加类清单命中率翻倍**:客户端 `pinball.master.generated.*Table` 每个类对应一张表,把类名 CamelCase 转 snake_case 就是表名,配合字符串池撞库,命中大增。

```bash
# 1) 导类清单(秒级,不反编译方法体)
java -Djava.awt.headless=true -jar ffdec_26.2.1/ffdec.jar -dumpAS3 wf.swf > classlist.txt
# 2) 提取 + 撞库
python mod-tools/wf_extract_paths.py 弹国服/wf_M358262.apk --classlist classlist.txt
```

> 当前 APK 已撞出 **176 张表**,见 `PathList.csv`,涵盖 ability(含 ability_soul 能力魂、ability_statue_group)、character(含 **character_awake_status 觉醒**、character_status、level_cap)、leader_ability、equipment_enhancement(装备觉醒/强化)、ex_boost、mana_board、gacha、mission、shop 等全部核心系统。路径是代码动态拼接的 `master/{目录}/{表}.orderedmap`;换更新的 SWF(2.1.125/1.8.1)重跑即可。

## 二、完整反编译(需要方法体逻辑时)—— 规避超时

完整反编译用 **FFDec / JPEXS**(命令行,Java),关键是**分批、只导 AS3、跳过资源**,避免一次性处理 27MB SWF 超时:

```bash
# 只导出 ActionScript(-selectas3 只选脚本),不导图片/形状/声音
ffdec -format script:as -selectclass "pinball.**" -export script <输出目录> wf.swf
# 或按包分批,每次一个子包,单批耗时可控:
ffdec -format script:as -selectclass "pinball.battle.**" -export script out/battle wf.swf
ffdec -format script:as -selectclass "pinball.config.**"  -export script out/config wf.swf
```

要点:① `-selectclass` 按包过滤,逐包导出;② 不加 `-export image/shape/sound` 就不会碰资源;③ 只留 `pinball.**` 逻辑类作参考。

**实测超时/内存坑(务必看)**:
- 这些类被混淆,FFDec **完整反编译每个类约 15–20 秒**,且默认堆会 `OutOfMemoryError`。必须加大堆并后台跑,不要卡在前台 45s 超时里:
  ```bash
  nohup java -Xmx6g -Djava.awt.headless=true -jar ffdec_26.2.1/ffdec.jar \
    -config deobfuscate=1 -selectclass "pinball.abilityDescription.**" \
    -export script <输出> wf.swf > log.txt 2>&1 &
  # 隔一会儿 tail -f log.txt 看进度
  ```
- **只要路径/常量,别做完整反编译**:用上面的字符串池法(秒级),或导 P-code(`-format script:pcode`,比 AS3 快但仍需 `-Xmx`)。
- **全量反编译上万类会耗时数小时**,建议在你自己的电脑(有 GUI + 大内存)上用 FFDec 图形界面按需查看,沙盒只做定点提取。
- 最有价值的两个包:`pinball.abilityDescription`(词条描述拼装 → 做和面板一致的中文备注)、`pinball.master.generated`(表结构与路径)。

**注意:本 APK 里的 SWF 是 res 1.4.54 期的。** 要 2.1.125 或 1.8.1 的逻辑参考,请把对应 APK/SWF 放进工作文件夹,我用同样方法处理(字符串池秒级、方法体分批)。GitHub 上的 `wf-2.1.125-cn-decompiled` 可作现成参考,但这个运行环境访问不了外网,需你 clone 到本地文件夹后我才能读。

## 三、国服"角色觉醒 awake"

国服的觉醒分两类,数据都在现有表里,工具可直接改:

1. **觉醒角色(独立角色变体)**:如 `151045 觉醒野兽 莉莉丝`、`141004 觉醒的古代兵器 奈芙提姆`、`211050 觉醒之牙 白`。它们是 `character` 表里的**独立角色条目**(自己的 ability 组、队长技),在修改器左侧角色列表按名字就能找到,和普通角色一样改词条/倍率/移植。

2. **能力魂 / 装备觉醒(养成系统)**:
   - `master/ability/ability_soul.orderedmap`(436 键)—— 能力魂数值,格式同 ability schema(49/50 列=1级/满级威力)。
   - 装备觉醒(锻造石 craft_point)走 `equipment_enhancement` 系列表,属装备强化线。

需要把觉醒角色/能力魂也纳入 GUI 的下拉与批量操作,告诉我,我把 `ability_soul` 挂进编辑页(它与 ability 同 schema,可复用现有全部功能)。

## 四、现状提醒

- 之前的数据包被旧工具的 orderedmap 读写 bug 改**错位**过(丢 320 键、键值移位),已用原始备份重建修复(2972 键对齐正确)。若之前推过模拟器,记得同步一次修复表。
- 改服务端发布:服务端从 `.cdn/cn/mods/*.zip` 加载 mod 覆盖包并自动提升版本号,客户端下次启动走增量更新拉取。把改好的表打进一个 zip(`production/upload/xx/hash` 结构)放进 `mods/`,重启服务端即可。这条链路要小改一处服务端代码/加个打包脚本,下一轮做。
