import type { ReadonlyContentRepository } from "../content/runtime/content-snapshot"
import { getGachaCatalog } from "./gacha-catalog"
import type { GachaBanner, GachaCatalog } from "./gacha-catalog"
import type {
    CharacterGacha,
    Gacha,
    GachaRuntimeBanner,
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
    catalogBanner: GachaBanner,
): Gacha {
    const banner: GachaRuntimeBanner = catalogBanner.definition
    const pool = Object.fromEntries(Object.entries(catalogBanner.poolsByRank).map(
        ([rank, weightedPool]) => [rank, weightedPool.items],
    ))
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

const legacyByCatalog = new WeakMap<GachaCatalog, Gachas>()

/** Temporary compatibility view for pre-D20 callers. It never copies prize arrays. */
export function getLegacyGachas(repository: ReadonlyContentRepository): Gachas {
    const catalog = getGachaCatalog(repository)
    const cached = legacyByCatalog.get(catalog)
    if (cached !== undefined) return cached
    const projected = Object.fromEntries(Object.entries(catalog.banners).map(([id, banner]) => [
        id,
        projectLegacyGacha(banner),
    ]))
    legacyByCatalog.set(catalog, projected)
    return projected
}
