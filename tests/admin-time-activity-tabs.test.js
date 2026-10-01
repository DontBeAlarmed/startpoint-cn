const assert = require("assert")
const fs = require("fs")
const path = require("path")

const source = fs.readFileSync(path.join(__dirname, "../admin/src/pages/TimeControl.tsx"), "utf8")

// ── 页签骨架：千里眼卡片区域 Tab 切换 ─────────────────────────────────────
assert(source.includes("clairvoyanceTab"), "千里眼卡片应有页签状态")
assert(source.includes("<Tabs"), "千里眼卡片应使用 Tabs 组件切换卡池/活动")
assert(source.includes('key: "gacha"'), "应保留卡池页签")
assert(source.includes('key: "activity"'), "应有活动页签")
assert(source.includes('label: "卡池"'), "卡池页签文案")
assert(source.includes('label: "活动"'), "活动页签文案")
assert(source.includes('"千里眼：短期 UP 角色池"'), "卡池页签标题")
assert(source.includes('"千里眼：活动日程"'), "活动页签标题")

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
    "当前阶段只追踪短期 UP 角色池",
    "UP 角色搜索",
    "输入角色名、称号或角色 ID",
    "时间线",
    "renderRateUpCharacters(row.rateUpCharacters)",
    "admin-clairvoyance-panel",
    "renderGachaStatusBadge(gacha, gachaTimeline?.currentTime)",
    "renderGachaPeriod(gacha)",
]
for (const anchor of anchors) {
    assert(source.includes(anchor), `卡池锚点缺失: ${anchor}`)
}
// 卡池三段结构的原始顺序：近期卡池 → UP 角色搜索 → 时间线
assert(
    source.indexOf('admin-dash-section-title">近期卡池<') < source.indexOf("UP 角色搜索")
    && source.indexOf("UP 角色搜索") < source.indexOf('<div className="admin-dash-section-title">时间线</div>'),
    "卡池页签内部结构应保持原顺序",
)
// 卡池时间线的三元组（卡池/上线 / 下线/UP 角色）原样保留
assert(source.includes('{ title: "卡池", dataIndex: "name"'), "卡池时间线第一列原样保留")
assert(source.includes('title: "上线 / 下线"'), "卡池时间线第二列原样保留")
assert(source.includes('{ title: "UP 角色", render: (_: unknown, row) => renderRateUpCharacters(row.rateUpCharacters) }'), "卡池时间线第三列原样保留")

console.log("admin-time-activity-tabs tests passed")
