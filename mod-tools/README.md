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
| `wf_gui.py` + `wf_gui.html` | 网页修改器,8 个功能页(词条 / 资料 / 数值 / 觉醒·能力魂 / 倍率 / 移植 / 配方 / 备份) |
| `wf_mod_tool.py` | 核心引擎:orderedmap(含嵌套表)读写、AMF3 schema 解析、recipe 配方、版本档案 |
| `wf_publish.py` | 把改动打成增量包发布到服务端 CDN(与官方增量更新同构) |
| `wf_char_editor.py` | ① 层角色资料(名字 / 描述 / 稀有度 / 元素…)编辑 |
| `wf_scan_masterdata.py` / `wf_extract_paths.py` / `wf_harvest_paths.py` | 数据定位 / 路径逆向 |

## 文档

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
