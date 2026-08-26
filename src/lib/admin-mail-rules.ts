export const ADMIN_MAIL_MAX_INT = 2147483647

export interface MailAttachmentRule {
    min: number
    max: number
    label: string
    reason: string
}

export interface ParseIntegerOptions {
    min?: number
    max?: number
    allowNull?: boolean
}

export type ValidationResult<T = void> =
    | { ok: true; value: T }
    | { ok: false; error: string }

const TYPE_IDS_REQUIRED = new Set([1, 5, 6])

const DEFAULT_RULE: MailAttachmentRule = {
    min: 1,
    max: ADMIN_MAIL_MAX_INT,
    label: "通用资源",
    reason: "使用 int32 安全范围",
}

const SINGLE_RULE: MailAttachmentRule = {
    min: 1,
    max: 1,
    label: "唯一附件",
    reason: "角色 / 装备每封邮件只能发送 1 个",
}

export function mailTypeNeedsTypeId(mailType: number): boolean {
    return TYPE_IDS_REQUIRED.has(mailType)
}

export function getMailAttachmentRule(
    mailType: number,
    typeId: number | null = null,
    itemMaxCount?: number,
): MailAttachmentRule {
    if (mailType === 5 || mailType === 6) return SINGLE_RULE
    if (mailType !== 1 || typeId === null) return DEFAULT_RULE
    if (!Number.isSafeInteger(itemMaxCount) || (itemMaxCount ?? 0) < 1) return DEFAULT_RULE
    return {
        min: 1,
        max: itemMaxCount as number,
        label: "道具",
        reason: "使用 CDN 官方持有上限",
    }
}

export function parseAdminMailInteger(
    raw: unknown,
    label: string,
    options: ParseIntegerOptions = {},
): ValidationResult<number | null> {
    if (raw === null || raw === undefined || raw === "") {
        if (options.allowNull) return { ok: true, value: null }
        return { ok: false, error: `${label}不能为空` }
    }

    const text = typeof raw === "number" ? String(raw) : String(raw).trim()
    if (!/^[0-9]+$/.test(text)) {
        return { ok: false, error: `${label}必须是整数` }
    }

    const value = Number(text)
    if (!Number.isSafeInteger(value)) {
        return { ok: false, error: `${label}超出安全整数范围` }
    }

    const min = options.min ?? 0
    const max = options.max ?? ADMIN_MAIL_MAX_INT
    if (value < min || value > max) {
        return { ok: false, error: `${label}超出范围（需 ${min}-${max}）` }
    }

    return { ok: true, value }
}

export function validateMailAttachment(input: {
    mailType: number
    typeId: number | null
    count: number
    itemMaxCount?: number
}): ValidationResult<MailAttachmentRule> {
    const needsTypeId = mailTypeNeedsTypeId(input.mailType)
    if (needsTypeId && input.typeId === null) {
        return { ok: false, error: "此附件类型需要填写附件 ID" }
    }
    if (!needsTypeId && input.typeId !== null) {
        return { ok: false, error: "此附件类型不需要附件 ID" }
    }

    if (input.mailType === 1
        && (!Number.isSafeInteger(input.itemMaxCount) || (input.itemMaxCount ?? 0) < 1)) {
        return { ok: false, error: `道具 ${input.typeId} 缺少 CDN 官方持有上限` }
    }

    const rule = getMailAttachmentRule(input.mailType, input.typeId, input.itemMaxCount)
    if (input.count < rule.min || input.count > rule.max) {
        if (rule.max === 1) {
            return { ok: false, error: `${rule.reason}` }
        }
        return { ok: false, error: `${rule.label}数量最多 ${rule.max}（${rule.reason}）` }
    }

    return { ok: true, value: rule }
}
