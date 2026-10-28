"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
test.after(() => restoreContentSnapshot())

const databaseDirectory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "follow-domain-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    addLocalFollowSync,
    bulkEditLocalFollowsSync,
    countLocalFollowersSync,
    deleteLocalFollowSync,
    getLocalFollowRelationSync,
    listLocalFollowTargetsSync,
    listLocalFollowerSourcesSync,
} = require("../src/data/domains/follow")
const { getSocialCapacityPolicySync } = require("../src/lib/config-content")

function freshPlayer(tag) {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `follow-domain-${tag}-${Math.random().toString(36).slice(2)}`, status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

test.before(() => { data.initializeDatabase() })

test.after(() => {
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("social capacity policy reads follow limits from content config", () => {
    const policy = getSocialCapacityPolicySync()
    // config_iosbundled 官方真值（2f6b6075 对齐）：300 / 1500 / 100
    assert.equal(policy.maxFollows, 300)
    assert.equal(policy.maxFollowers, 1500)
    assert.equal(policy.maxDisplayFollowers, 100)
})

test("relation state derives from both edge directions with per-edge times", () => {
    const a = freshPlayer("state-a")
    const b = freshPlayer("state-b")
    assert.deepEqual(getLocalFollowRelationSync(a, b), {
        state: 0, followTime: null, followedTime: null,
    })

    addLocalFollowSync({ sourcePlayerId: a, targetPlayerId: b, followedAtMs: 1_000 })
    // 2 = 我→对方单向
    assert.deepEqual(getLocalFollowRelationSync(a, b), {
        state: 2, followTime: 1_000, followedTime: null,
    })
    // 3 = 对方→我单向
    assert.deepEqual(getLocalFollowRelationSync(b, a), {
        state: 3, followTime: null, followedTime: 1_000,
    })

    addLocalFollowSync({ sourcePlayerId: b, targetPlayerId: a, followedAtMs: 2_000 })
    // 1 = 互关；两个时间字段来自各自方向边
    assert.deepEqual(getLocalFollowRelationSync(a, b), {
        state: 1, followTime: 1_000, followedTime: 2_000,
    })
    assert.deepEqual(getLocalFollowRelationSync(b, a), {
        state: 1, followTime: 2_000, followedTime: 1_000,
    })
})

test("add validates self, missing target and capacity limits from config", () => {
    const a = freshPlayer("add-a")
    assert.equal(
        addLocalFollowSync({ sourcePlayerId: a, targetPlayerId: a, followedAtMs: 1 }).reason,
        "self",
    )
    assert.equal(
        addLocalFollowSync({ sourcePlayerId: a, targetPlayerId: 999_999, followedAtMs: 1 }).reason,
        "missing_target",
    )

    const { maxFollows, maxFollowers } = getSocialCapacityPolicySync()
    assert.equal(maxFollows, 300)
    assert.equal(maxFollowers, 1500)

    // 官方上限是 300/1500：完整默认玩家初始化（missions/box gacha 等）单个
    // ~60ms，1800 个会超组内 120s 每测试上限。容量语义只需要"玩家行存在"，
    // 用模板玩家 + SQL 行克隆（账户走轻量 insertAccountSync）铺量。
    const { getDb } = require("../src/data/db")
    const db = getDb()
    const cloneColumns = db.prepare("PRAGMA table_info(players)").all()
        .map(column => column.name)
        .filter(name => name !== "id" && name !== "account_id" && name !== "name")
    const clonePlayer = db.prepare(`
        INSERT INTO players (id, account_id, name, ${cloneColumns.join(", ")})
        SELECT ?, ?, ?, ${cloneColumns.join(", ")} FROM players WHERE id = ?
    `)
    const { insertAccountSync } = require("../src/data/domains/account")
    function makeLightPlayers(templateId, tag, count) {
        return db.transaction(() => {
            const ids = []
            for (let index = 0; index < count; index += 1) {
                const accountId = insertAccountSync({
                    appId: "wf_cn",
                    idpAlias: "",
                    idpCode: "test",
                    idpId: `${tag}-${index}-${Math.random()}`,
                    status: "normal",
                }).id
                const info = clonePlayer.run(
                    800_000_000 + Math.floor(Math.random() * 99_999_999),
                    accountId,
                    `${tag}-${index}`,
                    templateId,
                )
                ids.push(Number(info.lastInsertRowid))
            }
            return ids
        })()
    }

    // 关注上限：关注满 maxFollows 人后再关注 → source_limit
    const targets = makeLightPlayers(a, "add-t", maxFollows)
    for (const target of targets) {
        assert.equal(
            addLocalFollowSync({ sourcePlayerId: a, targetPlayerId: target, followedAtMs: 1 }).ok,
            true,
        )
    }
    const extra = freshPlayer("add-extra")
    assert.deepEqual(
        addLocalFollowSync({ sourcePlayerId: a, targetPlayerId: extra, followedAtMs: 1 }),
        { ok: false, reason: "source_limit" },
    )

    // 目标被关注上限：maxFollowers 名粉丝后再关注 → target_limit
    const star = freshPlayer("add-star")
    const fans = makeLightPlayers(star, "add-fan", maxFollowers)
    for (const fan of fans) {
        assert.equal(addLocalFollowSync({
            sourcePlayerId: fan, targetPlayerId: star, followedAtMs: 1,
        }).ok, true)
    }
    const lateFan = freshPlayer("add-late-fan")
    assert.deepEqual(
        addLocalFollowSync({ sourcePlayerId: lateFan, targetPlayerId: star, followedAtMs: 1 }),
        { ok: false, reason: "target_limit" },
    )
})

test("add is idempotent and delete/delete_followed tolerate missing edges", () => {
    const a = freshPlayer("idem-a")
    const b = freshPlayer("idem-b")
    assert.deepEqual(
        addLocalFollowSync({ sourcePlayerId: a, targetPlayerId: b, followedAtMs: 5 }),
        { ok: true, changed: true },
    )
    assert.deepEqual(
        addLocalFollowSync({ sourcePlayerId: a, targetPlayerId: b, followedAtMs: 9 }),
        { ok: true, changed: false },
    )
    assert.equal(getLocalFollowRelationSync(a, b).followTime, 5, "重复 add 不改时间")

    assert.equal(deleteLocalFollowSync({ sourcePlayerId: a, targetPlayerId: b }), true)
    assert.equal(deleteLocalFollowSync({ sourcePlayerId: a, targetPlayerId: b }), false)
    assert.equal(getLocalFollowRelationSync(a, b).state, 0)
})

test("bulk edit applies adds and deletes atomically", () => {
    const a = freshPlayer("bulk-a")
    const keep = freshPlayer("bulk-keep")
    const drop = freshPlayer("bulk-drop")
    const add = freshPlayer("bulk-add")
    addLocalFollowSync({ sourcePlayerId: a, targetPlayerId: keep, followedAtMs: 1 })
    addLocalFollowSync({ sourcePlayerId: a, targetPlayerId: drop, followedAtMs: 1 })

    const result = bulkEditLocalFollowsSync({
        sourcePlayerId: a,
        addTargetPlayerIds: [add],
        deleteTargetPlayerIds: [drop],
        followedAtMs: 7,
    })
    assert.equal(result.ok, true)
    assert.equal(getLocalFollowRelationSync(a, keep).state, 2)
    assert.equal(getLocalFollowRelationSync(a, drop).state, 0)
    assert.deepEqual(getLocalFollowRelationSync(a, add), {
        state: 2, followTime: 7, followedTime: null,
    })

    // 失败回滚：bulk 中任一 add 超限 → 全部不写入
    const { maxFollows } = getSocialCapacityPolicySync()
    const fillers = Array.from({ length: maxFollows - 1 }, (_, index) => freshPlayer(`bulk-f${index}`))
    for (const filler of fillers) {
        addLocalFollowSync({ sourcePlayerId: a, targetPlayerId: filler, followedAtMs: 1 })
    }
    const overflowA = freshPlayer("bulk-over-a")
    const overflowB = freshPlayer("bulk-over-b")
    assert.equal(bulkEditLocalFollowsSync({
        sourcePlayerId: a,
        addTargetPlayerIds: [overflowA, overflowB],
        deleteTargetPlayerIds: [],
        followedAtMs: 9,
    }).reason, "source_limit")
    assert.equal(getLocalFollowRelationSync(a, overflowA).state, 0, "bulk 失败不得部分写入")
    assert.equal(getLocalFollowRelationSync(a, overflowB).state, 0)
})

test("bulk edit rolls back earlier deletes and adds when a later add fails", () => {
    const source = freshPlayer("bulk-rollback-source")
    const original = freshPlayer("bulk-rollback-original")
    const firstAdd = freshPlayer("bulk-rollback-first-add")
    const secondAdd = freshPlayer("bulk-rollback-second-add")
    addLocalFollowSync({ sourcePlayerId: source, targetPlayerId: original, followedAtMs: 1 })

    const { maxFollows } = getSocialCapacityPolicySync()
    const fillers = Array.from({ length: maxFollows - 1 }, (_, index) => (
        freshPlayer(`bulk-rollback-filler${index}`)
    ))
    for (const filler of fillers) {
        addLocalFollowSync({ sourcePlayerId: source, targetPlayerId: filler, followedAtMs: 2 })
    }

    const result = bulkEditLocalFollowsSync({
        sourcePlayerId: source,
        addTargetPlayerIds: [firstAdd, secondAdd],
        deleteTargetPlayerIds: [original],
        followedAtMs: 3,
    })
    assert.deepEqual(result, { ok: false, reason: "source_limit" })
    assert.equal(getLocalFollowRelationSync(source, original).state, 2)
    assert.equal(getLocalFollowRelationSync(source, firstAdd).state, 0)
    assert.equal(getLocalFollowRelationSync(source, secondAdd).state, 0)
})

test("list queries return per-direction members and follower counts", () => {
    const center = freshPlayer("list-center")
    const outgoing = freshPlayer("list-out")
    const incoming = freshPlayer("list-in")
    const mutual = freshPlayer("list-mutual")
    const unrelated = freshPlayer("list-none")
    addLocalFollowSync({ sourcePlayerId: center, targetPlayerId: outgoing, followedAtMs: 1 })
    addLocalFollowSync({ sourcePlayerId: center, targetPlayerId: mutual, followedAtMs: 2 })
    addLocalFollowSync({ sourcePlayerId: incoming, targetPlayerId: center, followedAtMs: 3 })
    addLocalFollowSync({ sourcePlayerId: mutual, targetPlayerId: center, followedAtMs: 4 })

    assert.deepEqual(
        listLocalFollowTargetsSync(center).sort((x, y) => x - y),
        [outgoing, mutual].sort((x, y) => x - y),
    )
    // 粉丝列表按被关注时间降序：mutual(4) 在 incoming(3) 之前
    assert.deepEqual(listLocalFollowerSourcesSync(center), [mutual, incoming])
    assert.equal(countLocalFollowersSync(center), 2)
    assert.equal(listLocalFollowTargetsSync(unrelated).length, 0)
    // 事务内一致性由 better-sqlite3 保证；直查表行数做最终事实断言
    assert.equal(
        getDb().prepare(`SELECT COUNT(*) AS n FROM players_follows WHERE follower_player_id = ?`).get(center).n,
        2,
    )
})

test("follows stay out of player-save table registry", () => {
    const { PLAYER_SAVE_TABLES, PLAYER_SAVE_EXCLUDED_TABLES } = require("../src/data/player-save/registry")
    const saveTables = PLAYER_SAVE_TABLES.map(table => table.name)
    assert.equal(saveTables.includes("players_follows"), false)
    assert.equal(PLAYER_SAVE_EXCLUDED_TABLES.some(table => table.name === "players_follows"), true)
})
