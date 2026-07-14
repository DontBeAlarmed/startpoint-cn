# 可选补丁:boss 塔每次进本随机(random-floor)

配合 `mod-tools/wf_chain_build.py --pool`(或 GUI 连战塔页「每次进本随机」模式)使用:
floor 表键写成「魔法头行 + boss 层池」,客户端**每次构建 quest 时**从池里随机抽 K 层——
真·每次进本全 boss 随机,无需重新发布数据。

> ## ❌ indexOf 版真机同样未通过(2026-07-14)——排除"运算符"假设
> 假设:FFDec 只编坏字符串 `==`,改 `battle_field_data_id.indexOf("__random__") != -1`
> (omni-element 实证可用的 indexOf 模式)可绕开。**实测:回编字节级导出守卫存活、类未坏,
> 但真机进宝物域 2001 仍 C8601(与 == 版一字不差)。** ⇒ **问题不在运算符,在"往
> getTowerFloorValues 插一整个新块(新 if + 6 局部 + while 洗牌)"本身**被直编器编成运行时
> 不等价字节码。omni-element 能用 = 它只**改一句已有表达式**(给现有 if 加 `||`),不是插块。
> 全链路(FFDec 导出/replace/回读/zipfile 回填/zipalign/apksigner/装包/发布/金丝雀)已打通并
> 验证,签名 hashCode=设备已装(干净更新),`build_instrumented_apk.py` 是现成回封范本
> (口令 wfmod2026)——**唯一没跨过的就是这一个方法的回编正确性**。
> **剩余路径**(2026-07-14 用户暂收手,回退固定链 + PC 侧 wf_rogue_reroll/wf_chain_build 重摇):
>   ① 无循环简化块(去 while,改随机起点连续 K 层,只剩 if+slice+4 局部;文档判"回编最稳",**未试**);
>   ② P-code 直接注入方法体(绕开 AS3 直编,根治,但需手写 AVM2 汇编)。
>
> ## ⚠ 历史:真机未通过(2026-07-13,字符串 == 版)
> FFDec `-air -replace` 回编本补丁后**真机不生效**:进宝物域(Tower quest)时
> `getTowerFloorValues` 的头行守卫 `_rfHead.battle_field_data_id == "__random__"`
> 运行时判**假**,`__random__` 头行漏进循环 → `createBattleQuestSafeFloorValues`
> 拿它当 field_data 查表 → **ClientError C8601「指定的Key不存在。key=__random__」**(进本即崩)。
> 反编译回读证实字节码里守卫**在**、源码正确(无类型 `_loc2_[0]` 与强类型 `FloorValues` 两种写法均试,
> 崩溃堆栈逐字节一致),数据层也正确(floor 表 __random__ 确在 row 0,MasterArray.init 保序不排序,
> FloorValues 属性映射 param[0]→field_data_id 无误)。共同变量 = **FFDec 实验性 AS3 直编**
> 对该方法插入块/字符串字面量比较编译出运行时不等价字节码(即 README「回编风险」实锤)。
> **修复方向**:改用 **P-code 编辑**注入(绕开 AS3 直编),或换**数值哨兵**(把头行标记放进
> 客户端按 int 读的列、用数值比较代替字符串字面量比较)。固定链模式(无 `__random__` 头行,
> `--floors`/GUI「固定链」)**不受影响、真机正常**——连战塔 boss 连打本身已验证可玩,
> 受阻的**仅是「每次进本随机」这一档**。GUI 连战塔页两档均已就绪,随机档等本补丁修好后即可用。

## 机制依据(2026-07-12 逆向)

- Tower 类 quest(挑战迷宫/幽玄域/摇曳的迷宫)的层链由
  `BattleQuestBaseImpl.getTowerFloorValues / getTowerNoClearRankFloorValues` 读取:
  `FloorTable.get_data().get(tower_floor_id)` → FloorValues 数组 → 逐层生成。
- 该函数**每次构建 quest 逻辑对象时执行**(进选关/开战都会新建)⇒ 在这里抽样 = 每次进本重摇。
- 不能只补 `MasterArray.init`:`MasterMapBase.getByIndex` 有按键缓存(hasCache/setCache),
  init 每会话只跑一次 ⇒ 那样只能做到"每次重启游戏随机"。

## 数据约定(打完补丁才能发!)

floor 键首行为魔法头行,之后每行一个候选层:

```
__random__,5,-
<field_data_id>,<bgm_prefix>,<thumbnail>     ← 候选层 ×N(≥K)
...
```

- 头行:col0=`__random__` 固定标记,col1=每次抽取的层数 K,col2 占位。
- ⚠ **未打补丁的客户端读到此数据会把 `__random__` 当 field_data 解析 → 崩溃**。
  所以:先给所有玩家换补丁 APK,再发 pool 模式数据;回退 = 重发固定链(`--floors` 模式)。

## 客户端改动(1 个文件,2 处同构插入)

文件:`pinball/common/data/quest/battle/BattleQuestBaseImpl.as`

锚点行(出现 2 次:getTowerNoClearRankFloorValues / getTowerFloorValues,**两处都插**):

```as3
         var _loc2_:Array = logicAssets.getMasterTable(FloorTable).get_data().get(param1.tower_floor_id);
```

在锚点行之后插入:

```as3
         if(int(_loc2_.length) > 0 && _loc2_[0].battle_field_data_id == "__random__")
         {
            var _rfK:int = int(_loc2_[0].battle_bgm_prefix);
            var _rfPool:Array = _loc2_.slice(1);
            var _rfI:int = int(_rfPool.length);
            while(_rfI > 1)
            {
               var _rfJ:int = int(Math.random() * _rfI);
               _rfI--;
               var _rfT:* = _rfPool[_rfI];
               _rfPool[_rfI] = _rfPool[_rfJ];
               _rfPool[_rfJ] = _rfT;
            }
            if(_rfK < 1)
            {
               _rfK = 1;
            }
            if(_rfK > int(_rfPool.length))
            {
               _rfK = int(_rfPool.length);
            }
            _loc2_ = _rfPool.slice(0,_rfK);
         }
```

自动应用:`bash apply-random-floor.sh <FFDec导出的AS3目录>`,然后按 `README.md` 回封 SWF/重签 APK。

## 已知风险与金丝雀

1. **双构建资产错配(最大风险)**:开战资产预载遍历 quest 对象的 floorValues;若加载用的
   对象和战斗用的对象是**两次构建**(两次抽样结果不同),会缺层资产 → F2058/黑屏。
   金丝雀:池给 8 行、K=3,连打三次观察换层是否正常。若复现错配,改为
   "对象内一次抽样"仍成立(同一实例内 floorValues 只算一次),需把抽样结果缓存到
   quest 实例字段(补丁加一个成员变量,仍是小改)。
2. **FFDec 回封**:插入块含 while/Math.random,比 omni-element 的单行改动复杂;
   若整方法 AS3 编辑回编失败,退路是 P-code 编辑或把洗牌换成"随机起点取连续 K 层"
   (`var _rfS:int = int(Math.random()*(_rfPool.length-_rfK+1)); _loc2_=_rfPool.slice(_rfS,_rfS+_rfK);`
   ——无循环,回编最稳,随机性稍弱)。
3. 层数指示器/缩略图按抽样结果显示,无需处理。
