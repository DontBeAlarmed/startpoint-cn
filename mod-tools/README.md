# WF-CN Mod Tools · 世界弹射物语(国服)数据修改工具链

面向 [startpoint-cn](https://github.com/DontBeAlarmed/startpoint-cn) 私服的离线数据修改工具:
可视化 / 命令行修改角色词条、基础数值(HP/ATK)、觉醒加成、能力魂、队长技、技能能量、
角色资料,并经服务端 CDN 增量下发到客户端生效。

## ⚠️ 免责声明

- 本工具仅用于**学习、研究、单机 / 私服环境**下对**你自己拥有的**游戏资源进行修改。
- **不包含、不分发任何游戏本体资产**(数据包、APK、美术、语音等版权内容归游戏运营方所有)。
  使用者需自备合法获得的游戏资源。
- 修改联网正式服数据、用于作弊或商业用途均可能违反游戏服务条款,由使用者自行承担后果。
- 逆向所得的字段语义 / 解密方式仅供技术交流;上游生态(wfax / wdfp-extractor)已公开同类逻辑。

## 环境

- Python ≥ 3.10(仅标准库,无第三方依赖)
- 一份合法的手机端游戏数据包(`WorldFlipper/dummy/download/production/upload`)
- startpoint-cn 服务端(用于把改动下发给客户端)
- 可选:MuMu 12 模拟器 + adb(用于直接同步 / 重启游戏)

## 快速开始

```bash
# 1) 配置数据包路径
cp mod-tools/profiles.example.json mod-tools/profiles.json
#    编辑 profiles.json,把 store 指向你的 upload 目录

# 2) 启动网页修改器
python mod-tools/wf_gui.py          # 浏览器打开 http://127.0.0.1:8765

# 3) 改完发布到 CDN(客户端增量更新时拉取)
python mod-tools/wf_publish.py --tables ability,character_status

# 4) 重启服务端 + 重启游戏 → 改动生效
```

## 工具一览

| 工具 | 用途 |
|---|---|
| `wf_gui.py` + `wf_gui.html` | 网页修改器,分组导航(角色 / 武器 / 全局 / 系统):词条 / 数值 / 技能·倍率 / 资料 / 资产 / 新建角色 / 武器·魂珠 / Boss·副本 / 速查 / 移植 / 配方 / 工具箱 / 日志 / 备份 |
| `wf_mod_tool.py` | 核心引擎:orderedmap(含嵌套表)读写、AMF3 schema 解析、recipe 配方、版本档案 |
| `wf_publish.py` | 把改动打成增量包发布到服务端 CDN(与官方增量更新同构) |
| `wf_boss.py` / `wf_quest_lib.py` | Boss 数值 + 22 类副本列表;quest 系三层压缩索引嵌套表读写 |
| `wf_assets.py` / `wf_dsl.py` / `wf_describe.py` | 角色资产编解码;技能 ActionDsl 编辑(AMF3);行级中文描述 |
| `wf_atf.py` | skill_cutin 的 ATF(ETC1)纹理重编码——战斗真机只读 ATF 不读 PNG,替换 cut-in 时自动/手动重生成 |
| `wf_export_assets.py` | 全量解密导出(下载包+bundle → 逻辑路径目录树;GUI 工具箱可跑) |
| `wf_recover_pathlist.py` | 复原哈希→逻辑路径表 WF_PATHLIST_recovered(GUI 工具箱可跑) |
| `wf_decrypt_all.py` | 单文件零依赖版全量解密(不依赖本工具链任何文件,便于独立分发) |
| `wf_char_editor.py` | ① 层角色资料(名字 / 描述 / 稀有度 / 元素…)编辑 |
| `wf_scan_masterdata.py` / `wf_extract_paths.py` / `wf_harvest_paths.py` | 数据定位 / 路径逆向 |

## 能力总览(② 层可改项)

技能能量(action_skill) · 队长技移植/修改(leader_ability) · 角色词条增删改(ability) ·
词条主位限制开关(全局 + 单条) · 能力魂(ability_soul) · **武器词条(equipment_enhancement_ability)** ·
基础数值/觉醒/倍率 · 一键发布到 CDN(客户端只下增量)· **自动改动日志 + 一键回溯**。**移植不崩的规律见下方规律方案。**
端点清单见 [角色改动规律方案.md §7](角色改动规律方案.md) 或 [API.md](API.md)。

## 文档

- **[角色改动规律方案.md](角色改动规律方案.md)** — 改动规律总纲:五表列图、五类改动标准做法、**移植铁律(同属性/别去共鸣/统一sid/跨表重排)**、做不到的边界、效果代码速查、工具能力矩阵。
- **[词条条件代码全表.md](词条条件代码全表.md)** — 真实列图 + 全枚举名(配 `ability_enum_map.json`)。
- **[CN-Mod字段手册.md](CN-Mod字段手册.md)** — 最重要:全字段语义、枚举、单位、各表结构、CN/global 差异、安全规则。
- [角色数据逆向与修改指南.md](角色数据逆向与修改指南.md) — 两层数据架构 + HP/ATK / 觉醒破解过程。
- [版本切换设计.md](版本切换设计.md) — 多版本档案(profile)设计。
- [API.md](API.md) — 网页修改器的 HTTP API 契约。
- [WF_mod_tool_usage.md](WF_mod_tool_usage.md) — 命令行 recipe 用法。

配套还有一个 Claude Code skill(`.claude/skills/wf-mod/`),把整条工作流固化,便于用 AI 辅助操作。

## 致谢

- [Duosion/starpoint](https://github.com/Duosion/starpoint) · [DontBeAlarmed/startpoint-cn](https://github.com/DontBeAlarmed/startpoint-cn) — 服务端模拟器
- [wfax](https://github.com/blead/wfax) · [wdfp-extractor](https://github.com/ScripterSugar/wdfp-extractor) — 资源提取 / 转换

## License

GPL-3.0-or-later(与上游 startpoint-cn 一致)。
