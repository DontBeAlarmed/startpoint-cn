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

console.log("admin-mail-ui-source tests passed")
