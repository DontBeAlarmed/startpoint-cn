import type { GachaBanner, GachaPeriod } from "../gacha-catalog"
import { parseGachaJstTimestamp } from "../gacha-catalog"
import { GACHA_EXEC_TYPES } from "../gacha-rules"
import { getGachaTicketCost } from "../gacha-ticket"
import { getPlayerGachaExecutionStateSync } from "./player-period"

const CHARACTER_TICKET_EXEC_TYPES = [
    GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET,
    GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET,
    GACHA_EXEC_TYPES.SINGLE_TICKET,
    GACHA_EXEC_TYPES.MULTI_TICKET,
    GACHA_EXEC_TYPES.SINGLE_RARE4_TICKET,
    GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET,
] as const

const EQUIPMENT_TICKET_EXEC_TYPES = [
    GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET,
    GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET,
    GACHA_EXEC_TYPES.SINGLE_WEAPON_TICKET,
    GACHA_EXEC_TYPES.MULTI_WEAPON_TICKET,
] as const

export function getGachaExtensionTicketIds(banner: GachaBanner): number[] {
    const execTypes = banner.kind === "character"
        ? CHARACTER_TICKET_EXEC_TYPES
        : EQUIPMENT_TICKET_EXEC_TYPES
    return [...new Set(execTypes.flatMap(execType => {
        const ticket = getGachaTicketCost(execType, 1, banner.definition)
        return ticket === null ? [] : [ticket.itemId]
    }))].sort((left, right) => left - right)
}

export function resolveGachaPlayerBasePeriodSync(
    playerId: number,
    banner: GachaBanner,
): GachaPeriod | undefined {
    if (!banner.definition.isComeback && !banner.definition.isStarsGacha) {
        return banner.basePeriod
    }
    return getPlayerGachaExecutionStateSync(playerId, banner).effectivePeriod
}

export function hasRemainingGachaPathSync(input: {
    readonly playerId: number
    readonly banner: GachaBanner
    readonly nowMs: number
    readonly getTicketCount: (itemId: number) => number
}): boolean {
    const base = resolveGachaPlayerBasePeriodSync(input.playerId, input.banner)
    if (base === undefined) return false
    if (input.nowMs <= parseGachaJstTimestamp(base.availableUntil)) {
        return true
    }
    if (input.banner.ticketExpiryTime === undefined
        || input.nowMs > parseGachaJstTimestamp(input.banner.ticketExpiryTime)) {
        return false
    }
    return getGachaExtensionTicketIds(input.banner).some(itemId => input.getTicketCount(itemId) > 0)
}
