import { Gacha, GachaRuntimeBanner } from "./types";
import { GACHA_EXEC_TYPES, ticketExecMatchesGachaType } from "./gacha-rules";

export const GACHA_TICKET_ITEM_IDS = {
    characterOnceRare4: 999008,
    characterMulti: 999001,
    characterSingle: 999003,
    equipmentMulti: 999004,
    equipmentSingle: 999005,
} as const;

export interface GachaTicketCost {
    itemId: number;
    useTicketCount: number;
    pullCount: number;
}

type GachaTicketDefinition = Gacha | GachaRuntimeBanner

function getWildcardTicketItemId(gacha: GachaTicketDefinition | undefined, type: number): number | null {
    if (gacha && !gacha.wildcardTicketAvailable) return null;

    switch (type) {
        case GACHA_EXEC_TYPES.SINGLE_RARE4_TICKET:
            return GACHA_TICKET_ITEM_IDS.characterOnceRare4;
        case GACHA_EXEC_TYPES.MULTI_TICKET:
            return GACHA_TICKET_ITEM_IDS.characterMulti;
        case GACHA_EXEC_TYPES.SINGLE_TICKET:
            return GACHA_TICKET_ITEM_IDS.characterSingle;
        case GACHA_EXEC_TYPES.SINGLE_WEAPON_TICKET:
            return GACHA_TICKET_ITEM_IDS.equipmentSingle;
        case GACHA_EXEC_TYPES.MULTI_WEAPON_TICKET:
            return GACHA_TICKET_ITEM_IDS.equipmentMulti;
        default:
            return null;
    }
}

function getTicketItemId(gacha: GachaTicketDefinition | undefined, type: number): number | null {
    if (!gacha) return getWildcardTicketItemId(undefined, type);
    if (!ticketExecMatchesGachaType(type, gacha)) return null;

    switch (type) {
        case GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET:
            return gacha.onceTicketItemId ?? null
        case GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET:
            return gacha.tenTicketItemId ?? null
        case GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET:
            return gacha.crazyTenTicketItemId ?? null
        default:
            return getWildcardTicketItemId(gacha, type)
    }
}

export function getGachaTicketCost(
    type: number,
    numberOfExec: number,
    gacha?: GachaTicketDefinition,
): GachaTicketCost | null {
    if (!Number.isSafeInteger(numberOfExec) || numberOfExec <= 0) return null;
    const scalableSingle = type === GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET
        || type === GACHA_EXEC_TYPES.SINGLE_TICKET
        || type === GACHA_EXEC_TYPES.SINGLE_WEAPON_TICKET;
    if (scalableSingle ? numberOfExec > 10 : numberOfExec !== 1) return null;
    const useTicketCount = numberOfExec;
    const itemId = getTicketItemId(gacha, type);
    if (itemId === null) return null;

    switch (type) {
        case GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET:
        case GACHA_EXEC_TYPES.MULTI_TICKET:
        case GACHA_EXEC_TYPES.MULTI_WEAPON_TICKET:
        case GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET:
            return {
                itemId,
                useTicketCount,
                pullCount: useTicketCount * 10,
            };
        case GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET:
        case GACHA_EXEC_TYPES.SINGLE_TICKET:
        case GACHA_EXEC_TYPES.SINGLE_WEAPON_TICKET:
        case GACHA_EXEC_TYPES.SINGLE_RARE4_TICKET:
            return {
                itemId,
                useTicketCount,
                pullCount: useTicketCount,
            };
        default:
            return null;
    }
}
