import { Gacha } from "./types";
import { GACHA_EXEC_TYPES, getTicketDrawKind, ticketExecMatchesGachaType } from "./gacha-rules";

export const GACHA_TICKET_ITEM_IDS = {
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

function getFallbackTicketItemId(gacha: Gacha | undefined, type: number): number | null {
    if (gacha && !gacha.wildcardTicketAvailable) return null;

    switch (type) {
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

function getConfiguredTicketItemId(gacha: Gacha | undefined, type: number): number | null {
    if (!gacha) return getFallbackTicketItemId(undefined, type);
    if (!ticketExecMatchesGachaType(type, gacha)) return null;

    const drawKind = getTicketDrawKind(type);
    if (drawKind === "single" && gacha.onceTicketItemId) return gacha.onceTicketItemId;
    if (drawKind === "multi" && gacha.tenTicketItemId) return gacha.tenTicketItemId;

    return getFallbackTicketItemId(gacha, type);
}

export function getGachaTicketCost(type: number, numberOfExec: number, gacha?: Gacha): GachaTicketCost | null {
    const useTicketCount = Math.max(1, numberOfExec);
    const itemId = getConfiguredTicketItemId(gacha, type);
    if (itemId === null) return null;

    switch (type) {
        case GACHA_EXEC_TYPES.MULTI_TICKET:
        case GACHA_EXEC_TYPES.MULTI_WEAPON_TICKET:
            return {
                itemId,
                useTicketCount,
                pullCount: useTicketCount * 10,
            };
        case GACHA_EXEC_TYPES.SINGLE_TICKET:
        case GACHA_EXEC_TYPES.SINGLE_WEAPON_TICKET:
            return {
                itemId,
                useTicketCount,
                pullCount: useTicketCount,
            };
        default:
            return null;
    }
}
