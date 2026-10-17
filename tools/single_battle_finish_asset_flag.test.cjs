"use strict"

// 结算兜底 asset_update：finish 响应头按 res_ver 与内容目标版本对比置位
// （客户端 QuestResultScene 弹 214 → 回标题 → 重走资产检查；见文档 C2）。
// 判定函数 shouldFlagSettlementAssetUpdate 的语义矩阵也在此全量覆盖。

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "single-finish-asset-flag-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { shouldFlagSettlementAssetUpdate } = require("../src/content/cdn/asset-mode")
const { parseAssetProviderConfig } = require("../src/content/cdn/asset-mode")
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default

const serverCdnProvider = parseAssetProviderConfig({ env: {}, projectRoot: path.resolve(__dirname, "..") })
assert.equal(serverCdnProvider.mode, "local", "默认资产模式为 local（版本对比语义与 server-cdn 相同）")
const clientOwnedProvider = parseAssetProviderConfig({ env: { ASSET_MODE: "client-owned" } })
const SNAPSHOT_TARGET = "9.9.9"

test("shouldFlagSettlementAssetUpdate 判定矩阵", () => {
    // client-owned 一律不置位
    assert.equal(shouldFlagSettlementAssetUpdate(clientOwnedProvider, "1.0.0", SNAPSHOT_TARGET), false)
    assert.equal(shouldFlagSettlementAssetUpdate(clientOwnedProvider, undefined, SNAPSHOT_TARGET), false)
    // server-cdn：有效版本且不同 → 置位
    assert.equal(shouldFlagSettlementAssetUpdate(serverCdnProvider, "9.9.8", SNAPSHOT_TARGET), true)
    // server-cdn：版本一致 → 不置位（避免结算→标题→无可下→再结算的打断循环）
    assert.equal(shouldFlagSettlementAssetUpdate(serverCdnProvider, SNAPSHOT_TARGET, SNAPSHOT_TARGET), false)
    // server-cdn：缺失/非法版本 → 不置位（宁可漏报不可误报）
    assert.equal(shouldFlagSettlementAssetUpdate(serverCdnProvider, undefined, SNAPSHOT_TARGET), false)
    assert.equal(shouldFlagSettlementAssetUpdate(serverCdnProvider, "garbage", SNAPSHOT_TARGET), false)
    // 目标版本缺失（精简测试夹具等）→ 不置位
    assert.equal(shouldFlagSettlementAssetUpdate(serverCdnProvider, "9.9.8", undefined), false)
})

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    const contentType = String(response.headers["content-type"] ?? "")
    if (contentType.includes("json")) return JSON.parse(response.body)
    return unpack(Buffer.from(response.body, "base64"))
}

async function buildApp() {
    const fastify = Fastify()
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await fastify.register(singleBattleRoutes, {
        prefix: "/api/index.php/single_battle_quest",
        assetProvider: serverCdnProvider,
        getSnapshotTargetVersion: () => SNAPSHOT_TARGET,
    })
    await fastify.ready()
    return fastify
}

async function runStartFinishPrepared(fastify, viewerId, playId) {
    const start = await fastify.inject({
        method: "POST",
        url: "/api/index.php/single_battle_quest/start",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({
            viewer_id: viewerId,
            api_count: 1,
            quest_id: 2001,
            category: 22,
            party_id: 1,
            use_boost_point: false,
            use_boss_boost_point: false,
            is_auto_start_mode: false,
            play_id: playId,
        }),
    })
    assert.equal(start.statusCode, 200, start.body)
}

async function injectFinish(fastify, viewerId, { play_id, res_ver }) {
    return fastify.inject({
        method: "POST",
        url: "/api/index.php/single_battle_quest/finish",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...(res_ver === undefined ? {} : { "res_ver": res_ver }),
        },
        payload: encodeRequest({
            viewer_id: viewerId,
            api_count: 1,
            play_id,
            quest_id: 2001,
            category: 22,
            score: 0,
            elapsed_time_ms: 1000,
            add_mana: 0,
            is_accomplished: true,
            is_restored: false,
            continue_count: 0,
            statistics: {
                clear_phase: 1,
                max_combo_count: 0,
                max_power: 3000,
                zones: [{ use_power_flip_count: 100, use_dash_count: 5 }],
                party: {
                    deck: { leader: 1, members: [1, 111001, 111002, 111003, 111004] },
                    equipments: [
                        { id: 1, enhancement_level: 0 },
                        { id: 2, enhancement_level: 0 },
                        { id: 3, enhancement_level: 0 },
                        { id: 4, enhancement_level: 0 },
                        { id: 5, enhancement_level: 0 },
                        { id: 6, enhancement_level: 0 },
                    ],
                    characters: [
                        { id: 1, level: 80, ascension: 0, hp: 1000, attack: 100 },
                        { id: 111001, level: 60, ascension: 0, hp: 1000, attack: 100 },
                        { id: 111002, level: 60, ascension: 0, hp: 1000, attack: 100 },
                        { id: 111003, level: 60, ascension: 0, hp: 1000, attack: 100 },
                        { id: 111004, level: 60, ascension: 0, hp: 1000, attack: 100 },
                        { id: 111005, level: 60, ascension: 0, hp: 1000, attack: 100 },
                    ],
                    unison_characters: [],
                    ability_soul_ids: [],
                },
            },
        }),
    })
}

test("finish 响应头按 res_ver 对比置位 asset_update", async t => {
    initializeDatabase()
    const db = getDb()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `single-finish-asset-flag-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 800000321
    db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
    updatePlayerSync({ id: playerId, stamina: 100, totalStaminaUsed: 0, totalDashes: 0 })

    const fastify = await buildApp()
    t.after(() => fastify.close())

    // 真实开局后用错 play_id → 迟到终态同样带 asset_update（版本落后 → 置位）
    await runStartFinishPrepared(fastify, viewerId, "asset-flag-behind")
    const stale = await injectFinish(fastify, viewerId, {
        play_id: "asset-flag-stale",
        res_ver: "9.9.8",
    })
    assert.equal(stale.statusCode, 200, stale.body)
    const staleBody = decodeResponse(stale)
    assert.equal(staleBody.data_headers.asset_update, true, "迟到终态在版本落后时必须置位")

    // 正常结算：版本落后 → 置位
    const behind = decodeResponse(await injectFinish(fastify, viewerId, {
        play_id: "asset-flag-behind",
        res_ver: "9.9.8",
    }))
    assert.equal(behind.data_headers.asset_update, true, "res_ver 落后于目标版本必须置位")

    // 正常结算：缺失 res_ver → 不置位（宁可漏报不可误报）
    await runStartFinishPrepared(fastify, viewerId, "asset-flag-noheader")
    const noHeader = decodeResponse(await injectFinish(fastify, viewerId, {
        play_id: "asset-flag-noheader",
        res_ver: undefined,
    }))
    assert.equal(noHeader.data_headers.asset_update, false, "缺失 res_ver 不得置位")

    // 正常结算：版本一致 → 不置位（不制造结算→标题打断循环）
    await runStartFinishPrepared(fastify, viewerId, "asset-flag-current")
    const current = decodeResponse(await injectFinish(fastify, viewerId, {
        play_id: "asset-flag-current",
        res_ver: SNAPSHOT_TARGET,
    }))
    assert.equal(current.data_headers.asset_update, false, "res_ver 与目标一致不得置位")
})
