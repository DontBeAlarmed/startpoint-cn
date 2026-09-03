import { insertMailSync, MailType } from "../data/domains/mail"
import { getDb } from "../data/db"
import { clientSerializeDate } from "../data/utils/date"
import { getVirtualNow } from "../runtime/time/game-time"

const OVERFLOW_MAIL_TTL_DAYS = 31
const MAX_MAIL_ATTACHMENT_NUMBER = 2_147_483_647

export class MailOverflowValidationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "MailOverflowValidationError"
    }
}

export interface OverflowMailResult {
    readonly mailId: number
    readonly type: MailType.ITEM | MailType.FREE_MANA
    readonly typeId: number | null
    readonly number: number
    readonly createTime: string
    readonly rewardLimitTime: string
}

function positiveInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new MailOverflowValidationError(`${field} must be a positive safe integer`)
    }
    return value
}

function attachmentNumber(value: unknown): number {
    const number = positiveInteger(value, "number")
    if (number > MAX_MAIL_ATTACHMENT_NUMBER) {
        throw new MailOverflowValidationError(
            `number must not exceed ${MAX_MAIL_ATTACHMENT_NUMBER}`,
        )
    }
    return number
}

function requireActiveTransaction(): void {
    if (!getDb().inTransaction) {
        throw new MailOverflowValidationError(
            "overflow mail creation requires an active transaction",
        )
    }
}

function requireDate(value: Date): Date {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new MailOverflowValidationError("now must be a valid Date")
    }
    return value
}

function insertOverflowMail(
    playerId: number,
    type: MailType.ITEM | MailType.FREE_MANA,
    typeId: number | null,
    number: number,
    now: Date,
): OverflowMailResult {
    requireActiveTransaction()
    const normalizedPlayerId = positiveInteger(playerId, "playerId")
    const normalizedNumber = attachmentNumber(number)
    const normalizedNow = requireDate(now)
    if (type === MailType.ITEM) {
        if (typeId === null) {
            throw new MailOverflowValidationError("Item overflow mail requires typeId")
        }
        positiveInteger(typeId, "typeId")
    } else if (typeId !== null) {
        throw new MailOverflowValidationError("Mana overflow mail must not have typeId")
    }

    const createTime = clientSerializeDate(normalizedNow)
    const rewardLimitTime = clientSerializeDate(new Date(
        normalizedNow.getTime() + OVERFLOW_MAIL_TTL_DAYS * 24 * 60 * 60 * 1000,
    ))
    const mailId = insertMailSync(normalizedPlayerId, {
        reason_id: 0,
        subject: null,
        description: null,
        type,
        type_id: typeId,
        number: normalizedNumber,
        receive_time: "0000-00-00 00:00:00",
        create_time: createTime,
        reward_period_limited: 1,
        reward_limit_time: rewardLimitTime,
    })
    return Object.freeze({
        mailId,
        type,
        typeId,
        number: normalizedNumber,
        createTime,
        rewardLimitTime,
    })
}

export function insertItemOverflowMailWithinTransactionSync(
    playerId: number,
    itemId: number,
    number: number,
    now: Date = getVirtualNow(),
): OverflowMailResult {
    return insertOverflowMail(playerId, MailType.ITEM, positiveInteger(itemId, "itemId"), number, now)
}

export function insertManaOverflowMailWithinTransactionSync(
    playerId: number,
    number: number,
    now: Date = getVirtualNow(),
): OverflowMailResult {
    return insertOverflowMail(playerId, MailType.FREE_MANA, null, number, now)
}
