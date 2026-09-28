"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
    buildGachaCatalog,
    getGachaCatalog,
    isGachaPeriodAvailable,
    parseGachaJstTimestamp,
    resolveGachaCampaign,
    GachaPeriodError,
    GachaRequestError,
    prepareGachaExecRequest,
} = require("../src/lib/gacha-catalog")
const { getLegacyGachas } = require("../src/lib/gacha-legacy-content")
const {
    GACHA_EXEC_TYPES,
    GACHA_PAYMENT_TYPES,
    isGachaExecAllowed,
} = require("../src/lib/gacha-rules")

const assetsRoot = path.resolve(__dirname, "../assets")
const TABLES = [
    "gacha.json",
    "gacha_pool.json",
    "gacha_campaign_definitions.json",
    "stars_gacha_campaign.json",
    "gacha_exchange_rate.json",
    "character.json",
    "equipment_lookup.json",
    "item_lookup.json",
    "equipment_gacha_movie_probability.json",
]

function repository(overrides = {}) {
    const tables = Object.fromEntries(TABLES.map(name => [
        name,
        JSON.parse(fs.readFileSync(path.join(assetsRoot, name), "utf8")),
    ]))
    Object.assign(tables, overrides)
    const calls = []
    return {
        calls,
        tables,
        info: () => ({ source: "bundled" }),
        table(name) {
            calls.push(name)
            return tables[name]
        },
    }
}

test("bundled Gacha catalog preserves actual banners, pools, campaigns and rates", () => {
    const catalog = buildGachaCatalog(repository())
    assert.equal(Object.keys(catalog.banners).length, 584)
    assert.equal(Object.keys(catalog.pools).length, 930)
    assert.equal(Object.keys(catalog.campaigns).length, 41)
    assert.equal(Object.values(catalog.campaigns).reduce((sum, campaign) => (
        sum + campaign.gachaIds.length
    ), 0), 161)
    assert.equal(Object.keys(catalog.starsCampaigns).length, 5)
    assert.equal(Object.values(catalog.banners).filter(banner => banner.definition.isComeback).length, 5)
    assert.equal(Object.values(catalog.banners).filter(banner => banner.definition.isStarsGacha).length, 5)
    assert.deepEqual(catalog.exchangeRates, {
        character: { 3: 250, 4: 250, 5: 250 },
        equipment: { 3: 250, 4: 250, 5: 250 },
    })
    assert.equal(catalog.campaignIdsByGachaId["700004"].length, 7)
    assert.equal(Object.isFrozen(catalog), true)
    assert.equal(Object.isFrozen(catalog.pools), true)
})

