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

export function getMailAttachmentRule(mailType: number | undefined, typeId: number | null | undefined): MailAttachmentRule {
    if (mailType === 5 || mailType === 6) return SINGLE_RULE
    if (mailType !== 1 || typeId == null) return DEFAULT_RULE
    return ITEM_RULES.find(({ test }) => test(typeId))?.rule ?? DEFAULT_RULE
}
