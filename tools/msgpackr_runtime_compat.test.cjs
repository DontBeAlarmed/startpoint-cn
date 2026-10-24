"use strict";

// msgpackr × Node 运行时兼容金丝雀（R-G03 后续硬化）。
// 背景：msgpackr 1.11.0 在 Node 24 下对 ≥64 个 UTF-16 字符的字符串走
// encodeUtf8 长串路径，Buffer.utf8Write 内部行为变化导致
// ERR_BUFFER_OUT_OF_BOUNDS——mail/index 500 的根因（2026-10-23）。
// 本测试钉住：任何 node/msgpackr 组合下，短串、阈值两侧、长串、CJK、
// 单独代理项避免、对象载荷都必须可编码且往返一致。升级 node 或
// msgpackr 后本测试红 = 编码层不兼容，先于任何业务端点暴露。

const assert = require("node:assert/strict")
const test = require("node:test")
const { pack, unpack } = require("msgpackr")

test("msgpackr encodes strings across the 64-char threshold boundary (runtime canary)", () => {
    for (const length of [1, 32, 63, 64, 65, 100, 5000]) {
        const value = "a".repeat(length)
        const encoded = pack(value)
        assert.equal(unpack(encoded), value, `ASCII ×${length} 必须可编码且往返一致`)
    }
})

test("msgpackr encodes long CJK and mixed-script strings (runtime canary)", () => {
    for (const value of [
        "字".repeat(64),
        "邮件主题".repeat(30),
        "混mix合123".repeat(20),
    ]) {
        assert.equal(unpack(pack(value)), value)
    }
})

test("msgpackr encodes object payloads carrying long strings (runtime canary)", () => {
    const payload = {
        subject: "x".repeat(200),
        body: "正文".repeat(100),
        list: [1, 2, 3],
        nested: { deep: "y".repeat(64) },
    }
    assert.deepEqual(unpack(pack(payload)), payload)
})