test("bundled Gacha byte-integrity and compact source projection stay closed", () => {
    const expectedDigests = {
        "gacha.json": "7ce51caab9817971fdc9b5de99a3733d457c5a5391d19d6a0cf43c6786b46e81",
        "gacha_pool.json": "24d09eec301856e6c58d0778b232958eb1101a9acbdeea221a5d25b990c446ce",
        "gacha_campaign_definitions.json": "6049cddb541b0307871360a7265bf6a42081d4fd6944fb2ff805ee7c564f9515",
        "stars_gacha_campaign.json": "d5c09396dd8e8f193245079a425b2c81bad9c01c488f5b41931b34afbedf10ff",
        "gacha_exchange_rate.json": "d8c34bac5d1b1f8a4906a7ddf80522086224924399e2ee2a775b5953766030d2",
    }
    for (const [name, expected] of Object.entries(expectedDigests)) {
        const digest = crypto.createHash("sha256")
            .update(fs.readFileSync(path.join(assetsRoot, name)))
            .digest("hex")
        assert.equal(digest, expected, `${name} byte-integrity baseline`)
    }

    const repo = repository()
    const banners = repo.tables["gacha.json"]
    const pools = repo.tables["gacha_pool.json"]
    const rawRows = JSON.parse(fs.readFileSync(
        path.join(assetsRoot, "cdndata/gacha.json"),
        "utf8",
    ))
    assert.deepEqual(Object.keys(banners), Object.keys(rawRows))
    const clean = value => {
        const text = String(value ?? "").trim()
        return text && text !== "(None)" ? text : undefined
    }
    for (const [id, banner] of Object.entries(banners)) {
        const row = rawRows[id][0]
        assert.equal(row.length, 47)
        assert.equal(banner.name, row[1])
        assert.equal(banner.kind, row[13] === "1" ? "equipment" : "character")
        assert.equal(banner.page.kind, Number(row[4]))
        assert.equal(banner.guaranteeNumber, Number(row[9]))
        assert.equal(banner.guaranteeRarity, Number(row[10]))
        assert.equal(banner.rarityOddsId, row[11])
        assert.equal(banner.startDate, row[29])
        assert.equal(banner.endDate, row[30])
        assert.equal(banner.ticketExpiryTime, clean(row[31]))
        assert.equal(banner.showPeriod, clean(row[32]) === "true")
        assert.equal(banner.isComeback, clean(row[43]) === "true")
        assert.equal(banner.freemiumGuaranteeAvailable, clean(row[44]) === "true")
        assert.equal(banner.isStarsGacha, clean(row[46]) === "true")
        assert.equal(banner.onceTicketItemId, clean(row[27]) === undefined ? undefined : Number(row[27]))
        assert.equal(banner.tenTicketItemId, clean(row[28]) === undefined ? undefined : Number(row[28]))
        assert.equal(banner.crazyTenTicketItemId, clean(row[45]) === undefined ? undefined : Number(row[45]))
        const columns = banner.kind === "equipment" ? [24, 23, 22] : [16, 15, 14]
        assert.deepEqual(banner.poolOddsIds, Object.fromEntries(columns.map(
            (column, index) => [String(index + 1), row[column]],
        )))
        if (banner.kind === "character") {
            assert.equal(banner.movieName, row[17])
            assert.equal(banner.guaranteeMovieName, row[18])
            assert.equal(banner.toUseOddsUpAsTrialReading, clean(row[19]) === "true")
            assert.equal(banner.wildcardTicketAvailable, clean(row[20]) === "true")
            assert.equal(banner.canBeStartDashExchange, clean(row[21]) === "true")
        } else {
            assert.equal(banner.equipmentMovieProbabilityId, row[25])
            assert.equal(banner.wildcardTicketAvailable, clean(row[26]) === "true")
        }
        if (banner.page.kind === 0) {
            assert.deepEqual(banner.page, {
                kind: 0,
                singleCost: Number(row[5]),
                multiCost: Number(row[6]),
                dailyPaidCost: Number(row[7]),
            })
        } else if (banner.page.kind === 1) {
            assert.deepEqual(banner.page, {
                kind: 1,
                accountPaidTenCost: Number(row[8]),
            })
        } else if (banner.page.kind === 8) {
            assert.deepEqual(banner.page, {
                kind: 8,
                singleCost: Number(row[5]),
                multiCost: Number(row[6]),
            })
        } else {
            assert.deepEqual(banner.page, { kind: Number(row[4]) })
        }
    }
    const referenced = new Set()
    let referenceCount = 0
    for (const banner of Object.values(banners)) {
        assert.equal("pool" in banner, false)
        assert.deepEqual(Object.keys(banner.poolOddsIds).sort(), ["1", "2", "3"])
        for (const oddsId of Object.values(banner.poolOddsIds)) {
            assert.ok(pools[oddsId], `missing ${oddsId}`)
            referenced.add(oddsId)
            referenceCount += 1
        }
    }
    assert.equal(referenceCount, 1752)
    assert.equal(referenced.size, 930)
    assert.equal(referenced.size, Object.keys(pools).length)
    assert.ok(
        fs.statSync(path.join(assetsRoot, "gacha.json")).size
            + fs.statSync(path.join(assetsRoot, "gacha_pool.json")).size
            < 27_054_301,
        "compact banner plus shared pools must be smaller than the former expanded banner table",
    )

    const legacy = getLegacyGachas(repo)
    assert.strictEqual(
        legacy["1638"].pool["1"],
        getGachaCatalog(repo).pools[banners["1638"].poolOddsIds["1"]].items,
        "legacy compatibility must share the validated Catalog prize array",
    )
    assert.deepEqual(
        Object.entries(repo.tables["equipment_lookup.json"])
            .filter(([id]) => ["5020008", "4030003", "3050002"].includes(id))
            .map(([id, row]) => [id, Number(row.rarity)]),
        [["3050002", 3], ["4030003", 4], ["5020008", 5]],
    )
})

