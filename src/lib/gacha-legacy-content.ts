import type { ReadonlyContentRepository } from "../content/runtime/content-snapshot"
import type {
    CharacterGacha,
    Gacha,
    GachaPools,
    GachaRuntimeBanner,
    GachaRuntimeBanners,
    Gachas,
} from "./types/gacha"
import { GachaType } from "./types/gacha"

function legacyCosts(page: GachaRuntimeBanner["page"]): Pick<
    Gacha,
    "singleCost" | "multiCost" | "discountCost" | "tenTimesPerAccountCost"
> {
    switch (page.kind) {
        case 0:
            return {
                singleCost: page.singleCost,
                multiCost: page.multiCost,
                discountCost: page.dailyPaidCost,
            }
        case 1:
            return {
                singleCost: 0,
                multiCost: 0,
                discountCost: 0,
                tenTimesPerAccountCost: page.accountPaidTenCost,
            }
        case 8:
            return {
                singleCost: page.singleCost,
                multiCost: page.multiCost,
                discountCost: 0,
            }
        default:
            return { singleCost: 0, multiCost: 0, discountCost: 0 }
    }
}

function projectLegacyGacha(
    banner: GachaRuntimeBanner,
    pools: GachaPools,
): Gacha {
    const pool = Object.fromEntries(Object.entries(banner.poolOddsIds).map(([rank, oddsId]) => {
        const items = pools[oddsId]
        if (items === undefined) throw new TypeError(`Gacha references missing pool ${oddsId}.`)
        return [rank, items]
    }))
    const common = {
        name: banner.name,
        paymentType: 0,
        pageKind: banner.page.kind,
        ...legacyCosts(banner.page),
        ...(banner.onceTicketItemId === undefined ? {} : {
            onceTicketItemId: banner.onceTicketItemId,
        }),
        ...(banner.tenTicketItemId === undefined ? {} : {
            tenTicketItemId: banner.tenTicketItemId,
        }),
        ...(banner.crazyTenTicketItemId === undefined ? {} : {
            crazyTenTicketItemId: banner.crazyTenTicketItemId,
        }),
        wildcardTicketAvailable: banner.wildcardTicketAvailable,
        rarityOddsId: banner.rarityOddsId,
        guaranteeRarity: banner.guaranteeRarity,
        guaranteeNumber: banner.guaranteeNumber,
        rankRates: banner.rankRates,
        startDate: banner.startDate,
        endDate: banner.endDate,
        ...(banner.ticketExpiryTime === undefined ? {} : {
            ticketExpiryTime: banner.ticketExpiryTime,
        }),
        showPeriod: banner.showPeriod,
        isComeback: banner.isComeback,
        isStarsGacha: banner.isStarsGacha,
        freemiumGuaranteeAvailable: banner.freemiumGuaranteeAvailable,
        poolOddsIds: banner.poolOddsIds,
        pool,
    }
    if (banner.kind === "equipment") {
        return {
            ...common,
            type: GachaType.WEAPON,
            equipmentMovieProbabilityId: banner.equipmentMovieProbabilityId,
        }
    }
    const character: CharacterGacha = {
        ...common,
        type: GachaType.CHARACTER,
        movieName: banner.movieName,
        guaranteeMovieName: banner.guaranteeMovieName,
        toUseOddsUpAsTrialReading: banner.toUseOddsUpAsTrialReading,
        canBeStartDashExchange: banner.canBeStartDashExchange,
    }
    return character
}

const legacyByRepository = new WeakMap<ReadonlyContentRepository, Gachas>()

/** Temporary compatibility view for pre-D20 callers. It never copies prize arrays. */
export function getLegacyGachas(repository: ReadonlyContentRepository): Gachas {
    const cached = legacyByRepository.get(repository)
    if (cached !== undefined) return cached
    const banners = repository.table<GachaRuntimeBanners>("gacha.json")
    const pools = repository.table<GachaPools>("gacha_pool.json")
    const projected = Object.fromEntries(Object.entries(banners).map(([id, banner]) => [
        id,
        projectLegacyGacha(banner, pools),
    ]))
    legacyByRepository.set(repository, projected)
    return projected
}
