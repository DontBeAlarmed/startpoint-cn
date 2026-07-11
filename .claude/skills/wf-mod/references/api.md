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
| `/abilities` | `?character=ID` | `{character, columns[], leader_title, abilities:[{ability, missing, leader?, lines:[{line, values:{列号:值}}], desc, line_descs[]}]}`(line_descs=行级中文描述,wf_describe 生成) |
| `/char_fields` | `?character=ID` | `{id, fields:{name,rarity,element,role,race,gender,title,leader_title,cv,code_name,description,skill_name,skill_desc,...}, element_name}`(① 层) |
| `/status_values` | `?character=ID` | `{character, entries:[{level,hp,atk}], awake:{atk_plus,hp_plus}\|null, note}` |
| `/souls` | — | `[{id, string_id, rarity, lines, name, eq_rarity, kind}]`(436 魂珠=装备同键;name/品质来自 equipment 表,kind 0=武器魂 1=魂珠) |
| `/soul_rows` | `?soul=ID` | `{soul, columns[], lines[], desc, line_descs[], info:{name,rarity,desc,...}}` |
| `/skill_energy` | `?character=ID` | `{character, skill_key, skills:[{level, label, name, description, min_skill_weight, max_skill_weight}], note}`(action_skill;description=游戏内技能效果描述,内层 c1) |
| `/weapons` | — | `[{id, slot, learn_level, lines, has_enh, kind, name, enh_name, rarity, soul_id, element}]`(全部 436 件装备:kind 0=武器 424 / 1=主线魂珠 12;element 按词条内容检测,''=通用) |
| `/weapon_ability` | `?wid=ID` | `{weapon, columns[], lines[], desc, line_descs[], info, soul}`;**soul=同键 ability_soul 的完整行数据**(武器页一并编辑);无强化词条时 `{no_enh:true, soul}` |
| `/search_abilities` | `?q=关键字` | 搜四表行级中文描述/归属/键/string_id → `{query, count, results:[{key, kind, owner, slot, desc, sid, lines, shared_count, shared:[{key,owner,slot}]}]}`;shared_count>1=共用词条,=1=专属;键前缀 L:/W:/S:;上限150 |
| `/history` | — | `{entries:[{ts, table, keys[], summary, backup, version}](最新在前), changelog_md}` |
| `/char_assets` | `?character=ID` | 角色资产清单 `{code_name, assets:[{logical, kind, req, text, exists, root, size, dims}]}`:立绘×2/cut-in×2/图标合集/像素图×2/**语音全量三分类**(ally/battle/home,来自 D:\WF\角色语音 datamine,text=台词)/配套数据×7(atlas/frame/timeline) |
| `/char_snapshots` | `?character=ID` | 单角色快照列表 `[{file, id, code_name, ts, note, size, assets}]` |
| `/asset` | `?logical=路径` | **二进制**响应(自动解混淆:PNG 魔数/MP3 帧头),Content-Type 按扩展名 |
| `/skill_dsl` | `?character=&level=` | 技能效果 DSL 数值树 `{program_path, numbers:[{offset, len, type, value, ctx}], note}` |
| `/raw_json/tables` | — | JSON 直改支持的表 `{tables:[{alias, kind:flat\|nested\|cdn, cn, target}]}`(②平表9张/②嵌套2张/①cdndata 8个) |
| `/raw_json/keys` | `?table=别名&q=过滤` | `{total, keys[]}`(最多 100) |
| `/raw_json` | `?table=&key=` | 整键 JSON 视图 `{table, key, kind, json_text, note, width?}`:flat=`[[列,...],...]`(一行一数组)/nested=`{内层键:[[列,...]]}`/cdn=原生节点 |
| `/server/ping` | — | `{online, url, server_time?, detail?}`(startpoint 服务端 mod-admin 探活;url 来自 WF_SERVER_URL > .env CN_LISTEN_* > 127.0.0.1:8001) |
| `/unique_conditions` | — | 特殊效果(固有状态)全 21+ 条 `{conditions:[{id, string_id, name, icon, duration, max_count, flags[c9-13], extra, icon_exists}], note}` |
| `/shop/categories` | — | Boss币商店 50 类 `{categories:[{id, code, client_items, server_items}], server_file, note}` |
| `/shop/items` | `?cat=N` | 该类目物品合并视图(②层+服务端 json)`{items:[{id, in_client, in_server, name, desc, icon, cost_id, cost_amount, available_from/until, stock, reward_type/id/count, server}], note}` |
| `/char_image_pos` | `?character=ID` | 立绘定位 `{code_name, levels:[{level, img_w, img_h, canvas_w, canvas_h, fs:{x,y,w,h}, attr:{pivot_x,pivot_y,scale,face_x,face_y}, size_mismatch}], note}`(fs=character_image 内容框,attr=full_shot_image_attribute,canvas 来自 trimmed_image;保存 fs 时 trimmed_image 的 x,y **自动同步**) |
| `/skill_variants` | `?character=ID` | 形态切换变体 `{key, levels:[{level, program_path}], all_keys}`(switched_action_skill 内该角色引用) |
| `/backups` | — | `[{table, name, size, mtime}]` |
| `/mainpos` | — | `{restricted_rows, state}`(主位限制现状) |

## POST 端点(写;均支持 `"dry_run": true`)

| 路径 | 请求体 | 说明 |
|---|---|---|
| `/rows/save` | `{edits:[{ability,line,index,value}]}` | 词条逐字段;`ability` 带 `L:` 前缀写队长技表 |
| `/scale` | `{character\|ability[], fields, factor, rounding}` | 倍率;fields=别名(skill_strength 等)或列名 |
| `/copy` | `{from_character, to_character, slots[], preserve_string_id, fields?}` | 角色级词条移植 |
| `/copy_row` | `{src:{key,line}, dst:{key,line\|"append"\|"all"}, preserve_string_id}` | 行级移植;键前缀 L:/W:/S:;仅同表 + 角色词条↔队长技,其余跨表拒绝(列图不同) |
| `/append_line_adapted` | `{src_key, src_line, dst_key, element:"auto"\|中文属性\|"", adapt_sid, clear_awake}` | **复制行+自动适配**(同表限定):元素 token/枚举列→目标属性(auto=按目标角色/武器检测)、string_id 统一、觉醒门槛清零、武器解锁等级对齐;响应含 `adapted_desc`;效果枚举自带属性时 log 带 ⚠ 提醒 |
| `/copy_leader` | `{from_character, to_character, slot, preserve_string_id}` | 队长技→常驻词条 |
| `/recipe` | `{recipe:{operations:[...]}}` | 自由配方(op: set/scale/copy_ability/copy_fields/remove_main_position) |
| `/mainpos` | `{action:"remove"\|"restore"\|"status"}` | 主位限制开关(无 dry_run;status 建议用 GET) |
| `/char_fields/save` | `{character, edits:{字段:值}}` | ① 层资料;element 接受中文名;重启服务端生效 |
| `/status_values/save` | `{character, entries:[{level,hp,atk}]}` | 基础数值;断点白名单(不允许增删) |
| `/awake_values/save` | `{character, atk_plus, hp_plus}` | 觉醒加成;仅限已有 36 键 |
| `/soul_rows/save` | `{edits:[{key,line,index,value}]}` | 能力魂逐字段 |
| `/skill_energy/save` | `{character, edits:[{level, min_skill_weight?, max_skill_weight?, name?, description?}]}` | 技能字段(action_skill;缺省不改;名称/描述半角逗号/换行自动清洗防破坏 CSV) |
| `/skill_copy` | `{from_character, to_character}` | **整技能替换**:外层行原样字节复制(全部级别+名称/描述/能量/ActionDsl 路径),零重编码风险 |
| `/skill_level_copy` | `{from_character, from_level, to_character, to_level}` | 单级别移植:目标已有该级=原位替换,没有=追加(可给无＋＋角色加第 3 段) |
| `/skill_level_delete` | `{character, level}` | 删技能级别(至少留 1;删"2"影响已进化存档,慎用) |
| `/skill_dsl/save` | `{character, level, edits:[{offset, len, type, value}]}` | 技能效果数值**原地补丁**(U29 等长补位/double 覆写;超出原字节数拒绝) |
| `/raw_json/save` | `{table, key, json_text}` | **JSON 直改**整键写回:flat 强制整表等宽(超宽尾列非空拒绝)、nested 内层已有键相对顺序不可重排、不允许新增顶层键;单元格数字/布尔自动转字符串;②层自动备份+进待发布,①cdndata 备份后直写(重启服务端生效,不发 CDN);ml 标记的表(unique_condition/boss_coin_shop*)走多行安全 CSV |
| `/server/push` | `{}` | **推送服务端**:POST 服务端 `/api/mod-admin/reload_assets`,让其重读 9 个热重载 json(商店 7 文件+character.json),①层/服务端侧改动即时生效不用重启;服务端离线报友好错误 |
| `/unique_condition/save` | `{id, edits:{name?,duration?,max_count?,string_id?}, icon_b64?, force_icon?}` | **特殊效果**新增/编辑:已有 id 改名称/持续帧/层数+可换图标;新 id=新增(需 string_id+name+icon_b64),行=默认模板,图标写全新 store 路径 `battle/common/unique_condition/<sid>.png`(48x48 强校验,force 可绕);全部进待发布 |
| `/shop/item/save` | `{cat, id, edits:{name?,desc?,icon?,cost_id?,cost_amount?,available_from?,available_until?,stock?,reward_type?,reward_id?,reward_count?}, clone_from?}` | **商店三处同步写**:②层 boss_coin_shop 行(c6名称/c10描述/c17-18成本/c25-26时间/c28+c31库存/c32-34奖励)+cdndata 镜像+服务端 boss_coin_shop.json(costs/rewards/时间/stock)+类目映射;id 不存在=克隆 clone_from 新增三处;时间格式 YYYY-MM-DD HH:MM:SS 强校验 |
| `/char_image_pos/save` | `{character, level:0\|1, fs:{x,y,w,h}?, attr:{pivot_x,pivot_y,scale,face_x,face_y}?}` | **立绘定位**写回:fs→character_image(嵌套),attr→full_shot_image_attribute(嵌套);角色不在表中自动新增外层键;两表均②层发布生效 |
| `/skill_dsl_upload` | `{character, level, kind:"main"\|"switch", json_text?\|data_b64?}` | **技能效果文件上传**:main=action_skill 级别(1/2/3),switch=switched_action_skill 变体;json_text=技能JSON(编码自校验)/data_b64=AMF3 或 deflate(自动识别,parse 通过才收);目标文件官方未下发=**新建**;program_path 无效(短行)报错;含共享文件提醒 |
| `/asset/replace` | `{logical, data_b64, force?}` | 上传替换资产:PNG 校验魔数+尺寸(不匹配需 force;**story/cut-in/立绘等裁剪图尺寸变化时 trimmed_image/character_image trim 定位自动同步**),MP3 **严格校验**(逐帧复核覆盖+CBR 恒定,VBR/损坏/半截拒收);自动备份+进待发布(medium/android 根加前缀,发布自动分包) |
| `/char_snapshot` | `{character, note?}` | **单角色一键快照**:②层全部表行+①层条目+全部资产+技能DSL 打成 zip(work/char_snapshots/,实测约 7MB;无 dry_run,零副作用) |
| `/char_restore` | `{file, dry_run}` | 快照还原:逐项比对只写有差异的部分(表行/①层/资产),自动备份+进待发布;①层部分需重启服务端 |
| `/char_clone` | `{src, new_id, new_name?, new_code?, dry_run}` | **新建角色**:②层 **16 张按 character_id 索引的表**全部新增键(词条6键独立;含 character_image/full_shot_image_attribute/mana_board/mana_node 等嵌套表,原样字节复制)+①层两 json;**写入后校验键落盘否则抛错**。new_code 非空=资产独立(复制~32 资产+action_skill 独立键)。发放走官方邮件/admin(跳过扭蛋) |
| `/char_delete` | `{cid, dry_run}` | **删除角色**(回滚金丝雀):②层全表 + ①层两 json 整键删除,自动备份;发布+重启服务端生效,已 admin 发放的还需从存档移除 |
| `/weapon_ability/save` | `{edits:[{key,line,index,value}]}` | 武器词条逐字段 |
| `/delete_line` | `{key, line}` | 删词条行(键剩 1 行时拒绝;前缀 `L:`队长技 `W:`武器词条 `S:`能力魂) |
| `/mainpos_one` | `{ability, line, action:"on"\|"off"}` | 单条主位开关(off 同时把前置 202→0;仅 ability 表) |
| `/copy_leader_to_leader` | `{from_character, to_character, preserve_string_id}` | 队长技→队长技整段替换(preserve=false 连描述一并移植) |
| `/export_all` | `{}` | 全量词条 CSV → `{out, rows, hint}` |
| `/export_annotated` | `{}` | 标注版 CSV → 同上 |
| `/restore` | `{name}` | 用指定备份覆盖当前表 → `{restored, table, target}`(还原前自动存 prerollback 备份) |
| `/rollback` | `{name, restart?}` | 一键回溯 = restore + 自动发布 + 重启游戏 → restore 响应 + `{ok, publish_log, restart_log?}` |
| `/publish` | `{tables?, list_only?, restart?}` | 一键发布:调 wf_publish 打增量包到 CDN → `{ok, log, list_only, restart_log?}`;`tables` 缺省=发布 pending 并清空;`list_only:true` 只预检不打包(代替 dry_run);成功后默认重启游戏 |
| `/sync` | `{restart:true}` | adb push pending + 重启游戏 → `{ok, log}`(备用手段;② 层正道是 `/publish`) |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WF_GUI_PORT` | 8765 | 监听端口(Windows 保留段时自动换备用端口) |
| `WF_PROFILE` | profiles.json 的 active | 版本档案(当前锁 cn) |
| `WF_TARGET_STORE` | 由 profile 决定 | 覆盖目标数据包路径(②层 upload 目录) |
| `WF_CDNDATA` | 按仓库根布局推导 | 服务端 `assets/cdndata`(①层;独立部署必配) |
| `WF_CDN_DIR` | 按仓库根布局推导 | 服务端 `.cdn/cn`(发布目标;独立部署必配) |
| `WF_ADB` / `WF_ADB_PORT` / `WF_PKG` | 自动探测 / 16384 / **com.leiting.wf**(雷霆国服,不是 air.开头的旧包名) | 模拟器同步 |

写接口防护:请求体上限 64MB(超限返回 400);服务仅绑定 127.0.0.1,无鉴权——**不要暴露到局域网/公网**,并入服务端后台前必须补鉴权与审计。

## React 迁移备注

- 左侧角色列表数据 = `/characters`(筛选维度:rarity / element / race,race 为逗号分隔多值)。
- 词条/能力魂表格按 `columns` 渲染;中文列名映射见 `wf_gui.html` 的 `COL_CN`
  (token 逐段翻译,迁移时直接搬走;`power1`=SLv1 值,`first_max`=SLv 满级值)。
- 枚举展示:`/schema` 的 `enums[列号][值]`。
- 未保存守卫 / 预览确认 / toast 语义在 AntD 下对应 `Modal.confirm`(带 log 明细)+ `message`。
