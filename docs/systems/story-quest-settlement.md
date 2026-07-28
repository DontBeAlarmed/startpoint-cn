# 普通剧情结算与剧情角色入队

本文记录 `/story_quest/finish`、`/story_quest/finish_with_skip` 与
`/character/add_character_from_town` 的服务端契约。依据为 CN 1.8.1 反编译客户端中的
`StoryQuestFinishRealRemote`、`StoryQuestFinishDummyRemote`、`StoryJoinCharacterRepository` 和
`CharacterAddCharacterFromTownRealRemote`，以及官方
`master/character/story_join_character.orderedmap`。

## 官方流程

剧情首次完成时，Dummy 实现按以下顺序处理：

1. 发放首通奖励；
2. 从 `story_join_character` 查找 `join_type=quest` 且前置关卡等于本次剧情的角色；
3. 直接加入这些角色；
4. 写入剧情完成进度；
5. 在局部响应中返回 `story_join_character_id_list`。

`join_type=town` 不在剧情 finish 中直接发放。客户端根据已完成剧情显示城镇角色，玩家触发领取后才请求
`/character/add_character_from_town`。CN 1.4.54 官方表共三条：角色 10 和 213013 为剧情直加入，角色
512001 为城镇领取。

## 服务端事务边界

首通奖励、剧情直加入角色和 `players_quest_progress` 写入处于同一个 SQLite 事务。任一步失败都回滚全部写入，
防止出现“奖励已到账但剧情仍未完成”导致的重复领取窗口。重复 finish 始终返回对象形状，但不会再次发奖励、
增加角色 stack 或返回剧情入队动画 ID。

响应使用 common response 字段 `item_list`，并补充客户端局部解析的：

- `story_join_character_id_list`；
- `user_notice_list`。

`finish_with_skip` 与普通 finish 共用同一结算函数；客户端虽然不读取它的专用响应，服务端状态语义仍保持一致。

## 城镇领取边界

城镇领取接口在事务内重新校验：

- 角色必须在官方表中且 `join_type=town`；
- 对应前置剧情必须已有 `finished=1`；
- 玩家尚未持有该角色。

不满足任一条件均返回 400，不把客户端提交的任意角色 ID 当作可信发奖指令，也不允许重复领取转换为角色重复数。

## Content Sync

`story_join_character.json` 是 CDN 直接 OrderedMap 表，由
`master/character/story_join_character.orderedmap` 动态生成；bundled 文件只作为旧启动路径和低级测试的官方
1.4.54 基线。内容更新后由正常 `content:sync` 随 Registry 契约生成，不在路由代码中手写角色名单。

## 任务结算取舍

剧情完成进度本身会立即落库。角色觉醒任务仍在进入觉醒任务页面时根据 category 3 剧情记录计算和发奖，避免
恢复此前已经修正的“剧情结束时静默发放觉醒奖励”问题。因此本路由不调用会自动发奖的 category 9 通用结算器。
其他普通、活动和称号任务可以在各自任务页通过现有权威进度重新计算；在拆分“只更新进度”和“发放阶段奖励”
之前，不为追求即时提示而在剧情路由中扩大自动发奖范围。
