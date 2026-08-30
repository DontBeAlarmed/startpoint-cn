# 普通公告

本文描述 CN 服务端普通公告的持久化、可见性、客户端投影和管理后台边界。系统公告、强制弹窗、维护公告、普通公告已读和红点不在当前范围内。

## 数据源与迁移

SQLite `server_news` 是普通公告的唯一运行时主数据源。普通公告不读取 `assets/news.json`，没有 seed、旧数据导入或文件 fallback；新库和 schema 23 迁移后的公告表都为空。数据库或公告表不可用时服务启动失败，或公告路由返回明确错误，不会回退到静态内容。

当前发布契约 `currentDataSchema` 为 24。公告先由 schema 22 -> 23 迁移引入；礼包随后由 schema 23 -> 24 迁移引入。schema 23 只创建空的 `server_news` 表，并删除 `players_options` 中 `server.forced_news.*` 私有键，因此旧 forced 投递状态不迁移。数据库 `user_version` 和兼容版本文件由服务端事务迁移统一写入 24；高于 24 的数据库会被拒绝。

公告表是服务器级运营状态：

- 不属于玩家存档，不进入 Player Save 导出、导入、恢复或普通克隆；
- 服务重启后保留；
- Server Bundle 更新不覆盖 Data Volume 中的公告；
- 后台物理删除后不保留历史版本、回收站或审批流。

## 客户端路由

普通公告使用两个真实数据路由：

| 路由 | 行为 |
|---|---|
| `/api/index.php/news/index` | 按 `category` 严格过滤，只返回当前可见公告，固定每页 20 条并返回真实总数 |
| `/api/index.php/news/get_info` | 按正整数 `news_id` 只返回当前可见的一篇公告 |

分页排序固定为 `published_at_real DESC, id DESC`。同一次列表查询的行和总数来自同一 SQLite 读路径，排序和分页条件一致。

以下路由保持兼容空响应：`/news/system_index`、`/news/get_system_info`、`/news/latest_forced`、`/news/latest_forced_system`。`/load` 不因公告设置 `force_news`，也不返回普通公告已读或红点状态。

## 分类与投影

`category` 只允许 `1` Topics、`2` HeldInfo、`3` BugInfo。`label` 允许 `1..8`，与分类互相独立；禁止由分类推导标签。`thumbnail` 允许客户端确认过的内置资源 `1..13`。

客户端投影固定为 `id`、`title`、`date`、`html`、`label`、`thumbnail`，且 `thumbnail_path`、`added_time` 均为 `null`。`thumbnail_path` 不入库、不由管理员配置，以避免 CN 1.8.1 公告列表加载非内置缩略图时触发客户端错误。

## 时间与可见性

公告只使用真实时间。`published_at_real` 保存 UTC ISO-8601 时间，后台可提交带时区的日历时间，服务端先转换为 UTC。可见条件是：

```text
enabled = 1 AND published_at_real <= getRealNow()
```

全局虚拟服务器时间不参与公告显示或隐藏。客户端 `date` 由 `published_at_real` 格式化为中国时区的 `YYYY-MM-DD HH:mm:ss`；客户端只显示该字段，不做未来时间过滤。

## RichText

标题使用 JavaScript 与 AS3 一致的 UTF-16 长度，要求 1..128。正文是受限 RichText 源码，保存前由确定性解析器验证标签白名单、完整嵌套、闭合和无属性，长度要求 1..20000 UTF-16 单位。

允许 `p`、`br`、`div`、`h1`、`h2`、`h3`、`hr`、`ul`、`ol`、`li`、`table`、`tr`、`th`、`td`。不允许链接、图片、脚本、样式、class、任意属性、事件属性、外部 URL、`scene/`、`dialog/` 和 token 关联语法。服务端保存和客户端返回同一份已验证源码，不做二次替换或动态净化。

## 管理后台

后台 JSON API 为 `/api/news` 列表、`/api/news/:id` 详情、创建、按 ID 更新、启停和物理删除。所有创建和更新先执行服务端验证；更新、启停和删除都要求当前 `revision`，条件更新影响行数不是 1 时返回 409。不存在返回 404，输入错误返回有限的中文 400。

后台列表按 `published_at_real DESC, id DESC` 分页，包含草稿和停用公告。已发布公告可编辑；下一次客户端请求立即看到新内容。服务端不记录操作者、访问 IP 或历史版本。

## 验证边界

普通公告的存储、迁移、RichText、可见性、客户端路由和后台 CRUD 有自动测试覆盖；系统/强制路由的空契约与 `/load` 不携带 forced 状态也有边界测试。客户端公告页仍需按发布时间、分类、分页、内置缩略图和 RichText 显示做实机验收。
