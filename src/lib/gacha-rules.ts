import { Gacha, GachaPoolItem, GachaRuntimeBanner, GachaType } from "./types";

export const GACHA_PAYMENT_TYPES = {
    FREE_VMONEY: 1,
    VMONEY: 2,
    TICKET: 3,
    CAMPAIGN: 4,
} as const;

export const GACHA_EXEC_TYPES = {
    VMONEY_SINGLE: 1,
    VMONEY_MULTI: 2,
    SINGLE_CONFIGURED_TICKET: 3,
    MULTI_CONFIGURED_TICKET: 4,
    DAILY_SINGLE: 5,
    ACCOUNT_PAID_MULTI: 7,
    CAMPAIGN_MULTI: 8,
    MULTI_TICKET: 9,
    SINGLE_TICKET: 10,
    SINGLE_WEAPON_TICKET: 12,
    MULTI_WEAPON_TICKET: 13,
    CRAZY_MULTI_TICKET: 14,
    SINGLE_RARE4_TICKET: 20,
    CAMPAIGN_SINGLE: 11,
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
        case GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET:
        case GACHA_EXEC_TYPES.SINGLE_RARE4_TICKET:
            return "single";
        case GACHA_EXEC_TYPES.MULTI_TICKET:
        case GACHA_EXEC_TYPES.MULTI_WEAPON_TICKET:
        case GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET:
        case GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET:
            return "multi";
        default:
            return null;
    }
}

type GachaExecDefinition = Gacha | GachaRuntimeBanner

function isEquipmentGacha(gacha: GachaExecDefinition): boolean {
    return "kind" in gacha ? gacha.kind === "equipment" : gacha.type === GachaType.WEAPON
}

function pageKindOf(gacha: GachaExecDefinition): number {
    return "kind" in gacha ? gacha.page.kind : (gacha.pageKind ?? GACHA_PAGE_KINDS.NORMAL)
}

function configuredTicketAvailable(gacha: GachaExecDefinition, type: number): boolean {
    switch (type) {
        case GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET:
            return gacha.onceTicketItemId !== undefined
        case GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET:
            return gacha.tenTicketItemId !== undefined
        case GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET:
            return gacha.crazyTenTicketItemId !== undefined
        default:
            return false
    }
}

function isConfiguredTicketType(type: number): boolean {
    return type === GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET
        || type === GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET
        || type === GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET
}

function ticketTypeAvailable(gacha: GachaExecDefinition, type: number): boolean {
    if (!ticketExecMatchesGachaType(type, gacha)) return false
    return isConfiguredTicketType(type)
        ? configuredTicketAvailable(gacha, type)
        : gacha.wildcardTicketAvailable === true
}

export function ticketExecMatchesGachaType(type: number, gacha: GachaExecDefinition): boolean {
    if (type === GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET
        || type === GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET) return true;
    if (isEquipmentGacha(gacha)) {
        return type === GACHA_EXEC_TYPES.SINGLE_WEAPON_TICKET ||
            type === GACHA_EXEC_TYPES.MULTI_WEAPON_TICKET;
    }
    return type === GACHA_EXEC_TYPES.SINGLE_TICKET ||
        type === GACHA_EXEC_TYPES.MULTI_TICKET ||
        type === GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET ||
        type === GACHA_EXEC_TYPES.SINGLE_RARE4_TICKET;
}

export function isGachaExecAllowed(gacha: GachaExecDefinition, paymentType: number, execType: number): boolean {
    const pageKind = pageKindOf(gacha);
    const ticketDrawKind = getTicketDrawKind(execType);

    const paymentMatches = paymentType === GACHA_PAYMENT_TYPES.FREE_VMONEY
        ? execType === GACHA_EXEC_TYPES.VMONEY_SINGLE || execType === GACHA_EXEC_TYPES.VMONEY_MULTI
        : paymentType === GACHA_PAYMENT_TYPES.VMONEY
            ? execType === GACHA_EXEC_TYPES.DAILY_SINGLE || execType === GACHA_EXEC_TYPES.ACCOUNT_PAID_MULTI
            : paymentType === GACHA_PAYMENT_TYPES.CAMPAIGN
                ? execType === GACHA_EXEC_TYPES.CAMPAIGN_SINGLE || execType === GACHA_EXEC_TYPES.CAMPAIGN_MULTI
                : paymentType === GACHA_PAYMENT_TYPES.TICKET && ticketDrawKind !== null;
    if (!paymentMatches) return false;

    switch (pageKind) {
        case GACHA_PAGE_KINDS.NORMAL:
            if (paymentType === GACHA_PAYMENT_TYPES.TICKET) {
                return execType !== GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET
                    && ticketTypeAvailable(gacha, execType)
            }
            return execType !== GACHA_EXEC_TYPES.ACCOUNT_PAID_MULTI
        case GACHA_PAGE_KINDS.TEN_TIMES_PER_ACCOUNT:
            return paymentType === GACHA_PAYMENT_TYPES.VMONEY
                && execType === GACHA_EXEC_TYPES.ACCOUNT_PAID_MULTI;
        case GACHA_PAGE_KINDS.TICKET_ONLY:
            return paymentType === GACHA_PAYMENT_TYPES.TICKET
                && (execType === GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET
                    || execType === GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET)
                && configuredTicketAvailable(gacha, execType)
        case GACHA_PAGE_KINDS.ONE_TIME_TICKET_ONLY:
            return paymentType === GACHA_PAYMENT_TYPES.TICKET
                && execType === GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET
                && configuredTicketAvailable(gacha, execType)
        case GACHA_PAGE_KINDS.TEN_TIMES_TICKET_ONLY:
            return paymentType === GACHA_PAYMENT_TYPES.TICKET
                && execType === GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET
                && configuredTicketAvailable(gacha, execType)
        case GACHA_PAGE_KINDS.CRAZY_TEN_TIMES_TICKET_ONLY:
            return paymentType === GACHA_PAYMENT_TYPES.TICKET
                && execType === GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET
                && !isEquipmentGacha(gacha)
        case GACHA_PAGE_KINDS.WITHOUT_DAILY:
            if (paymentType === GACHA_PAYMENT_TYPES.TICKET) {
                return execType !== GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET
                    && !isConfiguredTicketType(execType)
                    && ticketTypeAvailable(gacha, execType)
            }
            return paymentType !== GACHA_PAYMENT_TYPES.VMONEY
                && execType !== GACHA_EXEC_TYPES.ACCOUNT_PAID_MULTI;
        case GACHA_PAGE_KINDS.ONE_TIME:
        case GACHA_PAGE_KINDS.TEN_TIMES:
            return false;
        default:
            return false;
    }
}

export function isGachaExecCountAllowed(execType: number, numberOfExec: number): boolean {
    if (!Number.isSafeInteger(numberOfExec) || numberOfExec <= 0 || numberOfExec > 10) return false;
    const scalableSingle = execType === GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET
        || execType === GACHA_EXEC_TYPES.SINGLE_TICKET
        || execType === GACHA_EXEC_TYPES.SINGLE_WEAPON_TICKET;
    return scalableSingle || numberOfExec === 1;
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
