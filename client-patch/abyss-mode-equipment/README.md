# 深渊装备副本门控补丁

本目录只提供 `BattleCharacterLogic` 的可复用 ActionScript 源码补丁与离线校验。它不会修改 APK、SWF、客户端数据包或服务端数据。

## 权威输入与作用域

- 权威反编译源码（只读）：`D:\WF\wf-re-workspace\decompile\scripts\pinball\common\data\character\BattleCharacterLogic.as`
- FFDec 完整类名：`pinball.common.data.character.BattleCharacterLogic`
- 唯一修改点：`getAvailableAbilities(...)` 内原有
  `_loc14_ = Boolean(_loc5_(_loc13_.questKind));` 的下一行
- 禁止修改：`getAvailableAbilitiesWithCond(...)`
- 受门控的能力魂 ID：`8000101..8000115`

补丁先保留官方 quest-condition 结果，再仅对上述 15 个保留能力魂执行 fail-closed 覆盖。其他能力继续使用官方结果。

## 精确白名单

只有下列三类 `(group_index, single_index, quest_id)` 允许保留能力魂生效：

| group_index | single_index | quest_id 条件 |
|---:|---:|---|
| `0` | `8` | 恰好 `2001` |
| `0` | `10` | `1 <= quest_id <= 97` |
| `0` | `17` | `floor(quest_id / 1000 + 1e-10) == 700099`，即 `700099xxx` 类 |

任何其他组合都返回 `false`，包括其他 group、`2002/2006`、常规单人 ID `0/98/1001`，以及非 `700099xxx` 的深渊 ID。

## 生成和源码验证

不要原地覆盖权威源码。以下命令把结果写到 worktree 内已忽略的 `.superpowers` 临时区：

```powershell
python -X utf8 client-patch/abyss-mode-equipment/patch.py `
  --source D:\WF\wf-re-workspace\decompile\scripts\pinball\common\data\character\BattleCharacterLogic.as `
  --output .superpowers\task-6-validation\BattleCharacterLogic.as

python -X utf8 client-patch/abyss-mode-equipment/patch.py `
  --verify .superpowers\task-6-validation\BattleCharacterLogic.as
```

补丁器要求目标方法和锚点各恰好出现一次；重复运行保持字节一致。语义校验按 AS3 token 比对，要求完整门控恰好一次、紧跟锚点，且后续官方 `if(_loc14_)` 的平衡块确实包住能力的 `getTriggers/add` 路径；注释和 token 间排版变化不影响校验，数字 token 则不能靠空白拼接伪装。它保留源文件的 CRLF/LF，并在语义校验成功后才通过同目录临时文件和 `os.replace` 原子替换输出。任何计数、锚点或语义错误都不会覆盖已有输出；即使替换已提交后才收到错误或取消，也会按写前快照原子恢复旧输出（原先不存在则删除新输出），恢复自身失败会附加到原始错误后再重抛原始错误。

## FFDec 二进制回读验证

Task 7 构建 APK 时，必须在 FFDec 中替换完整类
`pinball.common.data.character.BattleCharacterLogic`，保存含该类的客户端二进制，然后重新打开实际保存的二进制并导出同一类。不要只验证待导入的 `.as` 文件。

FFDec 重新编译后可能移除 marker 注释；`--verify` 因此按语义验证，不依赖 marker：

```powershell
python -X utf8 client-patch/abyss-mode-equipment/patch.py `
  --verify <FFDec重新打开已保存二进制后导出的BattleCharacterLogic.as>
```

验证必须确认：门控仅位于 `getAvailableAbilities`、能力魂范围为 `8000101..8000115`、外层 group 为 `0`、内层仅有 `8/10/17` 三类及其精确 ID 边界，并且 `getAvailableAbilitiesWithCond` 没有同类门控。

## 回滚与发布闸门

回滚方式是重新安装此前保留的、已签名且已验证的 APK；不要把删除导出的 `.as` 文件当作客户端回滚。

> **发布闸门：Task 7 的验证报告存在且通过之前，禁止发布依赖此门控的强力深渊装备数据。Task 6 本身不修改 APK；构建、安装和 FFDec 二进制回读属于 Task 7，并用于产出该验证报告。**
