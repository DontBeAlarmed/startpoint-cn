"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { getRewardCampaignTable } = require("../src/lib/reward-campaign")
const { getAdditionalRewardTable } = require("../src/lib/additional-reward")
const {
    getActivityPeriodicRewardPointDefinitions,
    getPeriodicRewardCatalog,
} = require("../src/lib/quest/periodic-reward-content")
const { getRaidEventRewardCatalog } = require("../src/lib/quest/finish/raid-overall-rewards")
const {
    createFrozenTestContentRepository,
} = require("./helpers/content-snapshot-fixture.cjs")

const campaign = {
    "1": {
        id: 1,
        repeatKind: "once",
        startAtMs: 0,
        endAtMs: 1,
        rewardKind: 0,
        rate: 2,
        categories: [26],
        keyQueries: [null, null],
    },
}
const additional = {
    groups: {
        "1": [{ index: 1, groupStringId: "one", type: 0, id: 40001, number: 1, weight: 1 }],
    },
    collectItemRules: [{
        eventId: 1,
        startAtMs: 0,
        endAtMs: 1,
        categories: [26],
        keyQueries: [null, null],
        prerequisite: null,
        thresholds: [{ enemyLevelMin: 0, groupId: 1 }],
    }],
    bossPickupRules: [],
}
const periodic = {
    "hard_multi_event.json": { "1": { periodicPointId: 1 } },
    "periodic_reward_point.json": { "1": { maxPoint: 99, recoveryPoint: 2, recoveryCycle: 0 } },
    "periodic_reward.json": {
        "1": { "1": { kind: 0, itemId: 40001, count: 1, probability: 1 } },
    },
    "hard_multi_event_quest.json": {
        "1001": { periodicRewardGroupId: 1, periodicRewardSlots: 1 },
    },
}

function raidRow(eventId = "1") {
    const row = Array(37).fill("")
    row[0] = String(eventId)
    row[2] = "0"
    row[3] = "1"
    row[7] = "0"
    row[8] = "40001"
    row[9] = "1"
    return row
}

function repository(overrides = {}) {
    return createFrozenTestContentRepository({
        tables: {
            "reward_campaign.json": campaign,
            "additional_reward_rules.json": additional,
            ...periodic,
            "raid_event_overall_reward.json": { "1": [raidRow()] },
            "raid_event.json": { "1": { requiredKillCount: 1 } },
            ...overrides,
        },
    })
}

test("reward catalogs cache by repository identity and expose frozen projections", () => {
    const firstRepository = repository()
    const secondRepository = repository()
    for (const getter of [
        getRewardCampaignTable,
        getAdditionalRewardTable,
        getPeriodicRewardCatalog,
        getRaidEventRewardCatalog,
    ]) {
        const first = getter(firstRepository)
        assert.strictEqual(getter(firstRepository), first)
        assert.notStrictEqual(getter(secondRepository), first)
        assert.equal(Object.isFrozen(first), true)
    }
    const periodicCatalog = getPeriodicRewardCatalog(firstRepository)
    assert.equal(Object.isFrozen(periodicCatalog.rewards["1"]["1"]), true)
    assert.equal(typeof periodicCatalog.points.set, "undefined")
})

test("Reward Campaign rejects malformed enum and rate instead of defaulting", () => {
    assert.throws(
        () => getRewardCampaignTable(repository({
            "reward_campaign.json": { "1": { ...campaign["1"], rewardKind: 99 } },
        })),
        /rewardKind is invalid/i,
    )
    assert.throws(
        () => getRewardCampaignTable(repository({
            "reward_campaign.json": { "1": { ...campaign["1"], rate: 1_000_000 } },
        })),
        /rate must be from 1 through 2/i,
    )
    assert.throws(
        () => getRewardCampaignTable(repository({
            "reward_campaign.json": { "1": { ...campaign["1"], keyQueries: [null] } },
        })),
        /quest range shape is invalid/i,
    )
    assert.doesNotThrow(() => getRewardCampaignTable(repository({
        "reward_campaign.json": {
            "1": {
                ...campaign["1"],
                categories: [6, 14, 13, 20],
                keyQueries: [],
            },
        },
    })))
})

test("Periodic Reward rejects incomplete quest to event, point and reward closure", () => {
    assert.throws(
        () => getPeriodicRewardCatalog(repository({
            "hard_multi_event_quest.json": {
                "2001": { periodicRewardGroupId: 1, periodicRewardSlots: 1 },
            },
        })),
        /quest 2001 references missing event 2/i,
    )
    assert.throws(
        () => getPeriodicRewardCatalog(repository({
            "hard_multi_event.json": { "1": {} },
        })),
        /quest 1001 cannot resolve periodic point/i,
    )
    assert.throws(
        () => getPeriodicRewardCatalog(repository({
            "hard_multi_event_quest.json": {
                "1001": { periodicRewardGroupId: 2, periodicRewardSlots: 1 },
            },
        })),
        /quest 1001 references missing reward group 2/i,
    )
})

test("Additional Reward rejects missing and non-deterministic referenced groups", () => {
    assert.throws(
        () => getAdditionalRewardTable(repository({
            "additional_reward_rules.json": {
                ...additional,
                collectItemRules: [{
                    ...additional.collectItemRules[0],
                    thresholds: [{ enemyLevelMin: 0, groupId: 2 }],
                }],
            },
        })),
        /group.*array|deterministic candidate/i,
    )
    assert.throws(
        () => getAdditionalRewardTable(repository({
            "additional_reward_rules.json": {
                ...additional,
                groups: { "1": [...additional.groups["1"], ...additional.groups["1"]] },
            },
        })),
        /deterministic candidate|duplicate index/i,
    )
})

