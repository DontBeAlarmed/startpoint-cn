# 深渊装备副本门控补丁

本目录提供 `BattleCharacterLogic` 的可复用 ActionScript 源码补丁、离线语义校验，以及事务式 APK 构建器。`patch.py` 本身不会修改 APK、SWF、客户端数据包或服务端数据；只有显式运行 `build_apk.py` 才会在指定的已忽略输出目录内构建新 APK。

## 权威输入与作用域

- 权威反编译源码（只读）：`D:\WF\wf-re-workspace\decompile\scripts\pinball\common\data\character\BattleCharacterLogic.as`
- FFDec 完整类名：`pinball.common.data.character.BattleCharacterLogic`
- 唯一修改点：`getAvailableAbilities(...)` 内原有
  `_loc14_ = Boolean(_loc5_(_loc13_.questKind));` 的下一行
- 禁止修改：`getAvailableAbilitiesWithCond(...)`
- 受门控的装备/能力魂 ID：`8000101..8000115`

补丁先保留官方 quest-condition 结果，再把直接装备的 `EquipmentAbilityLogic` 解包到其
`abilitySoulAbility`，与角色能力魂槽中的 `AbilitySoulAbilityLogic` 一起按上述 15 个 ID
执行 fail-closed 覆盖。其他能力继续使用官方结果。

## 精确白名单

只有下列三类 `(group_index, single_index, quest_id)` 允许这些装备或能力魂生效：

| group_index | single_index | quest_id 条件 |
|---:|---:|---|
| `0` | `8` | 恰好 `2001` |
| `0` | `10` | `1 <= quest_id <= 97` |
| `0` | `17` | `floor(quest_id / 1000 + 1e-10) == 700099`，即 `700099xxx` 类 |

任何其他组合都返回 `false`，包括其他 group、`2002/2006`、常规单人 ID `0/98/1001`，以及非 `700099xxx` 的深渊 ID。

## 生成和源码验证

不要原地覆盖权威源码。以下命令把结果写到 worktree 内已忽略的 `out/`：

```powershell
python -X utf8 client-patch/abyss-mode-equipment/patch.py `
  --source D:\WF\wf-re-workspace\decompile\scripts\pinball\common\data\character\BattleCharacterLogic.as `
  --output out\abyss-client-patch\BattleCharacterLogic.as

python -X utf8 client-patch/abyss-mode-equipment/patch.py `
  --verify out\abyss-client-patch\BattleCharacterLogic.as
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

验证必须确认：门控仅位于 `getAvailableAbilities`、能同时识别直接的
`AbilitySoulAbilityLogic` 与包裹它的 `EquipmentAbilityLogic`、ID 范围为
`8000101..8000115`、外层 group 为 `0`、内层仅有 `8/10/17` 三类及其精确 ID 边界，
并且 `getAvailableAbilitiesWithCond` 没有同类门控。

## 事务式 APK 构建

先在当前进程中通过本机签名配置或密钥管理器设置 `WF_APK_KS_PASS`。不要把密码写进命令行、README、报告或磁盘临时文件；构建器只把 `env:WF_APK_KS_PASS` 传给 `apksigner`。变量必须存在；使用空密码的合法 keystore 也可显式传入空值。

```powershell
# 由获授权的本机签名配置在当前进程内设置 WF_APK_KS_PASS 后执行：
if (-not (Test-Path Env:WF_APK_KS_PASS)) {
  throw "WF_APK_KS_PASS is not set"
}

python -X utf8 client-patch/abyss-mode-equipment/build_apk.py `
  --base D:\WF\starview-windows\patched.apk `
  --battle-logic-as out\abyss-client-patch\BattleCharacterLogic.as `
  --out out\abyss-client-patch\wf_abyss_gate.apk `
  --report out\abyss-client-patch\gate-verification.json `
  --work out\abyss-client-patch\work `
  --ffdec D:\WF\starview-windows\ffdec\ffdec.jar `
  --java "C:\Program Files (x86)\Common Files\Oracle\Java\java8path\java.exe" `
  --zipalign D:\WF\starview-windows\build-tools\zipalign.exe `
  --apksigner D:\WF\starview-windows\build-tools\apksigner.bat `
  --ks D:\WF\startpoint-cn\弹国服\instrument\wf_new.keystore `
  --ks-pass-env WF_APK_KS_PASS
```

构建器按固定顺序执行：

1. 校验所有显式路径、签名环境变量和带 marker 的补丁 AS；
2. 从基线 APK 提取主 SWF，以 FFDec 替换完整类；
3. 从实际注入后的 SWF 重新导出唯一的 `BattleCharacterLogic.as`，以 `require_markers=False` 做 markerless 语义校验；
4. 只替换 `assets/worldflipper_android_release.swf`，保留该 ZIP 条目的原压缩方式；删除旧 APK 顶层 `META-INF/MANIFEST.MF`、`.SF/.RSA/.DSA/.EC` 签名，保留 `META-INF/AIR/**`；
5. `zipalign -p -f 4`，用环境变量引用签名，再执行 `apksigner verify --verbose --print-certs`；
6. 全部通过后才原子移动最终 APK 和 JSON 报告，并再次读取报告、重新计算每个记录文件的 SHA-256。

任一外部命令失败、导出类缺失或重复、语义校验失败、报告复验失败，或收到取消，都会删除本次请求的最终 APK/报告并清理事务临时目录。成功事务目录会保留，因为报告中的 injected SWF 与 re-exported AS 绝对路径和哈希指向其中的证据文件。

验证报告固定记录：

- 精确类名 `pinball.common.data.character.BattleCharacterLogic`；
- patched AS、injected SWF、signed APK、re-exported AS 的规范绝对路径；
- 上述四项逐项 SHA-256。

`validate_verification_report(...)` 会校验 schema、状态、类名、四个唯一绝对路径及所有实时重算哈希；任一文件被修改、移动或删除都会 fail closed。最终 APK 和报告都位于已忽略的 `out/abyss-client-patch/`，不得提交。

## 回滚与发布闸门

回滚方式是重新安装此前保留的、已签名且已验证的 APK；不要把删除导出的 `.as` 文件当作客户端回滚。

> **发布闸门：`gate-verification.json` 存在、`validate_verification_report(...)` 通过，且报告内 re-exported AS 再次通过 markerless 语义校验之前，禁止发布依赖此门控的强力深渊装备数据。构建与 FFDec 二进制回读属于 Task 7；安装仍必须由后续显式步骤完成。**
