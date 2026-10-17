import { MailType, insertMailSync } from "../data/domains/mail"
import { getScheduledResourceRuleSync } from "../data/domains/scheduled-resource"
import { clientSerializeDate } from "../data/utils/date"

const NOTICE_SUBJECT = "每日资源自动发放"
const NOTICE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 自动补货提醒（唯一通道）：发放成功的同事务后插入一封无附件信息邮件。
 *
 * - reason_id = 0：不在客户端 Reason 主表中（官方表键从 2 起），客户端回退
 *   渲染服务端 subject/description 原文（MailReasonLogic 回退路径，已核）。
 * - 正文走规则描述（管理后台配置规则时的 description），不做道具名投影
 *   （服务端内容快照无 item 文本表）。
 * - 1 天限时：纯通知零价值，过期清扫即消失；红点（mail_arrived 动态计数）
 *   在限期内持续可见。
 * - number = 0 的 FREE_VMONEY 附件：领取路径的零值语义由套件实证兜底。
 */
export function insertScheduledResourceNoticeMailSync(
    playerId: number,
    grantedRuleIds: readonly number[],
    now: Date,
    dailyResetHour: number,
): number {
    const ruleLines = grantedRuleIds
        .map(ruleId => getScheduledResourceRuleSync(ruleId)?.description)
        .filter((description): description is string => Boolean(description))
    const bodyLines = ruleLines.length > 0
        ? ruleLines
        : ["今日的自动发放已完成，可在「菜单 → 所持品」确认到账资源。"]
    const nextReset = new Date(now.getTime() + NOTICE_TTL_MS)
    const description = [
        ...bodyLines,
        "",
        `发放时间：${clientSerializeDate(now)}`,
        `每日 ${dailyResetHour}:00 后登录即可再次补充`,
    ].join("\n")

    return insertMailSync(playerId, {
        reason_id: 0,
        subject: NOTICE_SUBJECT,
        description,
        type: MailType.FREE_VMONEY,
        type_id: null,
        number: 0,
        receive_time: "0000-00-00 00:00:00",
        create_time: clientSerializeDate(now),
        reward_period_limited: 1,
        reward_limit_time: clientSerializeDate(nextReset),
    })
}
