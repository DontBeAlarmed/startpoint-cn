const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")

function readSource(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
}

test("礼包业务未实现时 load 与能力检查都关闭入口", () => {
    const loadSource = readSource("src/routes/cn/load.ts")
    const serverSource = readSource("src/cn-server.ts")
    const giftCapabilityRoute = serverSource.match(
        /fastify\.post\(`\$\{apiPrefix\}\/tool\/check_enable_gift`[\s\S]*?\n\}\);/,
    )

    assert.match(loadSource, /d\.enable_gift\s*=\s*false/)
    assert.ok(giftCapabilityRoute, "应注册礼包能力检查路由")
    assert.match(giftCapabilityRoute[0], /enable_gift:\s*false/)
})