test("Additional Reward keeps unreferenced source-schema groups valid", () => {
    assert.doesNotThrow(() => getAdditionalRewardTable(repository({
        "additional_reward_rules.json": {
            ...additional,
            groups: {
                ...additional.groups,
                "2": [
                    { index: 1, groupStringId: "mana", type: 1, number: 10, weight: 1 },
                    { index: 2, groupStringId: "stone", type: 2, id: 40002, number: 5, weight: 2 },
                ],
            },
        },
    })))
})

test("Periodic Reward validates the complete event-point-group-quest closure", () => {
    assert.throws(
        () => getPeriodicRewardCatalog(repository({
            "periodic_reward_point.json": {
                "2": { maxPoint: 1, recoveryPoint: 1, recoveryCycle: 0 },
            },
        })),
        /event 1 references missing point 1/i,
    )
    assert.throws(
        () => getPeriodicRewardCatalog(repository({
            "periodic_reward.json": {
                "2": periodic["periodic_reward.json"]["1"],
            },
        })),
        /quest 1001 references missing reward group 1/i,
    )
    assert.throws(
        () => getPeriodicRewardCatalog(repository({
            "hard_multi_event_quest.json": {
                "1001": { periodicRewardGroupId: 1 },
            },
        })),
        /group\/slots must appear together/i,
    )
})

test("Periodic Reward player point projection honors an event's explicit point", () => {
    const explicitPointRepository = repository({
        "hard_multi_event.json": { "1001": { periodicPointId: 1 } },
        "periodic_reward.json": {
            "2": periodic["periodic_reward.json"]["1"],
        },
        "hard_multi_event_quest.json": {
            "1001001": { periodicRewardGroupId: 2, periodicRewardSlots: 1 },
        },
    })
    assert.deepEqual(
        getActivityPeriodicRewardPointDefinitions(explicitPointRepository).map(entry => entry.id),
        [1],
    )
    assert.ok(getActivityPeriodicRewardPointDefinitions(explicitPointRepository)
        .every(entry => entry.definition !== undefined))
})

test("Raid/Event reward catalog rejects malformed rows and dangling event relations", () => {
    const malformed = raidRow()
    malformed[7] = "99"
    assert.throws(
        () => getRaidEventRewardCatalog(repository({
            "raid_event_overall_reward.json": { "1": [malformed] },
        })),
        /unsupported reward kind/i,
    )
    assert.throws(
        () => getRaidEventRewardCatalog(repository({
            "raid_event.json": { "2": { requiredKillCount: 1 } },
        })),
        /references missing event 1/i,
    )
    const nonCanonicalKind = raidRow()
    nonCanonicalKind[7] = true
    assert.throws(
        () => getRaidEventRewardCatalog(repository({
            "raid_event_overall_reward.json": { "1": [nonCanonicalKind] },
        })),
        /invalid raid reward kind/i,
    )
    assert.throws(
        () => getRaidEventRewardCatalog(repository({
            "raid_event.json": { "1": { requiredKillCount: "1" } },
        })),
        /invalid raid event 1 required kill count/i,
    )

    for (const invalidStart of [true, [], " 1", "1e2", "01"]) {
        const row = raidRow()
        row[2] = "1"
        row[3] = invalidStart
        row[4] = "1"
        assert.throws(
            () => getRaidEventRewardCatalog(repository({
                "raid_event_overall_reward.json": { "1": [row] },
            })),
            /invalid raid reward start/i,
            `invalid start ${JSON.stringify(invalidStart)} must fail closed`,
        )
    }

    for (const invalidCurrencyId of [true, [], " 1", "1e2", "01", 1]) {
        const row = raidRow()
        row[7] = "2"
        row[8] = invalidCurrencyId
        assert.throws(
            () => getRaidEventRewardCatalog(repository({
                "raid_event_overall_reward.json": { "1": [row] },
            })),
            /invalid raid reward currency id/i,
            `currency raw id ${JSON.stringify(invalidCurrencyId)} must fail closed`,
        )
    }
})

test("battle settlement validates reward Content before write transactions", () => {
    const single = fs.readFileSync(
        path.resolve(__dirname, "../src/lib/quest/finish/single-orchestrator.ts"),
        "utf8",
    )
    const multi = fs.readFileSync(
        path.resolve(__dirname, "../src/multi/settlement/orchestrator.ts"),
        "utf8",
    )
    for (const [source, transactionMarker] of [
        [single, "runSingleFinishSettlementTransaction({"],
        [multi, "runMultiActiveQuestSettlementTransaction("],
    ]) {
        const transaction = source.indexOf(transactionMarker)
        assert.ok(transaction > source.indexOf("getRewardCampaignTable()"))
        assert.ok(transaction > source.indexOf("getAdditionalRewardTable()"))
    }
    assert.ok(multi.indexOf("runMultiActiveQuestSettlementTransaction(")
        > multi.indexOf("getPeriodicRewardCatalog()"))

    const raid = fs.readFileSync(
        path.resolve(__dirname, "../src/routes/api/raidEvent.ts"),
        "utf8",
    )
    assert.ok(raid.indexOf("getRaidEventRewardCatalog()") < raid.indexOf("insertPlayerRushEventSync("))
})
