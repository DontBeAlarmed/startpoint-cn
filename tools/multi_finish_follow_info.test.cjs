"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

const { buildFinishFollowInfo } = require("../src/lib/quest/finish/follow-info")

async function main() {
    const warnings = []
    const result = await buildFinishFollowInfo(
        800000001,
        [{ viewer_id: 800000002 }, { viewer_id: 800000003 }],
        [800000002, 900000001],
        async viewerId => {
            if (viewerId === 800000002) throw new Error("injected lookup failure")
            return {
                player: {
                    name: "正常队友",
                    rankPoint: 100,
                    role: 1,
                    degreeId: 2,
                },
            }
        },
        message => warnings.push(message),
    )

    assert.deepEqual(result.map(entry => entry.viewer_id), [800000003])
    assert.equal(result[0].name, "正常队友")
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /800000002/)
}

main().then(
    () => console.log("multi finish follow info tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
