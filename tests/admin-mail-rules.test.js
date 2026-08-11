require("ts-node/register/transpile-only")

const assert = require("assert")

const {
    getMailAttachmentRule,
    mailTypeNeedsTypeId,
    parseAdminMailInteger,
    validateMailAttachment,
} = require("../src/lib/admin-mail-rules")

function expectOk(result) {
    assert.strictEqual(result.ok, true, result.error)
}

function expectError(result, text) {
    assert.strictEqual(result.ok, false)
    assert.match(result.error, text)
}

expectOk(parseAdminMailInteger("100", "数量", { min: 1, max: 999 }))
expectError(parseAdminMailInteger("100x", "数量", { min: 1, max: 999 }), /整数/)
expectError(parseAdminMailInteger("1000", "数量", { min: 1, max: 999 }), /1-999/)

assert.strictEqual(getMailAttachmentRule(1, 10001).max, 999)
assert.strictEqual(getMailAttachmentRule(1, 100000).max, 99999)
assert.strictEqual(getMailAttachmentRule(1, 2370001).max, 999999)
assert.strictEqual(getMailAttachmentRule(5, 5010001).max, 1)
assert.strictEqual(getMailAttachmentRule(6, 3010006).max, 1)
assert.strictEqual(mailTypeNeedsTypeId(7), false)

expectOk(validateMailAttachment({ mailType: 1, typeId: 10001, count: 999 }))
expectOk(validateMailAttachment({ mailType: 7, typeId: null, count: 100 }))
expectError(validateMailAttachment({ mailType: 1, typeId: 10001, count: 1000 }), /最多 999/)
expectError(validateMailAttachment({ mailType: 5, typeId: 5010001, count: 2 }), /只能发送 1/)
expectError(validateMailAttachment({ mailType: 7, typeId: 10001, count: 1 }), /不需要附件 ID/)
expectError(validateMailAttachment({ mailType: 8, typeId: 10001, count: 1 }), /不需要附件 ID/)

console.log("admin-mail-rules tests passed")
