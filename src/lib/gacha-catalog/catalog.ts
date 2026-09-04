import { deepFreeze } from "../../content/deep-freeze"
import { getContentSnapshot, type ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import type {
    GachaCampaignDefinition,
    GachaExchangeRates,
    GachaPools,
    GachaRuntimeBanner,
    GachaRuntimeBanners,
    StarsGachaCampaignDefinition,
} from "../types/gacha"
import type { GachaBanner, GachaCatalog, GachaWeightedPool } from "./model"
import { isGachaPeriodAvailable, parseGachaJstTimestamp } from "./period"

function positiveInteger(value: unknown, subject: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new TypeError(`${subject} must be a positive safe integer.`)
    }
    return value as number
}

function buildPool(oddsId: string, items: GachaPools[string]): GachaWeightedPool {
    const seen = new Set<number>()
    const cumulativeWeights: number[] = []
    let totalWeight = 0
    for (const item of items) {
        positiveInteger(item.id, `Gacha pool ${oddsId} item id`)
        const weight = positiveInteger(item.odds, `Gacha pool ${oddsId} weight`)
        if (seen.has(item.id)) throw new TypeError(`Gacha pool ${oddsId} has duplicate item ${item.id}.`)
        seen.add(item.id)
        totalWeight += weight
        if (!Number.isSafeInteger(totalWeight)) throw new RangeError(`Gacha pool ${oddsId} weight overflow.`)
        cumulativeWeights.push(totalWeight)
    }
    if (items.length === 0) throw new TypeError(`Gacha pool ${oddsId} is empty.`)
    return { oddsId, items: [...items], cumulativeWeights, totalWeight }
}

function assertPositiveCost(value: number, subject: string): void {
    positiveInteger(value, subject)
}

function validatePage(gachaId: number, banner: GachaRuntimeBanner): void {
    const subject = `Gacha ${gachaId}`
    switch (banner.page.kind) {
        case 0:
            if (banner.crazyTenTicketItemId !== undefined) {
                throw new TypeError(`${subject} normal page must not configure a Crazy ticket.`)
            }
            assertPositiveCost(banner.page.singleCost, `${subject} single cost`)
            assertPositiveCost(banner.page.multiCost, `${subject} multi cost`)
            assertPositiveCost(banner.page.dailyPaidCost, `${subject} daily paid cost`)
            return
        case 1:
            if (banner.onceTicketItemId !== undefined
                || banner.tenTicketItemId !== undefined
                || banner.crazyTenTicketItemId !== undefined
                || banner.wildcardTicketAvailable) {
                throw new TypeError(`${subject} account-paid page must not configure tickets.`)
            }
            assertPositiveCost(banner.page.accountPaidTenCost, `${subject} account paid cost`)
            return
        case 2:
            if (banner.onceTicketItemId === undefined || banner.tenTicketItemId === undefined
                || banner.crazyTenTicketItemId !== undefined || banner.wildcardTicketAvailable) {
                throw new TypeError(`${subject} ticket-only page requires configured single and ten tickets.`)
            }
            return
        case 3:
            if (banner.onceTicketItemId === undefined || banner.tenTicketItemId !== undefined
                || banner.crazyTenTicketItemId !== undefined || banner.wildcardTicketAvailable) {
                throw new TypeError(`${subject} single-ticket page requires only its configured ticket.`)
            }
            return
        case 4:
            if (banner.onceTicketItemId !== undefined || banner.tenTicketItemId === undefined
                || banner.crazyTenTicketItemId !== undefined || banner.wildcardTicketAvailable) {
                throw new TypeError(`${subject} ten-ticket page requires only its configured ticket.`)
            }
            return
        case 5:
            if (banner.onceTicketItemId !== undefined || banner.tenTicketItemId !== undefined
                || banner.crazyTenTicketItemId === undefined || banner.wildcardTicketAvailable
                || banner.kind !== "character") {
                throw new TypeError(`${subject} Crazy page requires only its Character Crazy ticket.`)
            }
            return
        case 8:
            if (banner.onceTicketItemId !== undefined || banner.tenTicketItemId !== undefined
                || banner.crazyTenTicketItemId !== undefined) {
                throw new TypeError(`${subject} without-daily page must not configure banner tickets.`)
            }
            assertPositiveCost(banner.page.singleCost, `${subject} single cost`)
            assertPositiveCost(banner.page.multiCost, `${subject} multi cost`)
            return
        default:
            throw new TypeError(`${subject} page kind is invalid.`)
    }
}

