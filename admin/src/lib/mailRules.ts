export interface MailAttachmentRule {
    min: number
    max: number
    label: string
    reason: string
}

const MAX_INT = 2147483647

const DEFAULT_RULE: MailAttachmentRule = {
    min: 1,
    max: MAX_INT,
    label: "通用资源",
    reason: "使用 int32 安全范围",
}

const SINGLE_RULE: MailAttachmentRule = {
    min: 1,
    max: 1,
    label: "唯一附件",
    reason: "角色 / 装备每封邮件只能发送 1 个",
}

export function getMailAttachmentRule(
    mailType: number | undefined,
    typeId: number | null | undefined,
    itemMaxCount?: number,
): MailAttachmentRule {
    if (mailType === 5 || mailType === 6) return SINGLE_RULE
    if (mailType !== 1 || typeId == null) return DEFAULT_RULE
    if (!Number.isSafeInteger(itemMaxCount) || (itemMaxCount ?? 0) < 1) return DEFAULT_RULE
    return {
        min: 1,
        max: itemMaxCount as number,
        label: "道具",
        reason: "使用 CDN 官方持有上限",
    }
}
