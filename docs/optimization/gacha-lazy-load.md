# Gacha 按需加载优化

> 状态: 未实施（优化建议）  影响文件: src/lib/assets.ts  相关模块: gacha, seeds

## 问题

`src/lib/assets.ts` 在服务启动时通过 `import` 一次性加载 45 个 JSON 文件到内存（总计 ~49 MB），其中最大的是 gacha 相关文件：

| 文件 | 大小 | 加载时机 |
|------|------|---------|
| `gacha.json` | 16 MB | import 时 |
| `gacha_movie_seeds.json` | 3.5 MB | import 时 |
| `gacha_movie_seeds_normal.json` | 6.2 MB | import 时 |
| `gacha_movie_seeds_fes.json` | 6.2 MB | import 时 |
| `gacha_rate_up_movie_seeds*.json` | ~2 MB | import 时 |
| **gacha 合计** | **~34 MB** | |
| 其余 39 个文件 | ~15 MB | import 时 |

其中 gacha 相关文件仅在 `/gacha/exec` 和 `/seeds` 端点使用，却占用了 70% 的启动内存和 2~3 秒的启动时间。

## 方案

将 gacha 相关 JSON 文件的 `import` 改为惰性加载（lazy loading）：

```typescript
// 当前（assets.ts 顶部 import）
import gachas from "../../assets/gacha.json";

// 改为
let _gachas: Gachas | null = null;
export function getGachasSync(): Gachas {
    if (!_gachas) {
        _gachas = JSON.parse(readFileSync(path.join(__dirname, "../../assets/gacha.json"), "utf-8"));
    }
    return _gachas!;
}
```

## 影响范围

| 文件 | 当前使用方式 | 改为 |
|------|------------|------|
| `gacha.json` | `import gachas` → 全局变量 | `getGachasSync()` 惰性加载 |
| `gacha_movie_seeds*.json`（11 个） | `import ...` → 全局变量 | `getMovieSeedsSync(type)` 惰性加载 |
| 其余 33 个 | 保持不变（< 500KB 各自，不划算） |

## 涉及文件

- `src/lib/assets.ts` — gacha 相关变量改为惰性 getter
- `src/routes/api/gacha.ts` — 替换直接引用为函数调用
- `src/routes/api/seeds.ts` — 替换直接引用为函数调用
- `src/routes/web_api/seeds.ts` — 同上

## 预期收益

- 启动内存减少 ~34 MB JSON 解析
- 启动时间减少 1~2 秒（取决于磁盘 I/O）
- 首次抽卡请求额外耗时 ~0.5 秒（一次性）

## 风险

- 惰性加载的文件路径依赖 `__dirname`（需要确认 CommonJS 模式下 `__dirname` 正确）
- 首次加载时同步 I/O 会阻塞事件循环，但 gacha 端点本身就需要这份数据，阻塞时长可接受
