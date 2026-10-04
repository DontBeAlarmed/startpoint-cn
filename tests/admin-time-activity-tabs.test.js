const assert = require("assert")
const fs = require("fs")
const path = require("path")

const source = fs.readFileSync(path.join(__dirname, "../admin/src/pages/TimeControl.tsx"), "utf8")

// ── 卡头骨架（方案 A）：标题恒为「千里眼」，卡头分段控件切换卡池/活动 ─────
assert(source.includes("clairvoyanceTab"), "千里眼卡片应有视图状态")
assert(!source.includes("<Tabs"), "卡体不应再使用 Tabs（Tab 归位卡头，层级错乱已修复）")
assert(!source.includes("千里眼：短期 UP 角色池"), "卡头标题不应随 Tab 变化（旧动态标题已移除）")
assert(!source.includes("千里眼：活动日程"), "卡头标题不应随 Tab 变化（旧动态标题已移除）")
assert(source.includes('<span className="admin-clairvoyance-head-title">千里眼</span>'), "卡头标题应恒为「千里眼」")
assert(source.includes("<Segmented"), "卡头应使用 antd Segmented 分段控件")
assert(source.includes('label: "卡池"'), "分段控件应有卡池段")
assert(source.includes('label: "活动"'), "分段控件应有活动段")
assert(source.includes('value: "gacha"'), "分段控件应有卡池段值")
assert(source.includes('value: "activity"'), "分段控件应有活动段值")
assert(source.includes('role="toolbar"'), "卡头视图切换应具 toolbar 语义（窄屏换行仍属卡头）")

// ── 活动数据面 ───────────────────────────────────────────────────────────
assert(source.includes("/api/server/clairvoyance/activity"), "时间页应接入千里眼活动 API")
assert(source.includes('["clairvoyanceActivity"]'), "活动数据应使用独立 queryKey")
assert(source.includes("AdminActivityEvent"), "应定义活动日程行类型")
assert(source.includes("AdminActivitySearchRow"), "应定义活动搜索索引行类型")
assert(source.includes("normalizeSearch"), "活动搜索应与卡池搜索共用 normalizeSearch 模式")
assert(source.includes("activityKey"), "活动行应以 family:eventId 复合键标识")
assert(source.includes("换牌截止"), "换牌期条目应展示换牌截止")
assert(source.includes("换牌期"), "活动应有换牌期徽章")
assert(source.includes("已结束"), "活动应有已结束徽章")
assert(source.includes("admin-badge-warn"), "换牌期/已结束应使用 warn 色 token")

