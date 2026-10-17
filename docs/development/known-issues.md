# Known Issues（只记录，不在此修复）

> 记录规范：每条含现象/根因定位/触发链路/当前状态。修复后请把状态改为"已修复"并注明提交。

## 2026-10-14 内容热更新后 gacha/exec 500（Gacha 142 period is reversed）

**状态**：已由补丁侧修复（1.4.58 起修正排期数据；线上当前为 1.4.67、up-to-date，gacha/exec 恢复正常——2026-10-16 实测取证）。根因结论不变：**坏数据来自补丁包**（1.4.57 的 shiftedIds），基础表 142 排期正常。

**波及面补充（R-04，闲时全量审查 2026-10-14）**：坏内容在线时的实际影响大于最初记录——不止 gacha/exec 500，`/load`（持兑换点玩家无法登录）与存档导出/恢复同样会挂。

**缓解已落地（apply 目录级预检）**：内容 apply 的 reload 在替换运行时快照前运行目录级冒烟校验（当前含 gacha 目录构建），校验失败 apply 被拒、旧快照继续服务，坏内容不再上线。补丁侧仍需自行验证数据正确性——预检只拦截已知校验面。

**现象**
- 局域网实机设备连续 7 次 `POST /api/index.php/gacha/exec` 全部 500。
- 错误：`TypeError: Gacha 142 period is reversed.`，抛点 `src/lib/gacha-catalog/catalog.ts:174`（`buildGachaCatalog` 校验 `gacha.json` 表中 startDate > endDate 即抛）。

**触发链路（日志重建）**
1. 管理端 3 次 `POST /api/content-management/apply`（前两次 200 = 1.4.57 内容落盘 + 快照热重载；第三次 200 = up-to-date 短路）。
2. 12 秒后设备发起 `gacha/exec` → 首次请求即在目录构建时抛错，后续重试同样失败。
3. 3 次抽卡尝试间隔约 350ms，均为客户端侧重试。

**根因定位**
- 500 是**服务端**在为新内容（1.4.57 补丁）构建抽卡目录时，被目录校验器拒绝：现行内容快照的 `gacha.json` 里 gacha 142 的 `startDate > endDate`（自相矛盾的排期）。
- 补丁包事实：`.cdn/patches/1.4.57/`，base 1.4.55 → target 1.4.57，common 差包 69MB（medium/android 为空包 112B），manifest 无 targetGachaIds 字段（与 1.4.55 包的 schema 不同）。
- apply 前 `gacha/exec` 正常（当日早些时候成功抽卡 3 次），说明 142 的坏排期随 1.4.57 内容进入。

**对初始假设的修正**
- 初始假设"客户端未重载、卡池数据未及时更新导致"不成立：500 与客户端是否重载无关——任何触发 `getGachaCatalog` 的请求都会在服务端抛错，重启客户端无效，重启服务端也无效（内容摘要已落盘，state 显示 up-to-date）。
- 真正的问题有两层：
  1. **补丁数据缺陷**：1.4.57 包携带了 gacha 142 的矛盾排期（包生成侧问题，待补丁作者验证）。
  2. **apply 无内容合法性预检**：内容热更新的 apply/reload 链路只做了版本级检查（up-to-date 短路），未运行目录级校验器（`buildGachaCatalog` 等），导致自相矛盾的内容上线并使 `gacha/exec` 全量 500。校验目前是请求时惰性触发。"通知客户端重载"链路本身这次不是故障点。

**规避/恢复路径（未执行）**
- 修复 1.4.57 包内 gacha 142 的排期（或撤包）→ 重新 apply。
- 排期规避：该卡池若属偶发池，可通过不排期/删除排期规避（用户决策）。
- 长期选项（未承诺）：apply/reload 时预运行目录校验器，坏内容拒上线。

**验证清单（补丁作者侧）**
- [ ] 确认 1.4.57 包内 `gacha.json` 的 142 条目 startDate/endDate
- [ ] 确认生成工具是否可能产出 reversed period（如时区/日期格式处理）