test("weighted pools are shared by odds identity and precompute cumulative weights", () => {
    const catalog = buildGachaCatalog(repository())
    const banner = catalog.banners["1638"]
    for (const [rank, pool] of Object.entries(banner.poolsByRank)) {
        assert.strictEqual(pool, catalog.pools[banner.definition.poolOddsIds[rank]])
        assert.equal(pool.cumulativeWeights.at(-1), pool.totalWeight)
        assert.equal(pool.items.every(item => item.odds > 0), true)
    }
    const exchangeable = Object.values(banner.poolsByRank)
        .flatMap(pool => pool.items)
        .find(item => item.isExchangeable)
    assert.strictEqual(
        catalog.exchangeableByGachaAndItem[`1638:${exchangeable.id}`],
        exchangeable,
    )
})

test("gacha master timestamps parse in the CN client calendar, not JST+9", () => {
    assert.equal(
        new Date(parseGachaJstTimestamp("2024-08-14 20:00:00")).toISOString(),
        "2024-08-14T12:00:00.000Z",
    )
})

test("JST period boundaries are inclusive and standard campaign resolution keeps history", () => {
    const catalog = buildGachaCatalog(repository())
    const banner = catalog.banners["1638"]
    const start = parseGachaJstTimestamp(banner.basePeriod.availableFrom)
    const end = parseGachaJstTimestamp(banner.basePeriod.availableUntil)
    assert.equal(isGachaPeriodAvailable(banner.basePeriod, start), true)
    assert.equal(isGachaPeriodAvailable(banner.basePeriod, end), true)
    assert.equal(isGachaPeriodAvailable(banner.basePeriod, start - 1), false)
    assert.equal(isGachaPeriodAvailable(banner.basePeriod, end + 1), false)
    assert.equal(resolveGachaCampaign(
        catalog,
        80004,
        Date.parse("2024-08-14T12:00:00Z"),
        1,
    ), null)
})

test("ticket expiry is separate from the base period", () => {
    const catalog = buildGachaCatalog(repository())
    const banner = catalog.banners["25009"]
    assert.ok(parseGachaJstTimestamp(banner.ticketExpiryTime)
        > parseGachaJstTimestamp(banner.basePeriod.availableUntil))
})

test("catalog cache is isolated by repository identity", () => {
    const firstRepository = repository()
    const first = getGachaCatalog(firstRepository)
    const calls = firstRepository.calls.length
    assert.strictEqual(getGachaCatalog(firstRepository), first)
    assert.equal(firstRepository.calls.length, calls)
    assert.notStrictEqual(getGachaCatalog(repository()), first)
})

