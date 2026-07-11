# server-patch — mod 工具所需的 startpoint-cn 服务端增量

mod 工具(wf_gui)的「推送服务端」与商店三处同步功能,依赖服务端的
**mod-admin 热重载接口**。上游 [DontBeAlarmed/startpoint-cn](https://github.com/DontBeAlarmed/startpoint-cn)
没有这组接口 —— 更新/重装服务端后,把本目录的内容按下表套回去即可
(2026-07-12 基于上游 main `12047e2` 验证可干净应用)。

## 文件与落点

| 本目录文件 | 放到服务端的位置 | 方式 |
|---|---|---|
| `modAdmin.ts.txt` | `src/routes/api/modAdmin.ts` | **复制并去掉 `.txt` 后缀**(新文件;带 .txt 是防止被服务端 tsc 误扫) |
| `assets.ts.diff` | 改 `src/lib/assets.ts` | `git apply` 或按下文手工改 |
| `cn-server.ts.diff` | 改 `src/cn-server.ts` | `git apply` 或按下文手工改 |

应用后在服务端根目录执行 `npx tsc`,再重启服务端(此后改商店/角色简化表
就不用重启了,GUI 点「推送服务端」即可)。

```bash
# 在服务端仓库根目录
cp <本目录>/modAdmin.ts.txt src/routes/api/modAdmin.ts
git apply <本目录>/assets.ts.diff
git apply <本目录>/cn-server.ts.diff
npx tsc
```

## diff 内容说明(手工改用)

### `src/lib/assets.ts`(热重载改造)

把 9 个 mod 工具会改的 JSON 从静态 import 改为运行时读取:

1. 删除这 9 行静态 import:
   `character.json` / `boss_coin_shop.json` / `boss_coin_shop_item_category_map.json` /
   `event_item_shop.json` / `event_item_shop_id_map.json` / `general_shop.json` /
   `star_grain_shop.json` / `treasure_shop.json` / `equipment_enhancement_shop.json`
2. 加 `import { readFileSync } from "fs"; import { join as joinPath } from "path";`
3. 在类型 import 之后加 `loadModAsset()` + 9 个 `let` 变量 + 导出的
   `reloadModAssets()`(末尾立即调用一次)—— 完整代码见 `assets.ts.diff`。

变量名与原 import 名一一相同,文件内其余引用处零改动。

### `src/cn-server.ts`(注册路由,共 2 处)

```ts
// import 区(挨着 seedsWebApiPlugin):
import modAdminApiPlugin from "./routes/api/modAdmin";
// Web management panel 注册区(挨着 /api/seeds):
fastify.register(modAdminApiPlugin, { prefix: "/api/mod-admin" });
```

## 提供的接口

| 接口 | 作用 |
|---|---|
| `GET /api/mod-admin/ping` | 探活,返回 `{ok, server_time}` |
| `POST /api/mod-admin/reload_assets` | 重读上述 9 个 json(改动即时生效,不用重启);坏 JSON 返回 500 但不影响服务端运行 |

## 与上游机制的兼容性(2026-07-12 核对)

- 上游 main 未改 `src/lib/assets.ts` / `src/routes/api/shop.ts` /
  `assets/boss_coin_shop.json` → 两个 diff 可干净应用,商店同步格式不变。
- 上游新增 `src/lib/version.ts` + `assets/asset-patch/` 补丁机制,与
  `.cdn/cn/archive-*-diff` 增量发布**并行不冲突**;wf_publish 已适配
  (版本号扫描把启用的 asset-patch 版本一并纳入 max,防止版本号被 patch 越过)。
