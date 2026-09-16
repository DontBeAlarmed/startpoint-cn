"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
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

async function runAll() {
    await main()
    await relationsMain()
}

runAll().then(
    () => {
        console.log("multi finish follow info tests passed")
    },
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
process.once("exit", () => restoreContentSnapshot())

// ---- F5: settlement follow_info carries real same-node relations ----

async function relationsMain() {
    const relations = new Map()
    const rel = (a, b) => relations.get(`${a}:${b}`) ?? { state: 0, followTime: null, followedTime: null }
    const resolver = async viewerId => ({
        playerId: viewerId - 800000000,
        player: { name: `P${viewerId}`, rankPoint: 0, role: 1, degreeId: 1 },
    })

    relations.set("1:2", { state: 2, followTime: 5_000, followedTime: null })
    relations.set("1:3", { state: 1, followTime: 5_000, followedTime: 9_000 })
    const result = await buildFinishFollowInfo(
        800000001,
        [{ viewer_id: 800000002 }, { viewer_id: 800000003 }, { viewer_id: 900000001 }],
        [],
        resolver,
        () => {},
        { requesterPlayerId: 1, getRelation: rel },
    )

    assert.deepEqual(result.map(entry => entry.follow_state), [2, 1])
    assert.equal(result[0].follow_time, 5)
    assert.equal(result[0].followed_time, null)
    assert.equal(result[1].followed_time, 9, "互关时 followed_time 来自入边")
    // NPC(>=900000000) 不进入 Follow 目标
    assert.equal(result.some(entry => entry.viewer_id >= 900000000), false)

    // 未注入关系解析器时保持 0/null（诚实占位，不继承房间兼容值）
    const fallback = await buildFinishFollowInfo(
        800000001,
        [{ viewer_id: 800000002 }],
        [],
        resolver,
    )
    assert.equal(fallback[0].follow_state, 0)
    assert.equal(fallback[0].follow_time, null)
}

relationsMain().then(
    () => console.log("settlement follow relation tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
