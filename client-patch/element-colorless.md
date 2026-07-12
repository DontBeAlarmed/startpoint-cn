# ⚠️ 作废补丁:element=6 给可玩角色会崩(不要用)

> **2026-07-12 实测结论:把可玩角色的 element 改成 6(Colorless)会导致客户端崩溃
> (阿尔克 element=6 → 游戏内查看/进战即报 C7050),已回滚。此补丁保留仅作逆向记录,
> 不要在可玩角色上使用。**
>
> **为什么无解**:Colorless(6)是**敌人/boss 专属元素**,不是可玩属性——
> - `ColorlessableElementKind_Impl_.forceUncolorless(6)` **硬抛**(ClientError 10014:
>   "Colorless 无法转成 ElementKind"),ability 描述/内容构造会走到;
> - 战斗连锁 `SkillChainManagerImpl` 用 `ElementKindValue_Impl_.LENGTH`(=6)建数组并按
>   元素索引,element=6 → **index 6 越界**(合法 0–5);
> - 本补丁只补了 `ElementKindTools` 的 UI 显示(6 个函数),**救不了**上面两类逻辑层崩溃。
>
> **想要「任意共鸣」的正确做法**:用 [omni-element](omni-element.md) 的 **OmniElement 标签
> (Form A)**——角色**保留真实元素**(伤害/克制/UI 正常),标签让它计入任意元素的
> 共鸣/编成/[限X属性]。引擎**不支持**可玩角色「无属性」,别追求 element=6。

---

## (以下为原始逆向记录,element=6 场景已作废)

让 **element=6(Colorless)的角色**在客户端 UI 显示层不空白——
名称「无属性」、图标复用官方「全属性」图(element_any)、列表排序/筛选/推荐属性。

**注意**:此补丁**只**修 UI 显示层,**不**修逻辑层的 forceUncolorless 硬抛与连锁数组越界,
所以即便打了它,element=6 的可玩角色仍会崩。仅在给「敌人复用体/展示用实体」调 UI 时有参考价值。

## 逆向依据(2026-07-12,ElementKindTools.as / ElementKind_Impl_.as)

- `ElementKind_Impl_.toColorlessable()` 是**恒等函数**,element=6 全链路直通不炸;
  枚举 6=Colorless 是**官方原生值**(boss 可为无属性,词条角色组 token 也认 `Colorless`)。
- `ElementKindTools.as` 里 **3 个函数官方已带 case 6**(getNameColorlessable /
  getFullName / getIconTag),引用的文本键 `element_kind_colorless` /
  `element_kind_colorless_full` / `element_kind_colorless_icon` 官方文本表都有。
- **6 个函数缺 case 6**(文件 1 的全部改动,均在
  `pinball/common/data/general/ElementKindTools.as`):

| 函数 | 补的 case 6 | 影响面 |
|---|---|---|
| `getName` | `element_kind_colorless` 文本键 | 属性短名(列表/筛选) |
| `getIndex` | `return 6` | 属性排序(排在暗之后) |
| `getImagePath` | `element_any` 图标 | 属性图标(active/inactive 同图) |
| `getMediumImagePath` | `element_any_medium` 图标 | 中号属性图标(筛选面板) |
| `getColor` | `return 13421772`(0xCCCCCC 银灰,可改) | 属性主题色(文字/描边) |
| `convertElementRecommendToEnemy` | `return 6` | 推荐属性→敌属性换算 |

## 文件 2:属性限制关卡入场放行(2026-07-12 补)

`pinball/common/data/quest/condition/startable/party/QuestPartyStartableConditionByElement.as`
的 `satisfied()` 是**严格等值**(全员 element 必须 == validElement)——element=6 的角色
会被挡在一切[限X属性]关卡外。补丁给比较加 `&& get_element() != 6`(通用属性放行一切属性门)。

⚠ 该文件同时**修复一个 FFDec 反编译伪影**:循环内 `_loc4_ = true` 按原字节码语义应为
`false`(有一名成员不匹配即不可入场)。若不修,按导出源回编译会把「属性限制完全失效」
固化进客户端。**回封后建议实测**:用普通异色角色进[限X属性]关卡,应仍被拦。

