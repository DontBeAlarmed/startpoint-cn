require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const previousDataDirectory = process.env.DATA_DIR
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gift-lifecycle-"))
process.env.DATA_DIR = path.join(dataDirectory, "data")

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const {
    createGiftSync,
    updateStoppedGiftSync,
    startGiftSync,
    stopGiftSync,
    deleteStoppedGiftSync,
    listGiftsSync,
    getGiftSync,
    getGiftByExactCodeSync,
} = require("../src/data/domains/gift")
const { isGiftCodeEnabledSync } = require("../src/lib/gift-code/capability")
const {
    GiftDraftValidationError,
    GiftCodeValidationError,
    GiftRewardValidationError,
    validateGiftDraft,
    GIFT_TO_REWARD_TYPE,
    validateGiftCode,
    validateGiftRewards,
} = require("../src/lib/gift-code/validation")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { RewardType } = require("../src/lib/types/rewards")

test.after(() => {
    data.closeDatabase()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

const itemReward = { position: 0, type: 1, typeId: 1, number: 1 }
const beadsReward = { position: 1, type: 4, typeId: null, number: 10 }
const characterReward = { position: 2, type: 5, typeId: 1, number: 1 }
const equipmentReward = { position: 3, type: 6, typeId: 100001, number: 1 }
const manaReward = { position: 4, type: 8, typeId: null, number: 1000 }
const expReward = { position: 5, type: 9, typeId: null, number: 1000 }
const allRewards = [
    itemReward,
    beadsReward,
    characterReward,
    equipmentReward,
    manaReward,
    expReward,
]

function createDraft(code) {
    return { code, note: null, rewards: [{ ...itemReward }] }
}

test("validates exact UTF-16 gift codes without changing them", () => {
    assert.doesNotThrow(() => validateGiftCode(" spaced key "))
    assert.doesNotThrow(() => validateGiftCode("é中文😀"))
    assert.doesNotThrow(() => validateGiftCode("x".repeat(20)))
    assert.throws(() => validateGiftCode(""), GiftCodeValidationError)
    assert.throws(() => validateGiftCode("x".repeat(21)), GiftCodeValidationError)
    assert.throws(() => validateGiftCode("a\nb"), GiftCodeValidationError)
    assert.throws(() => validateGiftCode("a\rb"), GiftCodeValidationError)
    assert.throws(() => validateGiftCode(21), GiftCodeValidationError)
})

test("validates exact gift drafts and protects normalized results", () => {
    const validDraft = {
        code: " padded exact ",
        note: "n".repeat(512),
        rewards: [{ ...itemReward }],
    }
    const draft = validateGiftDraft(validDraft)
    assert.deepEqual(draft, validDraft)
    assert.equal(draft.code, " padded exact ")
    assert.equal(Object.isFrozen(draft), true)
    assert.equal(Object.isFrozen(draft.rewards), true)
    assert.equal(Object.isFrozen(draft.rewards[0]), true)
    assert.throws(() => { "use strict"; draft.note = "changed" }, TypeError)

    validDraft.note = "input changed"
    validDraft.rewards[0].number = 999
    assert.equal(draft.note, "n".repeat(512))
    assert.equal(draft.rewards[0].number, 1)

    const extraTopLevel = { ...validDraft, extra: true }
    assert.throws(() => validateGiftDraft(extraTopLevel), GiftDraftValidationError)
    const missingNote = { code: validDraft.code, rewards: validDraft.rewards }
    assert.throws(() => validateGiftDraft(missingNote), GiftDraftValidationError)
    assert.throws(() => validateGiftDraft(null), GiftDraftValidationError)
    assert.throws(() => validateGiftDraft([validDraft]), GiftDraftValidationError)

    assert.throws(
        () => validateGiftDraft({ ...validDraft, note: "n".repeat(513) }),
        GiftDraftValidationError,
    )
    assert.throws(
        () => validateGiftDraft({ ...validDraft, note: 7 }),
        GiftDraftValidationError,
    )

    const sparseRewards = [{ ...itemReward }]
    sparseRewards.length = 2
    assert.throws(
        () => validateGiftDraft({ ...validDraft, rewards: sparseRewards }),
        GiftDraftValidationError,
    )
    assert.throws(
        () => validateGiftDraft({ ...validDraft, rewards: [undefined, { ...itemReward }] }),
        GiftDraftValidationError,
    )
    assert.throws(
        () => validateGiftDraft({
            ...validDraft,
            rewards: [{ ...itemReward, extra: true }],
        }),
        GiftDraftValidationError,
    )
    assert.throws(
        () => validateGiftDraft({
            ...validDraft,
            rewards: [{ position: 0, type: 1, number: 1 }],
        }),
        GiftDraftValidationError,
    )
})

test("validates ordered rewards against protocol and current Content", () => {
    assert.doesNotThrow(() => validateGiftRewards(allRewards))
    assert.throws(() => validateGiftRewards([]), GiftRewardValidationError)
    assert.throws(
        () => validateGiftRewards(Array.from({ length: 21 }, (_, position) => ({
            position,
            type: 8,
            typeId: null,
            number: 1,
        }))),
        GiftRewardValidationError,
    )
    assert.throws(
        () => validateGiftRewards([
            { ...itemReward, position: 1 },
            { ...beadsReward },
        ]),
        GiftRewardValidationError,
    )
    assert.throws(
        () => validateGiftRewards([{ ...itemReward, type: 2 }]),
        GiftRewardValidationError,
    )
    assert.throws(
        () => validateGiftRewards([{ ...itemReward, typeId: null }]),
        GiftRewardValidationError,
    )
    assert.throws(
        () => validateGiftRewards([{ ...itemReward, typeId: 999999999 }]),
        GiftRewardValidationError,
    )
    assert.throws(
        () => validateGiftRewards([{ ...characterReward, number: 2 }]),
        GiftRewardValidationError,
    )
    assert.throws(
        () => validateGiftRewards([{ ...equipmentReward, number: 2 }]),
        GiftRewardValidationError,
    )
    assert.throws(
        () => validateGiftRewards([{ ...itemReward, number: 2147483648 }]),
        GiftRewardValidationError,
    )
    assert.throws(
        () => validateGiftRewards([{ ...manaReward, typeId: 1 }]),
        GiftRewardValidationError,
    )
})

test("maps gift protocol types to Reward Grant types", () => {
    assert.deepEqual(GIFT_TO_REWARD_TYPE, {
        1: RewardType.ITEM,
        4: RewardType.BEADS,
        5: RewardType.CHARACTER,
        6: RewardType.EQUIPMENT,
        8: RewardType.MANA,
        9: RewardType.EXP,
    })
})

test("creates stopped definitions and enforces BINARY exact uniqueness", () => {
    data.initializeDatabase()
    assert.equal(isGiftCodeEnabledSync(), false)

    const created = createGiftSync(createDraft("Case Key"))
    assert.equal(created.status, "stopped")
    assert.equal(created.code, "Case Key")
    assert.equal(created.rewardRevision, 1)
    assert.equal(created.revision, 1)
    assert.equal(created.redemptionCount, 0)
    assert.equal(getGiftByExactCodeSync("case key"), null)
    assert.deepEqual(getGiftByExactCodeSync("Case Key")?.rewards, [{ ...itemReward }])
    assert.throws(() => createGiftSync(createDraft("Case Key")))

    const withWhitespace = createGiftSync(createDraft("Case Key "))
    assert.notEqual(withWhitespace.id, created.id)
})

test("updates only stopped definitions and advances reward revision for ordered reward changes", () => {
    const gift = createGiftSync(createDraft("update-me"))
    const changedMetadata = updateStoppedGiftSync(gift.id, gift.revision, {
        code: "changed-code",
        note: "metadata only",
        rewards: [{ ...itemReward }],
    })
    assert.equal(changedMetadata.revision, gift.revision + 1)
    assert.equal(changedMetadata.rewardRevision, gift.rewardRevision)

    const rewardChange = updateStoppedGiftSync(changedMetadata.id, changedMetadata.revision, {
        code: "changed-code",
        note: "metadata only",
        rewards: [
            { ...beadsReward, position: 0 },
            { ...itemReward, position: 1, number: 2 },
        ],
    })
    assert.equal(rewardChange.revision, changedMetadata.revision + 1)
    assert.equal(rewardChange.rewardRevision, changedMetadata.rewardRevision + 1)
    assert.throws(
        () => updateStoppedGiftSync(rewardChange.id, rewardChange.revision + 1, {
            code: "changed-code",
            note: null,
            rewards: [{ ...itemReward }],
        }),
        error => error.name === "GiftRevisionConflictError",
    )

    const active = startGiftSync(rewardChange.id, rewardChange.revision)
    assert.equal(active.status, "active")
    assert.equal(isGiftCodeEnabledSync(), true)
    assert.throws(
        () => updateStoppedGiftSync(active.id, active.revision, createDraft("blocked")),
        error => error.name === "GiftStateError",
    )
    assert.throws(
        () => deleteStoppedGiftSync(active.id, active.revision),
        error => error.name === "GiftStateError",
    )
    stopGiftSync(active.id, active.revision)
    assert.equal(isGiftCodeEnabledSync(), false)
})

test("start revalidates persisted rewards transactionally", () => {
    const gift = createGiftSync(createDraft("start-invalid"))
    const database = getDb()
    database.prepare(`
        UPDATE server_gift_rewards
        SET type_id = 999999999
        WHERE gift_id = ?
    `).run(gift.id)
    assert.throws(
        () => startGiftSync(gift.id, gift.revision),
        GiftRewardValidationError,
    )
    const unchanged = getGiftSync(gift.id)
    assert.equal(unchanged?.status, "stopped")
    assert.equal(unchanged?.revision, gift.revision)
})

test("stops, deletes stopped definitions, cascades rows, and allows code reuse", () => {
    const created = createGiftSync(createDraft("temporary-code"))
    const active = startGiftSync(created.id, created.revision)
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "gift-redemption-cascade",
        status: "normal",
    })
    const player = insertDefaultPlayerSync(account.id)
    getDb().prepare(`
        INSERT INTO players_gift_redemptions (
            gift_id, player_id, reward_revision, reward_snapshot, redeemed_at
        ) VALUES (?, ?, ?, ?, ?)
    `).run(active.id, player.id, active.rewardRevision, JSON.stringify(active.rewards), "2026-08-30T00:00:00.000Z")
    const stopped = stopGiftSync(active.id, active.revision)
    assert.equal(stopped.status, "stopped")
    assert.equal(stopped.redemptionCount, 1)
    assert.equal(stopped.rewardRevision, active.rewardRevision)
    assert.equal(isGiftCodeEnabledSync(), false)

    deleteStoppedGiftSync(stopped.id, stopped.revision)
    assert.equal(getGiftSync(stopped.id), null)
    assert.equal(getDb().prepare(
        "SELECT COUNT(*) AS count FROM server_gift_rewards WHERE gift_id = ?",
    ).get(stopped.id).count, 0)
    assert.equal(getDb().prepare(
        "SELECT COUNT(*) AS count FROM players_gift_redemptions WHERE gift_id = ?",
    ).get(stopped.id).count, 0)
    assert.notEqual(getDb().prepare(
        "SELECT 1 FROM players WHERE id = ?",
    ).get(player.id), undefined)

    const recreated = createGiftSync(createDraft("temporary-code"))
    assert.notEqual(recreated.id, stopped.id)
})

test("lists bounded pages with redemption counts", () => {
    const first = createGiftSync(createDraft("page-a"))
    const latest = createGiftSync(createDraft("page-b"))
    const page = listGiftsSync(1, 1)
    assert.equal(page.totalCount >= 2, true)
    assert.equal(page.page, 1)
    assert.equal(page.pageSize, 1)
    assert.equal(page.rows.length, 1)
    assert.equal(page.rows[0].id, latest.id)
    assert.equal(page.rows.some(row => row.id === first.id), false)
    assert.throws(() => listGiftsSync(0, 1))
    assert.throws(() => listGiftsSync(1, 0))
    assert.throws(
        () => listGiftsSync(1, 1.5),
        error => error instanceof TypeError && /positive integer/.test(error.message),
    )
    assert.throws(() => listGiftsSync(1, 101))
})