test("request plan enforces payment, count, player period, ticket extension and Crazy dispatch", () => {
    const catalog = buildGachaCatalog(repository())
    assert.equal(isGachaExecAllowed(
        catalog.banners["2"].definition,
        GACHA_PAYMENT_TYPES.TICKET,
        GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET,
    ), true)
    assert.equal(isGachaExecAllowed(
        catalog.banners["2"].definition,
        GACHA_PAYMENT_TYPES.TICKET,
        GACHA_EXEC_TYPES.SINGLE_TICKET,
    ), false)
    assert.equal(isGachaExecAllowed(
        catalog.banners["9"].definition,
        GACHA_PAYMENT_TYPES.TICKET,
        GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET,
    ), true)
    assert.equal(isGachaExecAllowed(
        catalog.banners["9"].definition,
        GACHA_PAYMENT_TYPES.TICKET,
        GACHA_EXEC_TYPES.MULTI_TICKET,
    ), false)
    assert.equal(isGachaExecAllowed(
        catalog.banners["57"].definition,
        GACHA_PAYMENT_TYPES.TICKET,
        GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET,
    ), true)
    assert.equal(isGachaExecAllowed(
        catalog.banners["57"].definition,
        GACHA_PAYMENT_TYPES.TICKET,
        GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET,
    ), true)
    assert.equal(isGachaExecAllowed(
        catalog.banners["33"].definition,
        GACHA_PAYMENT_TYPES.TICKET,
        GACHA_EXEC_TYPES.SINGLE_TICKET,
    ), true)
    assert.equal(isGachaExecAllowed(
        catalog.banners["1638"].definition,
        GACHA_PAYMENT_TYPES.VMONEY,
        GACHA_EXEC_TYPES.ACCOUNT_PAID_MULTI,
    ), false)
    assert.equal(isGachaExecAllowed(
        catalog.banners["800000"].definition,
        GACHA_PAYMENT_TYPES.VMONEY,
        GACHA_EXEC_TYPES.ACCOUNT_PAID_MULTI,
    ), true)
    assert.equal(isGachaExecAllowed(
        catalog.banners["800000"].definition,
        GACHA_PAYMENT_TYPES.TICKET,
        GACHA_EXEC_TYPES.MULTI_TICKET,
    ), false)
    assert.equal(isGachaExecAllowed(
        catalog.banners["100"].definition,
        GACHA_PAYMENT_TYPES.TICKET,
        GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET,
    ), true)
    assert.throws(() => prepareGachaExecRequest({
        catalog,
        gachaId: 1638,
        paymentType: 3,
        execType: 1,
        numberOfExec: 1,
        nowMs: Date.parse("2024-08-14T00:00:00Z"),
    }), GachaRequestError)

    const extensionNow = Date.parse("2024-08-14T00:00:00Z")
    assert.throws(() => prepareGachaExecRequest({
        catalog,
        gachaId: 25009,
        paymentType: 3,
        execType: 13,
        numberOfExec: 1,
        nowMs: extensionNow,
        hasApplicableTicket: false,
    }), GachaPeriodError)
    const extendedTicket = prepareGachaExecRequest({
        catalog,
        gachaId: 25009,
        paymentType: 3,
        execType: 13,
        numberOfExec: 1,
        nowMs: extensionNow,
        hasApplicableTicket: true,
    })
    assert.equal(extendedTicket.kind, "ordinary")
    assert.deepEqual(extendedTicket.ticket, {
        itemId: 999004,
        useTicketCount: 1,
        pullCount: 10,
    })

    assert.throws(() => prepareGachaExecRequest({
        catalog,
        gachaId: 80004,
        paymentType: 1,
        execType: 1,
        numberOfExec: 1,
        nowMs: extensionNow,
    }), GachaPeriodError)
    assert.equal(prepareGachaExecRequest({
        catalog,
        gachaId: 100,
        paymentType: 3,
        execType: 14,
        numberOfExec: 1,
        nowMs: extensionNow,
        hasApplicableTicket: true,
    }).kind, "crazyCandidate")
})

test("catalog rejects reachable semantic corruption at the content boundary", () => {
    const badCost = repository()
    badCost.tables["gacha.json"]["1638"].page.singleCost = -150
    assert.throws(() => buildGachaCatalog(badCost), /single cost/i)

    const badRank = repository()
    const oddsId = badRank.tables["gacha.json"]["1638"].poolOddsIds["1"]
    badRank.tables["gacha_pool.json"][oddsId][0].rank = 4
    assert.throws(() => buildGachaCatalog(badRank), /mismatched rarity/i)

    const badStars = repository()
    badStars.tables["gacha.json"]["80000"].isStarsGacha = false
    assert.throws(() => buildGachaCatalog(badStars), /non-Stars Gacha/i)

    const badRates = repository()
    badRates.tables["gacha_exchange_rate.json"].character[2] = 250
    assert.throws(() => buildGachaCatalog(badRates), /rate rarities/i)

    const missingRateKind = repository()
    delete missingRateKind.tables["gacha_exchange_rate.json"].equipment
    assert.throws(() => buildGachaCatalog(missingRateKind), /rate kinds/i)

    const badTicketExpiry = repository()
    badTicketExpiry.tables["gacha.json"]["25009"].ticketExpiryTime = "not-a-time"
    assert.throws(() => buildGachaCatalog(badTicketExpiry), /invalid Gacha period/i)

    const badMovieProfile = repository()
    badMovieProfile.tables["equipment_gacha_movie_probability.json"]["1"].probabilityEruption = 2
    assert.throws(() => buildGachaCatalog(badMovieProfile), /movie profile/i)
})
