require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const zlib = require("node:zlib")
const { decodeAmf3, decodeAmf3Deflate } = require("../src/content/sync/amf3")

const stringBytes = Buffer.from([
    0x09, 0x03, 0x01,
    0x06, 0x0b, 0x68, 0x65, 0x6c, 0x6c, 0x6f,
])
assert.deepEqual(decodeAmf3(stringBytes), ["hello"])
assert.deepEqual(decodeAmf3Deflate(zlib.deflateSync(stringBytes)), ["hello"])
assert.throws(() => decodeAmf3(Buffer.concat([stringBytes, Buffer.from([0x01])])), /trailing bytes/i)

console.log("content AMF3 tests passed")
