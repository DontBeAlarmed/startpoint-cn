# 定位教程安全时间失效

## 已验证

```
getServerTimeForPlayer(12) → 2024-08-14 ✅
load.ts 源码 → getServerTimeForPlayer(playerId) ✅
out/load.js 编译 → getServerTimeForPlayer ✅
generateDataHeaders → 不覆盖 customValue ✅
onSend hook → 不修改 servertime ✅
```

## 定位计划

### 步骤1：在 load.ts 添加 servertime 日志

```typescript
// 在 L178 之前
const st = getServerTimeForPlayer(playerId);
const gs = getServerTime();
console.log(`[CN-LOAD] player=${playerId} step=${player?.tutorialStep} servertime=${st} (${new Date(st*1000).toISOString()}) global=${gs}`);
```

### 步骤2：重启 + 用户创建新账号测试

### 步骤3：检查日志

如果 `servertime` 不是 2024-08-14 → 定位为什么 `getServerTimeForPlayer` 未返回安全时间。

如果是 2024-08-14 但仍报错 → 客户端从其他端点获取时间（如 gacha 列表接口）。
