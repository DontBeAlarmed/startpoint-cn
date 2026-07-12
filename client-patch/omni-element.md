# 可选补丁:共鸣通用属性(OmniElement)

让带有 `OmniElement` 角色标签(character 表 c5)的角色**匹配任意元素的角色组条件**——
其他角色词条要求"火共鸣≥N/水编成≥N/[限X属性]"时,该角色一律计入/命中,等效"全属性通配"。

## 逆向依据(2026-07-12)

- 词条角色组 token 解析(`OrCharacterGroup_Impl_.resolve`):元素名(Red/Blue/Yellow/Green/
  White/Black/Colorless)固定解析为 `CharacterGroup.Element`,**不可能**被角色标签顶替。
- 元素组匹配是**严格等值**:`ElementKind.toColorlessable(角色element) == 组元素`,
  数据层没有通配值 → 必须打客户端补丁。
- 角色自身的 `character_tag`(character 表 c5,逗号分隔)客户端**不做表校验**,
  塞未知 token 无害 → 用 `OmniElement` 标签做**逐角色开关**,补丁只认这个标签。
- 匹配逻辑有**三处独立实现**,都要改(战斗内计数/效果目标 + 编队/共鸣 UI 主位 + 副位):
  1. `pinball/common/data/character/BattleCharacterLogic.as` 的 `matchCharacterGroup`
  2. `pinball/common/data/battle/squadMember/SquadMemberSource.as` 的 `matchCharacterGroup`
  3. `SquadMemberSource.as` 的 `matchUnisonCharacterGroup`(**副位**是独立实现,Element 分支
     走 `matchElements(unisonElements,…)`;`unisonCharacterTags` 字段官方现成。2026-07-12 补:
     不改这处的话,OmniElement 角色放**副位**时元素共鸣/编成条件不计入它)

## 改动内容(各一行)

`BattleCharacterLogic.as` — Element 分支(case 0):

```as
// 原
if(ElementKind_Impl_.toColorlessable(get_element()) == int(_loc4_.params[0]))
// 改
if(ElementKind_Impl_.toColorlessable(get_element()) == int(_loc4_.params[0]) || get_characterTags().indexOf("OmniElement") != -1)
```

`SquadMemberSource.as` — Element 分支(case 0):

```as
// 原
if(ElementKind_Impl_.toColorlessable(element) == int(_loc4_.params[0]))
// 改
if(ElementKind_Impl_.toColorlessable(element) == int(_loc4_.params[0]) || characterTags.indexOf("OmniElement") != -1)
```

`SquadMemberSource.as` — `matchUnisonCharacterGroup` Element 分支(副位):

```as
// 原
if(SquadMemberSource.matchElements(unisonElements,int(_loc4_.params[0])))
// 改
if(SquadMemberSource.matchElements(unisonElements,int(_loc4_.params[0])) || unisonCharacterTags.indexOf("OmniElement") != -1)
```

## 应用

在 FFDec 导出的 AS3 目录上跑 `bash apply-omni-element.sh <EXPORT_DIR>`(或按上文手动改两处),
再按 [README.md](README.md) 的流程回封 SWF / 重签 APK。

## 数据侧开关

修改器「角色资料」页 →「共鸣通用(OmniElement)」开关,即给该角色 c5 加/去标签
(端点 `GET /omni_element` / `POST /omni_element/set`),发布后生效。
**没打补丁时标签零效果**,可以先埋数据再换客户端。

## 波及面(打开后)

- 队友词条里一切元素条件(共鸣计数/编成数/触发来源角色组/[限X]效果目标)都把该角色当命中;
- 编队界面共鸣 ribbon 一并计入(同一匹配函数);
- 角色自身元素(伤害属性/克制关系/属性球)**不变**——只影响"组匹配"。

## 这是「通用属性」的**唯一**可用做法

OmniElement 标签(本补丁)让角色计入任意元素共鸣,但**保留真实元素**——这是能安全做到
的上限。想让角色 element=6「真无属性」会**崩溃**(Colorless 是敌人专属元素,2026-07-12
实测阿尔克 element=6 → 查看/进战即 C7050),[element-colorless](element-colorless.md)
已标注作废。全套方案见 `mod-tools/docs/通用属性方案.md`。