function validateRankRates(gachaId: number, banner: GachaRuntimeBanner): void {
    const expectedLengths = [[banner.rankRates.normal, 3], [banner.rankRates.multiGuarantee, 2]] as const
    for (const [rates, expectedLength] of expectedLengths) {
        if (rates.length !== expectedLength
            || rates.some(rate => !Number.isSafeInteger(rate) || rate < 0)
            || rates.reduce((sum, rate) => sum + rate, 0) !== 1000) {
            throw new TypeError(`Gacha ${gachaId} rank rates are invalid.`)
        }
    }
    if (banner.guaranteeNumber !== 1
        || (banner.guaranteeRarity !== 4 && banner.guaranteeRarity !== 5)) {
        throw new TypeError(`Gacha ${gachaId} guarantee is invalid.`)
    }
}

export function buildGachaCatalog(repository: ReadonlyContentRepository): GachaCatalog {
    const characters = repository.table<Readonly<Record<string, { readonly rarity?: unknown }>>>(
        "character.json",
    )
    const equipmentLookup = repository.table<Readonly<Record<string, unknown>>>(
        "equipment_lookup.json",
    )
    const itemLookup = repository.table<Readonly<Record<string, unknown>>>("item_lookup.json")
    const equipmentMovieProfiles = repository.table<Readonly<Record<string, unknown>>>(
        "equipment_gacha_movie_probability.json",
    )
    const rawPools = repository.table<GachaPools>("gacha_pool.json")
    const pools = Object.fromEntries(Object.entries(rawPools).map(([id, items]) => [
        id,
        buildPool(id, items),
    ]))
    const gachas = repository.table<GachaRuntimeBanners>("gacha.json")
    const banners: Record<string, GachaBanner> = {}
    const exchangeable: Record<string, GachaPools[string][number]> = {}
    for (const [idText, gacha] of Object.entries(gachas)) {
        const gachaId = positiveInteger(Number(idText), "Gacha id")
        validatePage(gachaId, gacha)
        validateRankRates(gachaId, gacha)
        const basePeriod = { availableFrom: gacha.startDate, availableUntil: gacha.endDate }
        if (parseGachaJstTimestamp(basePeriod.availableFrom) > parseGachaJstTimestamp(basePeriod.availableUntil)) {
            throw new TypeError(`Gacha ${gachaId} period is reversed.`)
        }
        if (gacha.ticketExpiryTime !== undefined) parseGachaJstTimestamp(gacha.ticketExpiryTime)
        if (Object.keys(gacha.poolOddsIds).sort().join(",") !== "1,2,3") {
            throw new TypeError(`Gacha ${gachaId} must reference exactly three rank pools.`)
        }
        const expectedRarityByPoolRank: Readonly<Record<string, number>> = { "1": 5, "2": 4, "3": 3 }
        const seenPrizeIds = new Set<number>()
        const poolsByRank = Object.fromEntries(Object.entries(gacha.poolOddsIds).map(
            ([rank, oddsId]) => {
                const pool = pools[oddsId]
                if (pool === undefined) throw new TypeError(`Gacha ${gachaId} references missing pool ${oddsId}.`)
                for (const item of pool.items) {
                    if (item.rank !== expectedRarityByPoolRank[rank]) {
                        throw new TypeError(`Gacha ${gachaId} pool rank ${rank} has mismatched rarity.`)
                    }
                    if (seenPrizeIds.has(item.id)) {
                        throw new TypeError(`Gacha ${gachaId} repeats prize ${item.id} across rank pools.`)
                    }
                    seenPrizeIds.add(item.id)
                    if (item.isExchangeable) exchangeable[`${gachaId}:${item.id}`] = item
                }
                return [rank, pool]
            },
        ))
        for (const pool of Object.values(poolsByRank)) {
            for (const item of pool.items) {
                if (gacha.kind === "character") {
                    const rarity = Number(characters[String(item.id)]?.rarity)
                    if (!Number.isSafeInteger(rarity) || rarity !== item.rank) {
                        throw new TypeError(`Gacha ${gachaId} Character ${item.id} rarity mismatch.`)
                    }
                } else {
                    const equipment = equipmentLookup[String(item.id)] as { readonly rarity?: unknown } | undefined
                    if (equipment === undefined) {
                        throw new TypeError(`Gacha ${gachaId} references missing Equipment ${item.id}.`)
                    }
                    const contentRarity = Number(equipment.rarity)
                    if (!Number.isSafeInteger(contentRarity) || contentRarity !== item.rank) {
                        throw new TypeError(`Gacha ${gachaId} Equipment ${item.id} rarity mismatch.`)
                    }
                }
            }
        }
        for (const ticketId of [
            gacha.onceTicketItemId,
            gacha.tenTicketItemId,
            gacha.crazyTenTicketItemId,
        ]) {
            if (ticketId !== undefined && itemLookup[String(ticketId)] === undefined) {
                throw new TypeError(`Gacha ${gachaId} references missing ticket ${ticketId}.`)
            }
        }
        if (gacha.kind === "character") {
            const movieIds = new Set(["normal", "normal_guarantee", "fes", "fes_guarantee", "rarity_5_guarantee"])
            if (!movieIds.has(gacha.movieName) || !movieIds.has(gacha.guaranteeMovieName)) {
                throw new TypeError(`Gacha ${gachaId} references unsupported Character movie.`)
            }
        } else if (equipmentMovieProfiles[gacha.equipmentMovieProbabilityId] === undefined) {
            throw new TypeError(`Gacha ${gachaId} references missing Equipment movie profile.`)
        }
        const common = {
            gachaId,
            pageKind: gacha.page.kind,
            basePeriod,
            ...(gacha.ticketExpiryTime === undefined ? {} : { ticketExpiryTime: gacha.ticketExpiryTime }),
            poolsByRank,
        }
        banners[idText] = gacha.kind === "character"
            ? { ...common, kind: "character", definition: gacha }
            : { ...common, kind: "equipment", definition: gacha }
    }

    const campaigns = repository.table<Readonly<Record<string, GachaCampaignDefinition>>>(
        "gacha_campaign_definitions.json",
    )
    const campaignIdsByGachaId: Record<string, number[]> = {}
    for (const [campaignIdText, campaign] of Object.entries(campaigns)) {
        if (positiveInteger(campaign.campaignId, "Gacha campaign id") !== Number(campaignIdText)) {
            throw new TypeError("Gacha campaign key does not match its id.")
        }
        if (campaign.kind !== 1 && campaign.kind !== 2) throw new TypeError("Gacha campaign kind is invalid.")
        if (parseGachaJstTimestamp(campaign.availableFrom) > parseGachaJstTimestamp(campaign.availableUntil)) {
            throw new TypeError(`Gacha campaign ${campaign.campaignId} period is reversed.`)
        }
        const seenGachaIds = new Set<number>()
        for (const gachaId of campaign.gachaIds) {
            positiveInteger(gachaId, `Gacha campaign ${campaign.campaignId} Gacha id`)
            if (seenGachaIds.has(gachaId)) throw new TypeError(`Gacha campaign ${campaign.campaignId} repeats Gacha ${gachaId}.`)
            seenGachaIds.add(gachaId)
            if (banners[String(gachaId)] === undefined) throw new TypeError(`Campaign references missing Gacha ${gachaId}.`)
            ;(campaignIdsByGachaId[String(gachaId)] ??= []).push(campaign.campaignId)
        }
    }
    const starsCampaigns = repository.table<Readonly<Record<string, StarsGachaCampaignDefinition>>>(
        "stars_gacha_campaign.json",
    )
    const starsGachaIds = new Set<number>()
    for (const [campaignIdText, campaign] of Object.entries(starsCampaigns)) {
        if (positiveInteger(campaign.campaignId, "Stars campaign id") !== Number(campaignIdText)) {
            throw new TypeError("Stars campaign key does not match its id.")
        }
        const banner = banners[String(campaign.gachaId)]
        if (banner === undefined || !banner.definition.isStarsGacha) {
            throw new TypeError(`Stars campaign ${campaign.campaignId} references a non-Stars Gacha.`)
        }
        if (starsGachaIds.has(campaign.gachaId)) {
            throw new TypeError(`Stars Gacha ${campaign.gachaId} has multiple campaign definitions.`)
        }
        starsGachaIds.add(campaign.gachaId)
        if (parseGachaJstTimestamp(campaign.availableFrom) > parseGachaJstTimestamp(campaign.availableUntil)) {
            throw new TypeError(`Stars campaign ${campaign.campaignId} period is reversed.`)
        }
        positiveInteger(campaign.oldPlayerDays, "Stars old player days")
        positiveInteger(campaign.newPlayerDays, "Stars new player days")
        positiveInteger(campaign.maximumFreeGachaTimes, "Stars maximum free times")
    }
    const flaggedStarsGachaIds = Object.values(banners)
        .filter(banner => banner.definition.isStarsGacha)
        .map(banner => banner.gachaId)
        .sort((left, right) => left - right)
    if (flaggedStarsGachaIds.join(",") !== [...starsGachaIds].sort((left, right) => left - right).join(",")) {
        throw new TypeError("Stars Gacha flags and campaign definitions do not match one-to-one.")
    }
    const exchangeRates = repository.table<GachaExchangeRates>("gacha_exchange_rate.json")
    if (Object.keys(exchangeRates).sort().join(",") !== "character,equipment") {
        throw new TypeError("Gacha exchange rate kinds are invalid.")
    }
    for (const [kind, rates] of Object.entries(exchangeRates)) {
        if (Object.keys(rates).sort().join(",") !== "3,4,5") {
            throw new TypeError(`${kind} exchange rate rarities are invalid.`)
        }
        for (const rarity of [3, 4, 5]) positiveInteger(rates[String(rarity)], `${kind} rarity ${rarity} exchange rate`)
    }
    return deepFreeze({
        banners,
        pools,
        campaigns,
        campaignIdsByGachaId,
        starsCampaigns,
        exchangeRates,
        exchangeableByGachaAndItem: exchangeable,
    })
}

const catalogs = new WeakMap<ReadonlyContentRepository, GachaCatalog>()

export function getGachaCatalog(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): GachaCatalog {
    const cached = catalogs.get(repository)
    if (cached !== undefined) return cached
    const catalog = buildGachaCatalog(repository)
    catalogs.set(repository, catalog)
    return catalog
}

export function resolveGachaCampaign(
    catalog: GachaCatalog,
    gachaId: number,
    nowMs: number,
    kind: 1 | 2,
): Readonly<GachaCampaignDefinition> | null {
    const candidates = (catalog.campaignIdsByGachaId[String(gachaId)] ?? [])
        .map(id => catalog.campaigns[String(id)])
        .filter(campaign => campaign.kind === kind && isGachaPeriodAvailable({
            availableFrom: campaign.availableFrom,
            availableUntil: campaign.availableUntil,
        }, nowMs))
    if (candidates.length > 1) throw new TypeError(`Gacha ${gachaId} has ambiguous active campaigns.`)
    return candidates[0] ?? null
}
