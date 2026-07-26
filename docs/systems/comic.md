# 漫画系统

当前仓库实现了漫画列表与图片路由，但不分发漫画内容。fresh clone 和 Server Bundle 在未另行准备本地图片时只会得到空列表或 404，因此该模块状态为 Partial。

## 路由

`src/routes/api/comic.ts` 注册：

| 端点 | 当前行为 |
|---|---|
| `POST /comic/get_list` | 校验 viewer，按 kind 和 page_index 返回每页最多 9 条 |
| `GET /comic/image` | 按 kind、episode 和 size 返回 main、大小缩略图 |

列表按 episode 降序。响应图片 URL 使用当前请求 Host 构造，避免写死本机或局域网地址。

## 本地内容契约

漫画根目录为：

```text
web/public/comic/<kind>/
```

当前解析支持：

- kind 0：根目录文件名 `第N话 标题.jpg`；
- kind 1：根目录文件名包含 `第N课`，标题可从 `今日课程：...` 提取。

根目录 JPG 用于枚举 episode 和标题。对应图片位于：

```text
web/public/comic/<kind>/main/
web/public/comic/<kind>/thumbnail_l/
web/public/comic/<kind>/thumbnail_s/
```

main 优先读取与根文件同名的 PNG，找不到时回退 JPG；缩略图使用与根文件同名的 JPG。缺少 kind 目录时列表返回空；缺少目标图片时返回 404。

## 分发边界

`web/public/comic/` 被 Git 忽略，不得提交漫画图片。Server Bundle 构建器完全不读取 `web/public/`，verifier 也拒绝该 Bundle 根，因此宿主或部署者必须在 Bundle 外另行准备合法的本地内容。漫画仅通过 `/api/index.php/comic/image` 业务接口提供，不存在通用 `/public` 静态挂载。

仓库当前没有漫画抓取或图片处理生成器，也不提供第三方漫画源目录。文档只定义服务端读取契约，不声称 fresh clone 自带可用漫画库。

## 已知边界

- 没有本地图片时只能返回空列表或 404；
- 内容不进入 Server Bundle，嵌入式宿主需要额外挂载策略；
- 文件名不匹配当前正则时 episode 会退化为 0 或无法按 episode 查图；
- 未验证所有设备比例、纹理上限和完整翻页体验；
- 当前没有漫画内容完整性与缩略图尺寸自动测试。