// ── ADD-5：卡片绝对起止 + 单段近期结构 ───────────────────────────────────
assert(source.includes("renderCompactPeriod"), "应有绝对起止紧凑格式化（YYYY-MM-DD HH:mm ~ MM-DD HH:mm）")
assert(source.includes("} ~ ${"), "紧凑起止应以 ~ 连接")
assert(source.includes("renderGachaCompactPeriod"), "池卡应显示绝对起止")
assert(source.includes("renderActivityCompactPeriod"), "活动卡应显示绝对起止")
assert(source.includes("renderGachaStartCountdown"), "预告池应显示 N 天后开始倒计时")
assert(source.includes('admin-dash-section-title">近期卡池<'), "卡池 tab 应有单段「近期卡池」")
assert(source.includes('admin-dash-section-title">近期活动<'), "活动 tab 应有单段「近期活动」")
assert(source.includes("预告"), "预告卡应有预告徽章/文案")
assert(source.includes("近七日没有进行中或预告的短期 UP 角色池"), "近期卡池空段文案")
assert(source.includes("近七日没有进行中或预告的活动"), "近期活动空段文案")
for (const deprecated of ["当前生效卡池", "七日内预告", '"进行中"段']) {
    assert(!source.includes(deprecated), `废弃段名不应残留: ${deprecated}`)
}
assert(source.includes("近期卡池 = 进行中 ∪ 未来 7 天内开始"), "近期卡池应保留合并规则注释")
assert(!source.includes("max-width: 4"), "时间页内联样式不得出现 max-width 魔法值")
assert(!/#[0-9a-fA-F]{6}\b/.test(source.replace(/^import.*$/gm, "")), "时间页不得内联 hex 色值")

// ── 卡池锚点：搜索与时间线区块零改动 ─────────────────────────────────────
const anchors = [
    'queryKey: ["clairvoyanceGacha"]',
    "/api/server/clairvoyance/gacha",
    "短期 UP 角色池追踪范围",
    "UP 角色搜索",
    "输入角色名、称号或角色 ID",
    "时间线",
    "renderRateUpCharacters(\n",
    "expandedPoolIds.has(gacha.id)",
    "admin-clairvoyance-panel",
    "renderGachaStatusBadge(gacha, gachaTimeline?.currentTime)",
    "renderGachaPeriod(gacha)",
]
for (const anchor of anchors) {
    assert(source.includes(anchor), `卡池锚点缺失: ${anchor}`)
}
// 2026-10-05 调整: 搜索上移 —— 卡池页签顺序 = UP 角色搜索 → 近期卡池 → 时间线;
// 两条「范围限定」须知沉底为页脚注(整页最底)
assert(
    source.indexOf('admin-dash-section-title">UP 角色搜索<') < source.indexOf('admin-dash-section-title">近期卡池<')
    && source.indexOf('admin-dash-section-title">近期卡池<') < source.indexOf('<div className="admin-dash-section-title">时间线</div>'),
    "卡池页签顺序应为 搜索 → 近期卡池 → 时间线",
)
assert(
    source.indexOf("短期 UP 角色池追踪范围") > source.indexOf('admin-dash-section-title">时间线<')
    && source.includes("活动日程追踪范围"),
    "两条范围须知应沉底为页脚注",
)
assert(source.includes('inputMode="numeric"'), "时间数字段应弹手机数字键盘")
// 卡池时间线改为统一单列列表（维护者指定 timeline-unified-list.html, 两线同构）
assert(source.includes("admin-tl-list"), "时间线应为统一单列列表")
assert(source.includes("renderUpCharacterChips"), "UP 角色应为芯片行(折叠上移到卡池条目层)")
assert(source.includes("TIMELINE_PAGE_SIZE = 4"), "时间线每页应显示 4 项(展开已改为分页)")
assert(source.includes("<Pagination"), "时间线应使用分页而非展开按钮")
assert(!source.includes("admin-tl-expand"), "展开按钮不应残留")
assert(source.includes("activityFamilyBadgeClass"), "活动类型应按族配色")
assert(source.includes("暂无卡池时间线"), "时间线空态文案")
assert(!source.includes("没有匹配的卡池"), "时间线不随搜索过滤(与搜索区独立)")
assert(source.includes("visibleTimelineActivities"), "活动时间线应与卡池同构")
assert(!source.includes("<Table"), "时间线区不应再使用 Table")
assert(source.indexOf("UP 角色搜索") < source.indexOf("admin-tl-list"), "单列列表应位于 UP 角色搜索栏下方")

// ── UP 角色真实头像：CDN 归档端点 + onError 首字占位回退 ─────────────────
assert(source.includes("/api/content/character_avatar/"), "UP 角色头像应接 CDN 归档端点")
assert(source.includes('loading="lazy"'), "头像图应懒加载")
assert(source.includes("admin-char-avatar-image"), "头像图应使用独立类名（铺满头像块）")
assert(source.includes("admin-char-avatar-image-broken"), "头像加载失败应加 broken 类隐藏图片")
assert(source.includes("onError="), "头像图应有 onError 回退")
assert(source.includes("character.name.slice(0, 1)"), "首字占位应保留为加载失败回退层")
assert(!/max-width: \d/.test(source), "头像改造不得引入 max-width 魔法值")

console.log("admin-time-activity-tabs tests passed")
