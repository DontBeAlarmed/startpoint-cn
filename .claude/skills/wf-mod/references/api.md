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
| `/skill_dsl_json` | `?character=&level=` 或 `?pp=路径` | 整棵技能 DSL 命令树 JSON `{program_path, json_text, bytes, sharers[], note}`(往返自检失败的文件拒绝导出;int/double 以 3/3.0 区分,「效果词条」编辑器与 JSON 编辑共用;`pp`=直接按 program_path 打开,强化弹射/变体用) |
| `/pixelart_data` | `?character=ID&name=atlas\|special_atlas\|frame\|timeline\|special_frame\|special_timeline` | 像素图排布/动画数据解码 JSON `{logical, source, desc, bytes, entries, byte_roundtrip, json_text, note}`(atlas=AMF3 列表每项 `{n,x,y,w,h[,r]}`;store 优先 APK bundle 兜底;容器 raw deflate(-15),全库实测字节级往返) |
| `/raw_json/tables` | — | JSON 直改支持的表 `{tables:[{alias, kind:flat\|nested\|cdn, cn, target}]}`(②平表9张/②嵌套2张/①cdndata 8个) |
| `/raw_json/keys` | `?table=别名&q=过滤` | `{total, keys[]}`(最多 100) |
| `/raw_json` | `?table=&key=` | 整键 JSON 视图 `{table, key, kind, json_text, note, width?}`:flat=`[[列,...],...]`(一行一数组)/nested=`{内层键:[[列,...]]}`/cdn=原生节点 |
| `/server/ping` | — | `{online, url, server_time?, detail?}`(startpoint 服务端 mod-admin 探活;url 来自 WF_SERVER_URL > .env CN_LISTEN_* > 127.0.0.1:8001) |
| `/unique_conditions` | — | 特殊效果(固有状态)全 21+ 条 `{conditions:[{id, string_id, name, icon, duration, max_count, flags[c9-13], extra, icon_exists}], note}` |
| `/shop/categories` | — | Boss币商店 50 类 `{categories:[{id, code, client_items, server_items}], server_file, note}` |
| `/shop/items` | `?cat=N` | 该类目物品合并视图(②层+服务端 json)`{items:[{id, in_client, in_server, name, desc, icon, cost_id, cost_amount, available_from/until, stock, reward_type/id/count, server}], note}` |
| `/char_image_pos` | `?character=ID` | 立绘定位 `{code_name, levels:[{level, img_w, img_h, canvas_w, canvas_h, fs:{x,y,w,h}, attr:{pivot_x,pivot_y,scale,face_x,face_y}, size_mismatch}], note}`(fs=character_image 内容框,attr=full_shot_image_attribute,canvas 来自 trimmed_image;保存 fs 时 trimmed_image 的 x,y **自动同步**) |
| `/skill_variants` | `?character=ID` | 形态切换变体 `{key, levels:[{level, program_path}], all_keys}`(switched_action_skill 内该角色引用) |
| `/composer/meta` | — | **词条工坊**元数据(静态):`{kinds:{kind:{ncols, blocks, head, trigger_col}}, block_fields, enums:{五大枚举:{值:{en,cn}}}, small:{target/puller/element/precontent/multiply/opening}, groups, categories, usage, unique_conditions, note}` |
| `/composer/blank` | `?key=词条键` | 空白行底稿:头部列抄目标首行(觉醒门槛清零、trigger=0),**其余=官方众数模板**(按块所属触发模式统计;纯空串枚举列会触发客户端 C7050——parseAt* 无空串分支,官方哨兵 前置='0'/instant_precontent='(None)'/累积触发='(None)'/even_if='false') → `{key, kind, ncols, row[], lines_total}` |
| `/composer/row` | `?key=&line=&as_key=?` | 读任意键一行(补齐表宽)作模板/编辑对象;`as_key`=目标键 → 跨表(仅 角色词条↔队长技)自动列重排,响应含 `remap_note` |
| `/skill_sig` | — | **技能命令签名表**(静态,wf_dsl_sig 自反编译 AS3 生成):`{commands(112), events(6), enums(46 类构造签名), cmd_cn, ac_cn(42 种 AC* 状态词条), param_cn, ac_param_cn, type_cn}` |
| `/skill_cmd_lib` | `?name=&q=&limit=80` | **全库命令实例库**(1024 个技能 DSL 收割,按 名称+JSON 去重,action_skill mtime 缓存,首建约 1s):`{names:[{kind,name,cn,count}], items:[{kind, name, cn, brief, owners[], count, json}]}`;`json`=完整子树可直接插入 Block |
| `/powerflip/brief` | `?kind=?` | 该 PF 种类三级动作的中文命令摘要(合成工坊选材预览) |
| `/powerflip` | `?character=?` | **强化弹射总览**:`{kinds:[{id, cn, std, source:"store表"\|"内置base", levels:[{pp, in_store, in_apk}]}], apk, character, speciality(c6), spec_cn, note}`;5 标准种类+表内自定义键;in_apk=可「提取」 |
| `/omni_element` | `?character=ID` | **共鸣通用标签**状态 `{enabled, tags}`(character 表 c5 是否含 OmniElement;需客户端 client-patch/omni-element 补丁才生效) |
| `/asset/export_char` | `?character=ID` | **一键导出全部资产**:直接返回 zip 附件(Content-Disposition)。内容=pathlist 的 character/<code>/** + battle/** 含 /<code>/ 的特效 + 清单探测项 + cut-in ATF + 该角色全部技能/PF DSL + **DSL 内 SpecifyEffectDirectly 引用的动画 parts/timeline(哈希探测,补 pathlist 盲区)**;PNG/MP3 解混淆,目录树与「资产包导入」一比一互通;落盘 work/asset_exports/ |
| `/asset_template` | `?character=ID` | **新角色资产模板完整度**(2026-07-13):`{groups:[{name, required, items:[{logical,exists,dims,size,req}], exists, total}], pct, required_total, required_exists, missing_required[]}`;必要=立绘/头像/缩略图/战斗UI/连锁cutin/技能cutin/图标合集/像素图/配套数据,语音=建议,剧情不检查 |
| `/effects` | `?character=ID` | **战斗特效预览**:`{effects:[{dir, name, sheet, frames:[{frame,x,y,w,h,r,fx,fy}], sequences, sounds, n_images, n_layers}]}`;贴图=目录图集 `<dir>/<目录名>.png`+同名 atlas(帧名 `.gen/<效果>/x`),帧墙切割用;完整骨架播放不复刻 |
| `/skill_summary` | `?character=&level=` | **技能效果摘要**:DSL 命令树按类别分组(伤害/增益状态/治疗/召唤/移动/演出/其他)成中文行 `{headline, groups:[{cat,count,lines[]}], program_path}`(wf_dsl_sig.brief_command) |
| `/composer/catalog` | — | **效果构建器**目录:`{triggers×16(含 dash 冲刺/flip 弹射), effects×23(精选,带默认单位/阈值;含 dmg_all/dmg_near/dmg_trig 对敌能力伤害伪 kind 与 invoke=InvokeSkill 629), all:{trigger:{instant[262],during[230]}, effect:{instant[724],during[422]}, precondition}(全量枚举,每项{kind,cn,en,n}按使用频次排序), pullers, targets, groups, preconditions_common×6(无/Fever中/非Fever/HP≥/HP≤/技能槽≥)}`;精选=常用速选,all=自由组合 |
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
| `/composer/describe` | `{kind, row[]}` | 结构化行 → 行级中文描述 `{desc}`(工坊实时预览;无副作用) |
| `/composer/generate` | 精选:`{dst_key, trigger, effect, value, value_max?, threshold?, target, groups}`;自由:`{dst_key, mode:"instant"\|"during", trigger_kind, effect_kind, effect_unit:"pct"\|"count"\|"raw"\|"x", threshold_unit, value, value_max?, threshold?, target, groups, puller?, trigger_groups?}`;通用扩展:`{precondition_kind?, precondition_threshold?, precondition_unit?, hits?, string_id?, action_path?}` | **效果构建器生成整行**(不写盘):精选传 catalog id,自由传 mode+枚举 kind(全量枚举任意组合);单位换算 %×1000/次×100000/倍×100000/raw×1;count 型效果数值也写 strength 列;during 触发 puller 恒填 0(7050);`precondition_kind`=前置条件(12=Fever中/186=非Fever/8=HP≥/9=HP≤/119=技能槽≥,阈值 precondition_unit 换算);`effect_kind:"DMG:all\|near\|trig"`=对敌能力伤害伪 kind→251/352/316 族+元素(元素取 groups 属性 token,否则查 dst_key 所属角色 c3;魂珠/武器键须显式给属性);`hits`=伤害段数(time 列:EnemyDamage 族空=全体/N=最近顺序N段);`string_id`+`action_path`=InvokeSkill(629)技能键与 DSL 路径(629 且 value=0 → strength 列留空);返回 `{row[], desc, trigger, effect, kind}`,写入走 /composer/apply |
| `/element_convert` | `{character, target:"火"\|…\|"暗"\|0-5}` | **整体转属性**:把角色整套改成目标属性——c3 element + 6词条/队长技元素 token(character_groups 己方门槛) + content element 数值列 + ①层三层同步(复用 save_char_fields)。技能伤害元素随 c3 自动。元素型枚举 kind(抗性/敌方,判他方元素)不翻,列进 log 报告。dry-run 逐条预览 |
| `/composer/apply` | `{dst_key, mode:"append"\|行号, row[], adapt_sid, create_missing?}` | **词条工坊写入**:行宽对齐目标表(尾部非空超宽拒绝)、单元格禁引号/换行(逗号放行,write_csv_lines 自动加引号=官方惯例);adapt_sid=string_id 对齐目标首行;ability 目标 unisonable 非法值强设 true;create_missing+append=新建整键(缺失槽位);**写入前跑客户端合法性硬校验**(`_client_legality_problems`:前置1-3/触发/内容 kind 须数字、instant_precontent='(None)'或数字、during 累积触发='(None)'或数字、even_if_owner_dead 须 bool——违规拒绝写入,防 C7050);响应含 `desc`;已验证 追加+delete_line 后表文件字节复原 |
| `/powerflip/spec` | `{character, speciality:0-4}` | 改角色 **PF 种类** = character 表 c6(0剑士/1格斗/2射击/3辅助/4特殊,类型图标随之变);②层发布生效 |
| `/powerflip/extract` | `{kind}` | 把 APK 内置的该种类 3 个 PF 动作 DSL **原样字节提取进 store**(行为不变,之后可编辑);APK 取 WF_APK > 弹国服/*.apk 最新 |
| `/powerflip/clone` | `{src_kind, new_id}` | **新建 PF 种类**:克隆 3 个动作文件到 `battle/action/power_flip/action/override/<new_id>$..._lvN` + power_flip_action 表加键;new_id 禁标准名(内置 base 键重复=客户端 7051 崩溃);激活=队长词条 powerflip_override.id=new_id, levels="1,2,3" |
| `/powerflip/compose` | `{new_id, base_kind, donors:[kind…], character?, dry_run}` | **PF 合成工坊**:基底+任意供体合成新种类(基底留生命周期,供体剥离抑制/结束/RemoveEvent 只留攻击演出,标签 _N 后缀,抑制帧取最大);character 非空=同时给其队长技挂/改指 instant 722 行(无条件);返回 `{briefs:{lv:[中文命令…]}, leader_key, log}`;真机范本 override_dual_spgirl_meteor |
| `/omni_element/set` | `{character, enable}` | 开/关**共鸣通用**:character 表 c5 加/去 `OmniElement` 标签(元素组匹配是严格等值,数据层无通配 → 需配合 client-patch/omni-element 两处 matchCharacterGroup 补丁;无补丁时标签无效果无副作用) |
| `/omni_convert` | `{character}` | **一键通用共鸣(Form A)**:只挂 OmniElement 标签(c5),**不改 element**(角色保留真实元素/伤害/克制,只让它计入任意元素共鸣/编成/[限X])。已开启时 no-op。dry-run 附属性配对检查报告。⚠ **不再改 element=6**——2026-07-12 实测 element=6(Colorless 敌人专属)给可玩角色会崩(C7050;forceUncolorless 硬抛 + 连锁数组越界),已回滚并禁止;需 client-patch/omni-element 补丁生效;方案档案 `mod-tools/docs/通用属性方案.md` §0 |
| `/copy_leader` | `{from_character, to_character, slot, preserve_string_id}` | 队长技→常驻词条 |
| `/recipe` | `{recipe:{operations:[...]}}` | 自由配方(op: set/scale/copy_ability/copy_fields/remove_main_position) |
| `/mainpos` | `{action:"remove"\|"restore"\|"status"}` | 主位限制开关(无 dry_run;status 建议用 GET) |
| `/char_fields/save` | `{character, edits:{字段:值}}` | ① 层资料;element 接受中文名(**火/水/雷/风/光/暗**,element=6/通用被硬拦截:Colorless 敌人专属,写可玩角色会崩);重启服务端生效 |
| `/status_values/save` | `{character, entries:[{level,hp,atk}]}` | 基础数值;断点白名单(不允许增删) |
| `/awake_values/save` | `{character, atk_plus, hp_plus}` | 觉醒加成;仅限已有 36 键 |
| `/soul_rows/save` | `{edits:[{key,line,index,value}]}` | 能力魂逐字段 |
| `/skill_energy/save` | `{character, edits:[{level, min_skill_weight?, max_skill_weight?, name?, description?}]}` | 技能字段(action_skill;缺省不改;名称/描述半角逗号/换行自动清洗防破坏 CSV) |
| `/skill_copy` | `{from_character, to_character}` | **整技能替换**:外层行原样字节复制(全部级别+名称/描述/能量/ActionDsl 路径),零重编码风险 |
| `/skill_level_copy` | `{from_character, from_level, to_character, to_level}` | 单级别移植:目标已有该级=原位替换,没有=追加(可给无＋＋角色加第 3 段) |
| `/skill_level_delete` | `{character, level}` | 删技能级别(至少留 1;删"2"影响已进化存档,慎用) |
| `/skill_dsl/save` | `{character, level, edits:[{offset, len, type, value}]}` | 技能效果数值**原地补丁**(U29 等长补位/double 覆写;超出原字节数拒绝) |
| `/skill_dsl_json/save` | `{character, level, json_text}` 或 `{pp, json_text}` | 整树 JSON 替换(encode→parse 自校验,失败拒写;备份+进待发布;「效果词条」编辑器的保存出口——前端字面量保持序列化,无改动时=字节级一致返回 changes:0;`pp` 直写任意效果文件) |
| `/pixelart_data/save` | `{character, name, json_text?\|data_b64?, dry_run}` | 像素图数据写入:json_text=页内编辑保存;data_b64=上传文档(.json/.amf3.deflate/裸 AMF3 自动识别)。encode→decode 自校验(dict 键序参与比较),同内容 changes:0;bundle-only 文件保存=新建 store 文件下载优先接管;备份 .bak-wfmod-pixdata-* +进待发布 |
| `/raw_json/save` | `{table, key, json_text}` | **JSON 直改**整键写回:flat 强制整表等宽(超宽尾列非空拒绝)、nested 内层已有键相对顺序不可重排、不允许新增顶层键;单元格数字/布尔自动转字符串;②层自动备份+进待发布,①cdndata 备份后直写(重启服务端生效,不发 CDN);ml 标记的表(unique_condition/boss_coin_shop*)走多行安全 CSV |
| `/server/push` | `{}` | **推送服务端**:POST 服务端 `/api/mod-admin/reload_assets`,让其重读 9 个热重载 json(商店 7 文件+character.json),①层/服务端侧改动即时生效不用重启;服务端离线报友好错误 |
| `/unique_condition/save` | `{id, edits:{name?,duration?,max_count?,string_id?}, icon_b64?, force_icon?}` | **特殊效果**新增/编辑:已有 id 改名称/持续帧/层数+可换图标;新 id=新增(需 string_id+name+icon_b64),行=默认模板,图标写全新 store 路径 `battle/common/unique_condition/<sid>.png`(48x48 强校验,force 可绕);全部进待发布 |
| `/shop/item/save` | `{cat, id, edits:{name?,desc?,icon?,cost_id?,cost_amount?,available_from?,available_until?,stock?,reward_type?,reward_id?,reward_count?}, clone_from?}` | **商店三处同步写**:②层 boss_coin_shop 行(c6名称/c10描述/c17-18成本/c25-26时间/c28+c31库存/c32-34奖励)+cdndata 镜像+服务端 boss_coin_shop.json(costs/rewards/时间/stock)+类目映射;id 不存在=克隆 clone_from 新增三处;时间格式 YYYY-MM-DD HH:MM:SS 强校验 |
| `/char_image_pos/save` | `{character, level:0\|1, fs:{x,y,w,h}?, attr:{pivot_x,pivot_y,scale,face_x,face_y}?}` | **立绘定位**写回:fs→character_image(嵌套),attr→full_shot_image_attribute(嵌套);角色不在表中自动新增外层键;两表均②层发布生效 |
| `/skill_dsl_upload` | `{character, level, kind:"main"\|"switch", json_text?\|data_b64?}` | **技能效果文件上传**:main=action_skill 级别(1/2/3),switch=switched_action_skill 变体;json_text=技能JSON(编码自校验)/data_b64=AMF3 或 deflate(自动识别,parse 通过才收);目标文件官方未下发=**新建**;program_path 无效(短行)报错;含共享文件提醒 |
| `/asset/replace` | `{logical, data_b64, force?}` | 上传替换资产:PNG 校验魔数+尺寸(不匹配需 force;**story/cut-in/立绘等裁剪图尺寸变化时 trimmed_image/character_image trim 定位自动同步**),MP3 **严格校验**(逐帧复核覆盖+CBR 恒定,VBR/损坏/半截拒收);自动备份+进待发布(medium/android 根加前缀,发布自动分包) |
| `/asset/import_pack` | `{character, dir, force?, dry_run}` | **资产包批量导入**:dir=本机目录**或 .zip 路径**(zip 解压到 work/ 临时目录用完即清;外层多套的文件夹自动下钻到含 ui/pixelart/voice/battle 的那级,最多 3 层);相对路径=character/<code>/ 下逻辑路径,逐文件走 /asset/replace 同款校验;`.gif/.json/_resized./animated/切片目录` 当提取器产物跳过(排布 json 走 /pixelart_data/save);返回 replaced/artifacts/missing/bad 分类报告 |
| `/char_snapshot` | `{character, note?}` | **单角色一键快照**:②层全部表行+①层条目+全部资产+技能DSL 打成 zip(work/char_snapshots/,实测约 7MB;无 dry_run,零副作用) |
| `/char_restore` | `{file, dry_run}` | 快照还原:逐项比对只写有差异的部分(表行/①层/资产),自动备份+进待发布;①层部分需重启服务端 |
| `/char_clone` | `{src, new_id, new_name?, new_code?, dry_run}` | **新建角色**:②层 **16 张按 character_id 索引的表**全部新增键(词条6键独立;含 character_image/full_shot_image_attribute/mana_board/mana_node 等嵌套表,原样字节复制)+①层两 json;**写入后校验键落盘否则抛错**。new_code 非空=资产独立(复制~32 资产+action_skill 独立键)。发放走官方邮件/admin(跳过扭蛋) |
| `/char_delete` | `{cid, dry_run}` | **删除角色**(回滚金丝雀):②层全表 + ①层两 json 整键删除,自动备份;发布+重启服务端生效,已 admin 发放的还需从存档移除 |
| `/weapon_ability/save` | `{edits:[{key,line,index,value}]}` | 武器词条逐字段 |
| `/weapon_clone` | `{src, new_id, new_name?, new_desc?, soul_from?, dry_run}` | **克隆新建武器**:equipment 行(c1名/c7描述改写,c10 soul_id→新键)+ ability_soul 同键被动(soul_from 可指定其他来源)+ 改造武器的 weapon_ability 行;图标沿用源(item/sprite_sheet.png 图集 20×20);服务端 equipment_ids.json+equipment_lookup.json 同步注册(**重启服务端**后邮件 type6 可发放);发布 equipment,ability_soul(,weapon_ability) |
| `/quest_clone` | `{src_node, src_rank, mode:"rank"\|"node", new_name?, node_name?, dry_run}` | **克隆领主战副本**:mode=rank 源节点内加新难度(已验证,node1 难度4-19 即此链路)/ node 新建独立节点(stage_node 克隆行改名,缩略图/背景沿用);quest id 自动 = `1{node:03d}{rank:03d}`;行动模式(field_data/zone/boss AI)原样保留;服务端 assets/boss_battle_quest.json 抄源报酬参数(**重启服务端**);发布 boss_battle_quest(,boss_battle_stage_node);数值后续用 Boss·副本页/JSON 直改调 |
| `/chain/state` | GET — | **连战塔**现状:`{key:"mod_chain_canary", mode:"fixed"|"random"|"empty", random_k, floors:[{field,bosses:[{key,name}]}], pool_total, official_floor, quests:[{id,name,floor,attached,enemy_level,hp_zako,hp_boss,atk_zako,atk_boss,time_limit}]}`(宝物域 2001-2006 六入口) |
| `/chain/pool` | GET — | 连战塔素材池全量(官方 floor 表带 boss 的层,~136 层,field+BGM+缩略图三元组实战验证) |
| `/chain/apply` | `{mode:"fixed"\|"random", floors?, random_k?, pool_size?, seed?, attach_ids:["2001",...], enemy_level?, hp_boss?, atk_boss?, hp_zako?, atk_zako?, time_limit?(帧), dry_run}` | **连战塔写入**:fixed=发布时抽定 N 层固定链 / random=`__random__,K` 魔法头+候选池(**客户端须打 client-patch/random-floor 补丁,否则进本即崩**);floor[mod_chain_canary] 整键重写 + 勾选入口 tower_floor_id(col110)指向链、未勾还原 treasure_cave_area + 难度列(col107 敌等级/col98-103 HP·ATK 修正/col111 时限)写勾选入口;发布 floor(,challenge_dungeon_event_quest) |
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
