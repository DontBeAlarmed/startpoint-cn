# 小型状态写入边界

本文记录教程触发标记、个人资料设置、编队组颜色和角色插画设置这四类请求的持久化与错误边界。它们的响应通常为空或很小，但仍会修改玩家状态，不能按兼容 Stub 处理。

## 教程触发标记

`/tutorial/finish_trigger` 只接受正安全整数 ID 数组。同一请求内的重复 ID 会先去重，已经存在的 ID 会跳过；剩余 ID 通过一个 SQLite 事务批量插入。任一 INSERT 失败时，本次新增标记全部回滚。

该路由只记录普通引导提示，不决定首次教程是否结束。首次教程的中断恢复仍以 `players.tutorial_step` 和步骤回执为准，详见[首次教程状态](./start-tutorial.md)。

## Profile Settings

CN 1.8.1 的 `ProfileUpdateProfileSettingsRealRemote` 请求和响应都使用以下三个布尔字段：

- `show_opened_mana_board_second_count`；
- `show_owned_character_count`；
- `show_owned_degree_count`。

旧实现只回显请求，重新进入个人资料页后又恢复默认值。当前实现把三项设置存入 `players_options` 的 `profile.*` 私有键，并在 `/profile/get_my_profile` 中读取。私有键不会进入普通 `user_option` 响应，但仍随存档 V2 的 `players_options` 表导出、恢复和克隆。

更新请求至少包含一个受支持字段；出现非布尔值时整体拒绝，不写入部分设置。响应始终返回三项完整状态。

## 编队组颜色

`/party_group/edit` 接受 CN 协议中的 category、1 至 12 组 ID 和正安全整数颜色 ID。一次请求的全部组修改位于同一 SQLite 事务：未知组返回 `400`，SQL 写入失败会回滚此前已经执行的组修改，不能用空成功响应掩盖未命中 UPDATE。

颜色 ID 来自客户端当前 CDN 的 Party Group Color Repository。服务端只做整数边界与组所有权校验，不复制一份可能滞后的颜色主数据白名单。

## 角色插画设置

CN 1.8.1 的插画设置页固定维护六个面板，`CharacterSetIllustrationSettingsRealRemote` 发送 `character_id` 和六项整数数组。服务端要求：

- 角色属于当前 session 对应存档；
- `illustration_settings` 恰好有六项；
- 每项为非负安全整数。

未持有角色、非数组、长度不符或非法元素返回 `400`，不会再出现 UPDATE 零命中却返回成功。客户端负责按角色可用进化立绘限制具体选择值，服务端不推测 CDN 中未提取的角色立绘组合。

## 自动测试

- `tools/tutorial_update_step.test.cjs` 覆盖重复 ID、非法 ID 和批量 INSERT 中途失败回滚；
- `tools/small_write_route_boundaries.test.cjs` 使用真实 Fastify 与 SQLite，覆盖编队组第二笔失败回滚、未知组、Profile 重新读取、Profile 非布尔值、插画数组结构与角色所有权；
- EX 能力重入规则见 [EX 能力抽取状态](./ex-boost.md)。

自动测试不替代 CN 客户端对设置页面、颜色列表和六类插画实际显示的人工验收。
