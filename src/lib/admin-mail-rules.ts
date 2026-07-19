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

const ITEM_RULES: Array<{ test: (itemId: number) => boolean; rule: MailAttachmentRule }> = [
    {
        test: itemId => itemId >= 100 && itemId < 1000,
        rule: { min: 1, max: 99, label: "消耗品", reason: "体力药等消耗品采用较低持有上限" },
    },
    {
        test: itemId => itemId > 0 && itemId < 100000,
        rule: { min: 1, max: 999, label: "素材", reason: "元素、结晶和升级素材按 999 封顶" },
    },
    {
        test: itemId => itemId >= 100000 && itemId < 1000000,
        rule: { min: 1, max: 99999, label: "锻造石 / 特殊魂珠", reason: "高频资源按 99999 封顶" },
    },
    {
        test: itemId => itemId >= 1000000,
        rule: { min: 1, max: 999999, label: "活动币 / 装备魂珠", reason: "长期累计资源按 999999 封顶" },
    },
]

export function mailTypeNeedsTypeId(mailType: number): boolean {
    return TYPE_IDS_REQUIRED.has(mailType)
}

export function getMailAttachmentRule(mailType: number, typeId: number | null = null): MailAttachmentRule {
    if (mailType === 5 || mailType === 6) return SINGLE_RULE
    if (mailType !== 1 || typeId === null) return DEFAULT_RULE
    return ITEM_RULES.find(({ test }) => test(typeId))?.rule ?? DEFAULT_RULE
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
}): ValidationResult<MailAttachmentRule> {
    const needsTypeId = mailTypeNeedsTypeId(input.mailType)
    if (needsTypeId && input.typeId === null) {
        return { ok: false, error: "此附件类型需要填写附件 ID" }
    }
    if (!needsTypeId && input.typeId !== null) {
        return { ok: false, error: "此附件类型不需要附件 ID" }
    }

    const rule = getMailAttachmentRule(input.mailType, input.typeId)
    if (input.count < rule.min || input.count > rule.max) {
        if (rule.max === 1) {
            return { ok: false, error: `${rule.reason}` }
        }
        return { ok: false, error: `${rule.label}数量最多 ${rule.max}（${rule.reason}）` }
    }

    return { ok: true, value: rule }
}
