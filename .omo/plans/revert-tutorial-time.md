# 撤回教程安全时间补丁

## 原因
已验证 C2032 与 servertime 无关，是 GachaFeatureContentTable 缺失特辑图片。教程安全时间补丁不解决问题。

## 变更

### 1. utils.ts — 移除教程时间锁定
- 删除 `SAFE_TUTORIAL_EPOCH` 常量 (L64-67)
- 删除 `getServerTimeForPlayer()` 中的 tutorial_step 检查 (L76-83)
- 保留 player time_offset 逻辑

### 2. load.ts — 恢复 servertime 使用
- L178: `getServerTimeForPlayer(playerId)` → `getServerTime()`
- 移除 import 中的 `getServerTimeForPlayer`
- 删除 CN-LOAD-TIME 调试日志

### 3. 编译 + 重启
```bash
tsc --incremental false
pkill -f cn-server; nohup node...
```
