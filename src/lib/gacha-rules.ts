import { Gacha, GachaPoolItem, GachaType } from "./types";

export const GACHA_PAYMENT_TYPES = {
    FREE_VMONEY: 1,
    VMONEY: 2,
    TICKET: 3,
    CAMPAIGN: 4,
} as const;

export const GACHA_EXEC_TYPES = {
    VMONEY_SINGLE: 1,
    VMONEY_MULTI: 2,
    DAILY_SINGLE: 5,
    CAMPAIGN_SINGLE: 7,
    CAMPAIGN_MULTI: 8,
    MULTI_TICKET: 9,
    SINGLE_TICKET: 10,
    SINGLE_WEAPON_TICKET: 12,
    MULTI_WEAPON_TICKET: 13,
} as const;

export const GACHA_PAGE_KINDS = {
    NORMAL: 0,
    TEN_TIMES_PER_ACCOUNT: 1,
    TICKET_ONLY: 2,
    ONE_TIME_TICKET_ONLY: 3,
    TEN_TIMES_TICKET_ONLY: 4,
    CRAZY_TEN_TIMES_TICKET_ONLY: 5,
    ONE_TIME: 6,
    TEN_TIMES: 7,
    WITHOUT_DAILY: 8,
} as const;

export type TicketDrawKind = "single" | "multi";

export function getTicketDrawKind(type: number): TicketDrawKind | null {
    switch (type) {
        case GACHA_EXEC_TYPES.SINGLE_TICKET:
        case GACHA_EXEC_TYPES.SINGLE_WEAPON_TICKET:
            return "single";
        case GACHA_EXEC_TYPES.MULTI_TICKET:
        case GACHA_EXEC_TYPES.MULTI_WEAPON_TICKET:
            return "multi";
        default:
            return null;
    }
}

export function ticketExecMatchesGachaType(type: number, gacha: Pick<Gacha, "type">): boolean {
    if (gacha.type === GachaType.WEAPON) {
        return type === GACHA_EXEC_TYPES.SINGLE_WEAPON_TICKET ||
            type === GACHA_EXEC_TYPES.MULTI_WEAPON_TICKET;
    }
    return type === GACHA_EXEC_TYPES.SINGLE_TICKET ||
        type === GACHA_EXEC_TYPES.MULTI_TICKET;
}

function ticketAllowedByPageKind(pageKind: number | undefined, drawKind: TicketDrawKind): boolean {
    switch (pageKind) {
        case GACHA_PAGE_KINDS.ONE_TIME_TICKET_ONLY:
            return drawKind === "single";
        case GACHA_PAGE_KINDS.TEN_TIMES_TICKET_ONLY:
        case GACHA_PAGE_KINDS.CRAZY_TEN_TIMES_TICKET_ONLY:
            return drawKind === "multi";
        default:
            return true;
    }
}

export function isGachaExecAllowed(gacha: Gacha, paymentType: number, execType: number): boolean {
    const pageKind = gacha.pageKind ?? GACHA_PAGE_KINDS.NORMAL;
    const ticketDrawKind = getTicketDrawKind(execType);

    if (paymentType === GACHA_PAYMENT_TYPES.TICKET) {
        return ticketDrawKind !== null &&
            ticketExecMatchesGachaType(execType, gacha) &&
            ticketAllowedByPageKind(pageKind, ticketDrawKind);
    }

    switch (pageKind) {
        case GACHA_PAGE_KINDS.TICKET_ONLY:
        case GACHA_PAGE_KINDS.ONE_TIME_TICKET_ONLY:
        case GACHA_PAGE_KINDS.TEN_TIMES_TICKET_ONLY:
        case GACHA_PAGE_KINDS.CRAZY_TEN_TIMES_TICKET_ONLY:
            return false;
        case GACHA_PAGE_KINDS.WITHOUT_DAILY:
            return paymentType !== GACHA_PAYMENT_TYPES.VMONEY;
        case GACHA_PAGE_KINDS.ONE_TIME:
            return execType === GACHA_EXEC_TYPES.VMONEY_SINGLE ||
                execType === GACHA_EXEC_TYPES.CAMPAIGN_SINGLE;
        case GACHA_PAGE_KINDS.TEN_TIMES:
        case GACHA_PAGE_KINDS.TEN_TIMES_PER_ACCOUNT:
            return execType === GACHA_EXEC_TYPES.VMONEY_MULTI ||
                execType === GACHA_EXEC_TYPES.CAMPAIGN_MULTI;
        default:
            return true;
    }
}

export function getGachaPoolItem(gacha: Gacha, itemId: number): GachaPoolItem | null {
    for (const pool of Object.values(gacha.pool || {})) {
        const item = pool.find((candidate) => candidate.id === itemId);
        if (item) return item;
    }
    return null;
}

export function getExchangeableGachaItem(gacha: Gacha, itemId: number): GachaPoolItem | null {
    const item = getGachaPoolItem(gacha, itemId);
    return item?.isExchangeable ? item : null;
}
