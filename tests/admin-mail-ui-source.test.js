const assert = require("assert")
const fs = require("fs")
const path = require("path")

const mailSource = fs.readFileSync(path.join(__dirname, "../admin/src/pages/Mail.tsx"), "utf8")

const removedTypeLabels = [
    "付费星导石",
    "Paid Vmoney",
    "Star Crumb",
    "法力",
    "Mana",
    "经验池",
    "Exp Pool",
    "Boss Boost 点",
    "Boost 点",
    "Rank 点",
]

for (const label of removedTypeLabels) {
    assert(!mailSource.includes(label), `邮件附件类型不应再展示：${label}`)
}

const starCrumbTypeMatch = mailSource.match(/\{\s*value:\s*7,\s*label:\s*"星之碎片"([^}]*)\}/)
assert(starCrumbTypeMatch, "邮件附件类型应展示 value 7：星之碎片")
assert(!starCrumbTypeMatch[1].includes("needsId"), "星之碎片不应要求 type_id")
const mailTypesBlock = mailSource.match(/const MAIL_TYPES = \[([\s\S]*?)\n\]/)
assert(mailTypesBlock, "应存在邮件附件类型矩阵")
assert.deepEqual(
    mailTypesBlock[1].split("\n").map(line => line.trim()).filter(Boolean),
    [
        `{ value: 1, label: "道具", needsId: true },`,
        `{ value: 4, label: "免费星导石" },`,
        `{ value: 5, label: "角色", needsId: true, singleOnly: true },`,
        `{ value: 6, label: "装备", needsId: true, singleOnly: true },`,
        `{ value: 7, label: "星之碎片" },`,
        `{ value: 8, label: "玛纳" },`,
        `{ value: 9, label: "经验值" },`,
        `{ value: 10, label: "羁绊之证" },`,
    ],
    "邮件附件类型矩阵应精确匹配受支持的新建类型",
)
assert.match(
    mailSource,
    /type_id:\s*requiresTypeId\(v\.type\)\s*&&\s*v\.type_id\s*!=\s*null\s*\?\s*String\(v\.type_id\)\s*:\s*undefined/,
    "不需要附件 ID 的邮件类型不应提交 type_id",
)
assert.match(
    mailSource,
    /apiGet<Record<string, number>>\("\/api\/lookup\/item-max-counts"\)/,
    "邮件页应读取 Content Snapshot 的官方道具持有上限",
)
assert.match(
    mailSource,
    /getMailAttachmentRule\(type, typeId, itemMaxCounts\?\.\[String\(typeId\)\]\)/,
    "道具数量控件应使用所选道具的官方持有上限",
)

const attachmentRequiredMessages = mailSource.match(/"请选择附件"/g) ?? []
assert.strictEqual(attachmentRequiredMessages.length, 1, "附件字段清空时只能产生一条“请选择附件”校验提示")

const typeItemMatch = mailSource.match(/<Form\.Item name="type"[\s\S]*?<\/Form\.Item>/)
assert(typeItemMatch, "应存在附件类型 Form.Item")
const typeItemSource = typeItemMatch[0]
assert(typeItemSource.includes("<Radio.Group"), "附件类型应使用可见快速选择控件")
assert(!typeItemSource.includes("<Select"), "附件类型不应继续使用下拉 Select")

// 有效期视口拆分(2026-10-05 五轮跷跷板修复): 移动端独占一整行居右(发送按钮上方),
// 768px+ 恢复行内 预览|有效期|发送。DOM 只有一份, 视口差异只允许存在于这对 CSS 里。
const mailCss = fs.readFileSync(path.join(__dirname, "../admin/src/styles/pages/mail.css"), "utf8")

const sendRowMatch = mailCss.match(/\.mail-send-row\s*\{([^}]*)\}/)
assert(sendRowMatch, "mail.css 应存在 .mail-send-row 规则")
assert(sendRowMatch[1].includes("flex-wrap: wrap"), "发送行必须允许换行(有效期独占行依赖 flex-wrap)")

const expiryBaseMatch = mailCss.match(/\.mail-send-expiry\s*\{([^}]*)\}/)
assert(expiryBaseMatch, "mail.css 应存在 .mail-send-expiry 基础规则")
assert(expiryBaseMatch[1].includes("flex: 0 0 100%"), "移动端有效期必须 flex-basis 100% 确定性独占一行(不随内容宽度变化)")
assert(expiryBaseMatch[1].includes("justify-content: flex-end"), "移动端有效期组内容应居右")
assert(expiryBaseMatch[1].includes("order: -1"), "移动端有效期行必须排在预览/发送行之前(发送按钮上方)")
assert(!expiryBaseMatch[1].includes("margin-left"), "移动端有效期不得带桌面左边距(100% 行宽 + margin 会溢出)")

const expiryDesktopMatch = mailCss.match(
    /@media \(min-width: 768px\)\s*\{\s*\.mail-send-expiry\s*\{([^}]*)\}/,
)
assert(expiryDesktopMatch, "768px+ 必须有 .mail-send-expiry 桌面覆盖(恢复行内)")
assert(expiryDesktopMatch[1].includes("flex: 0 0 auto"), "桌面有效期应恢复 auto 宽度(行内排列)")
assert(expiryDesktopMatch[1].includes("order: 0"), "桌面有效期应恢复 DOM 顺序(预览|有效期|发送)")
assert(expiryDesktopMatch[1].includes("margin-left: 12px"), "桌面有效期与预览之间应保留 12px 间距")

console.log("admin-mail-ui-source tests passed")