## 判定矩阵(标注了 element=6 的**致命点**——这就是为什么此补丁无效)

| 位点 | 判的是谁的元素 | element=6 后果 |
|---|---|---|
| **`forceUncolorless(6)`**(ability 描述/内容构造) | 自身/ability 元素 | 💥 **硬抛 ClientError 10014**,本补丁不覆盖 |
| **`SkillChainManagerImpl`** 用 `ElementKindValue.LENGTH=6` 建数组按元素索引 | 自身 | 💥 **index 6 越界**(合法 0–5),本补丁不覆盖 |
| ElementKindTools 6 函数 | 自身(UI 显示) | ⚠ 未打补丁=空白/undefined(不崩);打了也只修显示,救不了上面两条 |
| QuestPartyStartableConditionByElement | 自身(入场门) | 严格等值,element=6 被挡在[限X属性]关卡外 |
| matchCharacterGroup ×2 + Unison | 自身(共鸣/编成) | 严格等值,element=6 不属六色 → 全不命中 |
| ConditionSlot 抗性/减伤、对X敌加伤、限X多球 | 攻击方/敌方/球体元素 | 与自身元素无关,不受影响 |

**结论**:UI 层(ElementKindTools)可补,但逻辑层的 `forceUncolorless` 硬抛和连锁数组越界
**无法通过数据/UI 补丁绕过**——它们是引擎对「Colorless 不是可玩元素」的刚性约束。
所以可玩角色 element=6 不可行,已在修改器彻底禁止写入。

## 资产清单(全部官方自带,零新增)

- `scene/general/sprite_sheet/vector_icon_color-assets/element_any` — 官方「全属性」
  图标(编成筛选用),case 6 直接复用;**没有** `element_any_inactive` 变体,
  所以 inactive 态也用同一张(可接受:通用属性无"未选中灰显"需求)。
- `.../element_any_medium` — 官方中号版,同样复用。
- 文本键 `element_kind_colorless(/_full/_icon)` — 官方文本表自带(boss 无属性用)。

## 应用

在 FFDec 导出的 AS3 目录上:

```bash
bash apply-element-colorless.sh <EXPORT_DIR>
```

脚本按函数名定位 6 个 switch,在各自 `default:` 前插入 case 6;可重复执行
(已打过的函数自动跳过)。再按 [README.md](README.md) 的流程回封 SWF / 重签 APK。

## 数据侧开关

修改器「角色资料」页 →「**改为通用属性**」一键(端点 `POST /omni_convert`):
element→6 三层同步(①cdndata + ②character/character_text 表 + 服务端简化表)
**并同时挂上 OmniElement 标签**。

为什么必须连着 [omni-element](omni-element.md) 一起打:元素组匹配是严格等值,
element=6 的角色**不属于六色中任何一色**——不配 OmniElement 补丁+标签的话,
一切「火共鸣≥N/[限X属性]」条件都不再命中该角色(纯削弱)。两补丁配合后:
资料显示通用属性,且任意元素共鸣/编成条件都计入。

## 波及面与已知边界

- 克制关系:element=6 角色**不吃克制也不打克制**,且无属性伤害**穿透单属性抗性/减伤**
  (ConditionSlot 按攻击元素过滤,6 不匹配任何单色抗性——与官方无属性 boss 伤害同构;
  实测以游戏内为准)。
- `EnemyElementKindTools.toOppositeElementKind` 的 Inherit 分支(boss 属性=继承
  队伍属性)没有 case 6:全队通用属性打「继承属性」boss 时 boss 属性未定义。
  极端场景,未补(要补可在该函数 case 0 内层 switch 加 `case 6: return 6`)。
- 角色自身伤害属性/属性球颜色等战斗表现取角色 element,改 6 后按无属性走,
  与 boss 无属性同一套逻辑。
- **角色词条里的属性配对不用改数据**:修改器「改为通用属性」dry-run 自带属性配对
  检查报告(逐行中文描述),矩阵见上表——保留原配对即最优。
