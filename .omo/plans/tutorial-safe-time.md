# 教程安全时间锁定

## 背景
教程期间（step < 6）进程加载卡池，若有缺损 banner 会导致 C2032/教程中断。

## 计划

### 步骤1：commit 当前已修改文件
```
src/lib/version.ts        — getEffectiveVersion() 扫描全部 patches
src/cn-server.ts          — PATCH-MISS/PATCH-SERVE 日志
assets/asset-patch/manifest.json  — 两步补丁配置
assets/asset-patch/production/upload/{10个hash}  — 补丁文件
assets/asset-patch/active/{2个zip}  — 补丁包
assets/asset-patch/inactive/{旧zip}  — 旧补丁包
```

### 步骤2：修改 utils.ts
文件：`src/utils.ts`

在 `getServerTimeForPlayer()` 开头添加教程时间锁定：

```typescript
/** 教程安全时间（游戏开服日），避免教程期间因卡池缺损导致 C2032 */
const SAFE_TUTORIAL_EPOCH = Math.floor(
    new Date("2024-08-14T12:00:00Z").getTime() / 1000
);

export function getServerTimeForPlayer(playerId?: number): number {
    if (playerId) {
        try {
            // 教程前半段（step < 6）锁定时间，避免 gacha 缺损
            const { getDb } = require("./data/db");
            const row = getDb().prepare(
                `SELECT tutorial_step FROM players WHERE id = ?`
            ).get(playerId) as { tutorial_step: number } | undefined;
            if (row && (row.tutorial_step ?? 0) < 6) {
                return SAFE_TUTORIAL_EPOCH;
            }

            const { getPlayerTimeOffsetSync } = require("./data/activeAccount");
            const offset = getPlayerTimeOffsetSync(playerId);
            if (offset !== null) return Math.floor((Date.now() + offset) / 1000);
        } catch {}
    }
    return getServerTime();
}
```

### 步骤3：编译 + 重启验证
```bash
cd starpoint-cn
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --incremental false
pkill -f "cn-server"; sleep 1
nohup node --env-file=.env out/cn-server.js > /tmp/cn-server.log 2>&1 &
```

### 步骤4：测试
1. 创建新账号 → 确认 step=0 → 调用任意端点 → 验证时间 = 2024-08-14
2. 推进教程 step=6 → 再调用端点 → 验证时间 = 正常服务器时间
