const assert = require("assert")
const fs = require("fs")
const path = require("path")

const mailSource = fs.readFileSync(path.join(__dirname, "../admin/src/pages/Mail.tsx"), "utf8")

const removedTypeLabels = [
    "付费星导石",
    "Paid Vmoney",
    "星之碎片",
    "Star Crumb",
    "法力",
    "Mana",
    "经验池",
    "Exp Pool",
]

for (const label of removedTypeLabels) {
    assert(!mailSource.includes(label), `邮件附件类型不应再展示：${label}`)
}

const attachmentRequiredMessages = mailSource.match(/"请选择附件"/g) ?? []
assert.strictEqual(attachmentRequiredMessages.length, 1, "附件字段清空时只能产生一条“请选择附件”校验提示")

const typeItemMatch = mailSource.match(/<Form\.Item name="type"[\s\S]*?<\/Form\.Item>/)
assert(typeItemMatch, "应存在附件类型 Form.Item")
const typeItemSource = typeItemMatch[0]
assert(typeItemSource.includes("<Radio.Group"), "附件类型应使用可见快速选择控件")
assert(!typeItemSource.includes("<Select"), "附件类型不应继续使用下拉 Select")

console.log("admin-mail-ui-source tests passed")
