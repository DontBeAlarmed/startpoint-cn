# WF 修改器 · API 契约

> 供将来并入服务端后台(admin React SPA)时对接使用。当前修改器独立运行
> (`python mod-tools/wf_gui.py`,默认 `127.0.0.1:8765`,可用 `WF_GUI_PORT` 改端口)。

## 前缀与并入方式

- **标准前缀:`/api/mod/*`**(以下端点均省略此前缀)
- 兼容:旧 `/api/*` 仍可用(deprecated,迁移完成后删)
- **并入方案(sidecar 反代)**:cn-server(Fastify)把 `/api/mod/*` 原样转发到修改器进程:
  ```ts
  // 概念示例:@fastify/http-proxy
  fastify.register(proxy, {
    upstream: `http://127.0.0.1:${process.env.WF_GUI_PORT ?? 8765}`,
    prefix: "/api/mod", rewritePrefix: "/api/mod",
  })
  ```
  admin(Vite dev 5173)已代理 `/api → 8001`,无需额外配置。
  修改器进程可由 npm script 或 Fastify 启动时 `child_process.spawn("python", ["mod-tools/wf_gui.py"])` 拉起。
- 前端(React)对接:所有写接口都支持 `dry_run`,推荐交互 = 先 `dry_run:true` 拿预览
  → 用户确认 → `dry_run:false` 写入(当前原生前端即此模式)。

## 约定

- 请求/响应均 JSON(UTF-8);无鉴权(仅本机使用;并入后由服务端后台统一鉴权)。
- 错误:HTTP 4xx/5xx + `{"error": "<中文消息>"}`。
- **写操作统一响应**:
  ```json
  { "changes": 3, "log": "逐条改动明细(\\n 分隔)", "written": "写入的文件路径|null", "dry_run": false }
  ```
- 写入自动创建备份(`.bak-wfmod-*`),② 层改动自动加入待同步列表(pending),
  需调 `/sync` 推送到模拟器后生效;① 层(char_fields)改动需重启服务端生效,不走 sync。

## GET 端点(读)

| 路径 | 参数 | 返回 |
|---|---|---|
| `/status` | — | `{target_store, profile, profile_id, res_version, pending[], device, package, adb, connected}` |
| `/characters` | — | `[{id, code_name, rarity, element(中文), race, role, name, name_en, skill_name, abilities[], in_store}]` |
| `/schema` | — | `{columns:[{index,name,isDecimal}], enums:{列号:{值:枚举名}}}`(ability 表 125 列,CN) |
| `/abilities` | `?character=ID` | `{character, columns[], leader_title, abilities:[{ability, missing, leader?, lines:[{line, values:{列号:值}}], desc}]}` |
| `/char_fields` | `?character=ID` | `{id, fields:{name,rarity,element,role,race,gender,title,leader_title,cv,code_name,description,skill_name,skill_desc,...}, element_name}`(① 层) |
| `/status_values` | `?character=ID` | `{character, entries:[{level,hp,atk}], awake:{atk_plus,hp_plus}\|null, note}` |
| `/souls` | — | `[{id, string_id, rarity, lines}]`(436 个能力魂) |
| `/soul_rows` | `?soul=ID` | `{soul, columns[], lines[], desc}` |
| `/backups` | — | `[{table, name, size, mtime}]` |
| `/mainpos` | — | `{restricted_rows, state}`(主位限制现状) |

## POST 端点(写;均支持 `"dry_run": true`)

| 路径 | 请求体 | 说明 |
|---|---|---|
| `/rows/save` | `{edits:[{ability,line,index,value}]}` | 词条逐字段;`ability` 带 `L:` 前缀写队长技表 |
| `/scale` | `{character\|ability[], fields, factor, rounding}` | 倍率;fields=别名(skill_strength 等)或列名 |
| `/copy` | `{from_character, to_character, slots[], preserve_string_id, fields?}` | 角色级词条移植 |
| `/copy_row` | `{src:{key,line}, dst:{key,line\|"append"\|"all"}, preserve_string_id}` | 行级移植 |
| `/copy_leader` | `{from_character, to_character, slot, preserve_string_id}` | 队长技→常驻词条 |
| `/recipe` | `{recipe:{operations:[...]}}` | 自由配方(op: set/scale/copy_ability/copy_fields/remove_main_position) |
| `/mainpos` | `{action:"remove"\|"restore"\|"status"}` | 主位限制开关(无 dry_run;status 建议用 GET) |
| `/char_fields/save` | `{character, edits:{字段:值}}` | ① 层资料;element 接受中文名;重启服务端生效 |
| `/status_values/save` | `{character, entries:[{level,hp,atk}]}` | 基础数值;断点白名单(不允许增删) |
| `/awake_values/save` | `{character, atk_plus, hp_plus}` | 觉醒加成;仅限已有 36 键 |
| `/soul_rows/save` | `{edits:[{key,line,index,value}]}` | 能力魂逐字段 |
| `/export_all` | `{}` | 全量词条 CSV → `{out, rows, hint}` |
| `/export_annotated` | `{}` | 标注版 CSV → 同上 |
| `/restore` | `{name}` | 用指定备份覆盖当前表 → `{restored, table, target}` |
| `/sync` | `{restart:true}` | adb push pending + 重启游戏 → `{ok, log}`(无 dry_run) |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WF_GUI_PORT` | 8765 | 监听端口(Windows 保留段时自动换备用端口) |
| `WF_PROFILE` | profiles.json 的 active | 版本档案(当前锁 cn) |
| `WF_TARGET_STORE` | 由 profile 决定 | 覆盖目标数据包路径 |
| `WF_ADB` / `WF_ADB_PORT` / `WF_PKG` | 自动探测 / 16384 / air.com.leiting.wf | 模拟器同步 |

## React 迁移备注

- 左侧角色列表数据 = `/characters`(筛选维度:rarity / element / race,race 为逗号分隔多值)。
- 词条/能力魂表格按 `columns` 渲染;中文列名映射见 `wf_gui.html` 的 `COL_CN`
  (token 逐段翻译,迁移时直接搬走;`power1`=SLv1 值,`first_max`=SLv 满级值)。
- 枚举展示:`/schema` 的 `enums[列号][值]`。
- 未保存守卫 / 预览确认 / toast 语义在 AntD 下对应 `Modal.confirm`(带 log 明细)+ `message`。
