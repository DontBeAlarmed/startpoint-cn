import { useMemo, useRef, useState } from "react"
import { Alert, Button, Card, Empty, Input, Pagination, Segmented, Space, Tag, Typography, message } from "antd"
import { UndoOutlined } from "@ant-design/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import dayjs, { type Dayjs } from "dayjs"
import { apiGet } from "../api/client"
import { AdminPage } from "../components/AdminPage"

// 触屏设备: 段输入压掉软键盘, 用 ± 按钮调整 (桌面键盘流不受影响)。
// 取舍: 模块级一次性检测, 2-in-1 设备运行中拆/接键盘不重估——双向降级均可接受(复审B 记录)
const coarsePointer = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true

interface ServerTime {
    servertime: number
    date: string
    isCustom: boolean
}

interface ClairvoyanceCharacter {
    id: number
    name: string
    title: string
    rarity: number | null
    element: number | null
}

interface ClairvoyanceGacha {
    id: number
    name: string
    type: "character"
    pageKind: number
    startDate: string
    endDate: string
    durationDays: number
    rateUpCharacters: ClairvoyanceCharacter[]
}

interface ClairvoyanceSearchRow {
    characterId: number
    name: string
    title: string
    gachas: Array<Pick<ClairvoyanceGacha, "id" | "name" | "startDate" | "endDate">>
}

interface ClairvoyanceGachaTimeline {
    cdnVersion: string
    baseline: string
    scope: "short-up-character-gacha"
    currentTime: string
    current: ClairvoyanceGacha[]
    timeline: ClairvoyanceGacha[]
    searchIndex: ClairvoyanceSearchRow[]
}

interface AdminActivityEvent {
    eventId: number
    family: string
    familyLabel: string
    stringId: string
    name: string
    startTime: string
    activeEndTime: string | null
    closeEndTime: string | null
}

interface AdminActivitySearchRow {
    eventId: number
    family: string
    familyLabel: string
    stringId: string
    name: string
    aliases: string[]
}

interface ClairvoyanceActivityTimeline {
    cdnVersion: string
    baseline: string
    scope: "event-quest"
    currentTime: string
    timeline: AdminActivityEvent[]
    searchIndex: AdminActivitySearchRow[]
}

type SegmentKey = "year" | "month" | "day" | "hour" | "minute" | "second"

const timeSegments: { key: SegmentKey; label: string; digits: number }[] = [
    { key: "year", label: "年", digits: 4 },
    { key: "month", label: "月", digits: 2 },
    { key: "day", label: "日", digits: 2 },
    { key: "hour", label: "时", digits: 2 },
    { key: "minute", label: "分", digits: 2 },
    { key: "second", label: "秒", digits: 2 },
]

type DraftSegments = Record<SegmentKey, string>

function padSegment(value: number, digits: number): string {
    return String(value).padStart(digits, "0")
}

function maxDayOfMonth(year: number, month: number): number {
    return dayjs(`${padSegment(year, 4)}-${padSegment(month, 2)}-01`).daysInMonth()
}

function wrapNumber(value: number, min: number, max: number): number {
    if (value > max) return min
    if (value < min) return max
    return value
}

function clampNumber(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

function segmentValue(date: Dayjs, key: SegmentKey): number {
    if (key === "year") return date.year()
    if (key === "month") return date.month() + 1
    if (key === "day") return date.date()
    if (key === "hour") return date.hour()
    if (key === "minute") return date.minute()
    return date.second()
}

function formatDraft(date: Dayjs): DraftSegments {
    return {
        year: padSegment(date.year(), 4),
        month: padSegment(date.month() + 1, 2),
        day: padSegment(date.date(), 2),
        hour: padSegment(date.hour(), 2),
        minute: padSegment(date.minute(), 2),
        second: padSegment(date.second(), 2),
    }
}

function buildDateFromParts(year: number, month: number, day: number, hour: number, minute: number, second: number): Dayjs {
    return dayjs(`${padSegment(year, 4)}-${padSegment(month, 2)}-${padSegment(day, 2)}T${padSegment(hour, 2)}:${padSegment(minute, 2)}:${padSegment(second, 2)}`)
}

function normalizeSearch(value: string): string {
    return value.normalize("NFKC").trim().toLowerCase()
}

function renderGachaPeriod(gacha: Pick<ClairvoyanceGacha, "startDate" | "endDate">): string {
    return `${gacha.startDate} - ${gacha.endDate}`
}

// CDN 卡池日期是 +08:00 的裸字符串，currentTime 是 UTC ISO —— 解析口径与服务端 parseCdnDate 保持一致
function parseCdnInstant(value: string): number {
    return new Date(`${value.replace(" ", "T")}+08:00`).getTime()
}

type GachaLiveState = "live" | "ended" | "upcoming"

function gachaLiveState(gacha: Pick<ClairvoyanceGacha, "startDate" | "endDate">, nowIso: string): GachaLiveState {
    const now = Date.parse(nowIso)
    const start = parseCdnInstant(gacha.startDate)
    const end = parseCdnInstant(gacha.endDate)
    if (!Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(end)) return "upcoming"
    if (now < start) return "upcoming"
    if (now > end) return "ended"
    return "live"
}

function renderGachaStatusBadge(gacha: Pick<ClairvoyanceGacha, "startDate" | "endDate">, nowIso: string | undefined) {
    if (!nowIso) return null
    const state = gachaLiveState(gacha, nowIso)
    if (state === "live") return <span className="admin-badge-ok">上线中</span>
    if (state === "ended") return <span className="admin-badge-warn">已结束</span>
    return <span className="admin-badge-info">未开始</span>
}

function renderRemainingDays(gacha: Pick<ClairvoyanceGacha, "startDate" | "endDate">, nowIso: string | undefined): string {
    if (!nowIso) return ""
    const now = Date.parse(nowIso)
    const start = parseCdnInstant(gacha.startDate)
    const end = parseCdnInstant(gacha.endDate)
    if (!Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(end)) return ""
    const dayMs = 86_400_000
    if (now < start) return `${Math.ceil((start - now) / dayMs)} 天后开始`
    if (now > end) return `已于 ${Math.ceil((now - end) / dayMs)} 天前结束`
    return `剩余 ${Math.ceil((end - now) / dayMs)} 天`
}

// ── 活动日程（千里眼第二页签）──────────────────────────────────────────────
// 服务端输出的是游戏日历（默认 +08:00）墙钟换算后的绝对 ISO 时刻；
// 展示回墙钟用固定时区格式化，不随宿主机时区漂移。
const gameWallTimeFormatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
})

function formatGameWallTime(iso: string): string {
    return gameWallTimeFormatter.format(new Date(iso)).replace("T", " ")
}

// 卡片核心信息：绝对起止（同年省略尾端年份，「2020-01-01 12:00 ~ 01-10 11:59」）
function renderCompactPeriod(startWall: string, endWall: string | null): string {
    return `${startWall.slice(0, 16)} ~ ${endWall === null ? "长期" : endWall.slice(5, 16)}`
}

function renderGachaCompactPeriod(gacha: Pick<ClairvoyanceGacha, "startDate" | "endDate">): string {
    return renderCompactPeriod(gacha.startDate, gacha.endDate)
}

function renderActivityCompactPeriod(activity: Pick<AdminActivityEvent, "startTime" | "activeEndTime">): string {
    return renderCompactPeriod(
        formatGameWallTime(activity.startTime),
        activity.activeEndTime === null ? null : formatGameWallTime(activity.activeEndTime),
    )
}

function activityKey(activity: Pick<AdminActivityEvent, "family" | "eventId">): string {
    return `${activity.family}:${activity.eventId}`
}

function renderGachaStartCountdown(gacha: Pick<ClairvoyanceGacha, "startDate">, nowIso: string | undefined): string {
    if (!nowIso) return ""
    const now = Date.parse(nowIso)
    const start = parseCdnInstant(gacha.startDate)
    if (!Number.isFinite(now) || !Number.isFinite(start) || now >= start) return ""
    return `${Math.ceil((start - now) / 86_400_000)} 天后开始`
}

// 近期卡池段的状态徽章：进行中=ok / 预告=info（区别于搜索/时间线的三态徽章）
function renderPoolCardBadge(gacha: Pick<ClairvoyanceGacha, "startDate" | "endDate">, nowIso: string | undefined) {
    if (!nowIso) return null
    const now = Date.parse(nowIso)
    const start = parseCdnInstant(gacha.startDate)
    const end = parseCdnInstant(gacha.endDate)
    if (!Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(end)) return null
    if (now > end) return <span className="admin-badge-warn">已结束</span>
    if (now >= start) return <span className="admin-badge-ok">进行中</span>
    return <span className="admin-badge-info">预告</span>
}

// ── 时间线统一单列条目（维护者指定 timeline-unified-list.html）────────────────
// 行1 标题|#id(|活动类型徽章) · 行2 时间+状态 · 行3 内容(仅卡池: UP 角色芯片行, 不再 +N 折叠)
// 分页浏览（维护者指定: 展开按钮改为分页）, 每页 4 项
const TIMELINE_PAGE_SIZE = 4

function renderUpCharacterChips(characters: ClairvoyanceCharacter[]) {
    return (
        <div className="admin-tl-up-row">
            {characters.map(character => (
                <span key={character.id} className="admin-tl-up-chip">
                    <span className="admin-tl-up-av" aria-hidden>
                        {character.name.slice(0, 1)}
                        <img
                            className="admin-tl-up-av-img"
                            src={`/api/content/character_avatar/${character.id}`}
                            alt=""
                            loading="lazy"
                            onError={event => {
                                event.currentTarget.classList.add("admin-tl-up-av-broken")
                            }}
                        />
                    </span>
                    <span className="admin-tl-up-meta">
                        <span className="admin-tl-up-id">#{character.id}</span>
                        <span className="admin-tl-up-name">{character.name}</span>
                    </span>
                </span>
            ))}
        </div>
    )
}

// 活动类型配色: 按族标签关键词映射, 未识别族回退 info 蓝
function activityFamilyBadgeClass(label: string): string {
    if (label.includes("故事")) return "admin-tl-family admin-tl-family-story"
    if (label.includes("讨伐")) return "admin-tl-family admin-tl-family-battle"
    if (label.includes("大型")) return "admin-tl-family admin-tl-family-large"
    if (label.includes("通关") || label.includes("累计") || label.includes("登录")) return "admin-tl-family admin-tl-family-clear"
    return "admin-tl-family admin-tl-family-other"
}

// 近期活动段的状态徽章：与卡池段对称（未开始只出现在数据迟到时）
function renderActivityCardBadge(activity: Pick<AdminActivityEvent, "startTime" | "activeEndTime" | "closeEndTime">, upcoming: boolean, nowIso: string | undefined) {
    if (upcoming) return <span className="admin-badge-info">预告</span>
    return renderActivityStatusBadge(activity, nowIso)
}

type ActivityLiveState = "live" | "exchanging" | "ended" | "upcoming"

function activityLiveState(
    activity: Pick<AdminActivityEvent, "startTime" | "activeEndTime" | "closeEndTime">,
    nowIso: string,
): ActivityLiveState {
    const now = Date.parse(nowIso)
    const start = Date.parse(activity.startTime)
    const activeEnd = activity.activeEndTime === null ? null : Date.parse(activity.activeEndTime)
    const closeEnd = activity.closeEndTime === null ? null : Date.parse(activity.closeEndTime)
    if (!Number.isFinite(now) || !Number.isFinite(start)) return "upcoming"
    if (now < start) return "upcoming"
    if (activeEnd === null || now <= activeEnd) return "live"
    if (closeEnd === null || now <= closeEnd) return "exchanging"
    return "ended"
}

function renderActivityStatusBadge(activity: Pick<AdminActivityEvent, "startTime" | "activeEndTime" | "closeEndTime">, nowIso: string | undefined) {
    if (!nowIso) return null
    const state = activityLiveState(activity, nowIso)
    if (state === "live") return <span className="admin-badge-ok">进行中</span>
    if (state === "exchanging") return <span className="admin-badge-warn">换牌期</span>
    if (state === "ended") return <span className="admin-badge-warn">已结束</span>
    return <span className="admin-badge-info">未开始</span>
}

function renderActivityRemainingDays(activity: Pick<AdminActivityEvent, "startTime" | "activeEndTime">, nowIso: string | undefined): string {
    if (!nowIso) return ""
    const now = Date.parse(nowIso)
    const start = Date.parse(activity.startTime)
    if (!Number.isFinite(now) || !Number.isFinite(start)) return ""
    const dayMs = 86_400_000
    if (now < start) return `${Math.ceil((start - now) / dayMs)} 天后开始`
    if (activity.activeEndTime === null) return "长期开放"
    const end = Date.parse(activity.activeEndTime)
    if (!Number.isFinite(end)) return ""
    if (now > end) return `已于 ${Math.ceil((now - end) / dayMs)} 天前结束`
    return `剩余 ${Math.ceil((end - now) / dayMs)} 天`
}

// 活动卡与卡池卡共用同一组 token（admin-clairvoyance-panel / admin-pool-*）
function renderActivityCard(activity: AdminActivityEvent, upcoming: boolean, nowIso: string | undefined) {
    const remaining = upcoming
        ? (nowIso
            ? `${Math.ceil((Date.parse(activity.startTime) - Date.parse(nowIso)) / 86_400_000)} 天后开始`
            : "")
        : renderActivityRemainingDays(activity, nowIso)
    return (
        <div key={activityKey(activity)} className="admin-clairvoyance-panel">
            <div className="admin-pool-top">
                <span className="admin-pool-name">{activity.name}</span>
                <Tag color="purple">{activity.familyLabel}</Tag>
                {renderActivityCardBadge(activity, upcoming, nowIso)}
                <span className="admin-pool-win admin-mono">{renderActivityCompactPeriod(activity)}</span>
                {remaining !== "" && <span className="admin-pool-remaining">{remaining}</span>}
            </div>
            <Space wrap size={[4, 4]}>
                <Typography.Text type="secondary">#{activity.eventId} {activity.stringId}</Typography.Text>
                {activity.closeEndTime !== null && (
                    <Typography.Text type="secondary">换牌截止 {formatGameWallTime(activity.closeEndTime)}</Typography.Text>
                )}
            </Space>
        </div>
    )
}

// UP 角色头像条目（维护者 2026-09-30 规格：头像块占两行 | 右上 id 灰 / 右下 角色名）。
// 头像走服务端 CDN 归档端点（character_avatar，immutable 内容寻址，日缓存）；
// 真实立绘覆盖缺失（助手角色等）时 onError 隐藏图片，露出底层首字占位。
// 属性特选等元素全池的 UP 角色可达 14-21 个 — 折叠为前 8 个 + 「+N」
const MAX_VISIBLE_RATE_UP = 8

function renderRateUpCharacters(
    characters: ClairvoyanceCharacter[],
    expanded: boolean,
    onToggleExpanded: () => void,
) {
    const visible = expanded ? characters : characters.slice(0, MAX_VISIBLE_RATE_UP)
    const rest = Math.max(0, characters.length - MAX_VISIBLE_RATE_UP)
    return (
        <div className="admin-char-cards">
            {visible.map(character => (
                <div key={character.id} className="admin-char-card">
                    <span className="admin-char-avatar" aria-hidden>
                        {character.name.slice(0, 1)}
                        <img
                            className="admin-char-avatar-image"
                            src={`/api/content/character_avatar/${character.id}`}
                            alt=""
                            loading="lazy"
                            onError={event => {
                                event.currentTarget.classList.add("admin-char-avatar-image-broken")
                            }}
                        />
                    </span>
                    <span className="admin-char-meta">
                        <span className="admin-char-id">#{character.id}</span>
                        <span className="admin-char-name">{character.name}</span>
                    </span>
                </div>
            ))}
            {(rest > 0 || expanded) && (
                <button type="button" className="admin-char-card admin-char-expand"
                    onClick={onToggleExpanded}
                    aria-expanded={expanded}
                    aria-label={expanded ? "收起其余 UP 角色" : `展开其余 ${rest} 个 UP 角色`}>
                    {expanded ? "收起" : `+${rest}`}
                </button>
            )}
        </div>
    )
}

function normalizeDraft(base: Dayjs, draft: DraftSegments): Dayjs {
    const read = (key: SegmentKey, fallback: number) => {
        const parsed = Number.parseInt(draft[key], 10)
        return Number.isFinite(parsed) ? parsed : fallback
    }
    const year = clampNumber(read("year", base.year()), 1970, 2099)
    const month = clampNumber(read("month", base.month() + 1), 1, 12)
    const day = clampNumber(read("day", base.date()), 1, maxDayOfMonth(year, month))
    const hour = clampNumber(read("hour", base.hour()), 0, 23)
    const minute = clampNumber(read("minute", base.minute()), 0, 59)
    const second = clampNumber(read("second", base.second()), 0, 59)
    return buildDateFromParts(year, month, day, hour, minute, second)
}

function setSegmentValue(base: Dayjs, key: SegmentKey, rawValue: number, wrap: boolean): Dayjs {
    let year = base.year()
    let month = base.month() + 1
    let day = base.date()
    let hour = base.hour()
    let minute = base.minute()
    let second = base.second()
    const bounds = (segmentKey: SegmentKey): [number, number] => {
        if (segmentKey === "year") return [1970, 2099]
        if (segmentKey === "month") return [1, 12]
        if (segmentKey === "day") return [1, maxDayOfMonth(year, month)]
        if (segmentKey === "hour") return [0, 23]
        return [0, 59]
    }
    const [min, max] = bounds(key)
    const value = wrap ? wrapNumber(rawValue, min, max) : clampNumber(rawValue, min, max)
    if (key === "year") year = value
    if (key === "month") month = value
    if (key === "day") day = value
    if (key === "hour") hour = value
    if (key === "minute") minute = value
    if (key === "second") second = value
    day = clampNumber(day, 1, maxDayOfMonth(year, month))
    return buildDateFromParts(year, month, day, hour, minute, second)
}

export default function TimeControl() {
    const qc = useQueryClient()
    const [picked, setPicked] = useState<Dayjs | null>(null)
    const [draftSegments, setDraftSegments] = useState<DraftSegments | null>(null)
    const [editingTime, setEditingTime] = useState(false)
    const [focusedKey, setFocusedKey] = useState<SegmentKey>("year")
    // 大池(属性特选等)UP 头像条目 >8 时可展开 (维护者 2026-09-30)
    const [expandedPoolIds, setExpandedPoolIds] = useState<Set<number>>(new Set())
    const [gachaSearch, setGachaSearch] = useState("")
    const [activitySearch, setActivitySearch] = useState("")
    // 时间线分页页码（两线各自独立, 维护者指定: 展开改为分页）
    const [gachaPage, setGachaPage] = useState(1)
    const [activityPage, setActivityPage] = useState(1)
    const togglePoolExpanded = (poolId: number) => {
        setExpandedPoolIds(current => {
            const next = new Set(current)
            if (next.has(poolId)) next.delete(poolId)
            else next.add(poolId)
            return next
        })
    }
    const [clairvoyanceTab, setClairvoyanceTab] = useState<"gacha" | "activity">("gacha")
    const segmentRefs = useRef<Array<HTMLInputElement | null>>([])
    const applyingRef = useRef(false)
    // 大钟数字常驻为输入框：只有真正改过数值才在离开编辑区时应用，
    // 路过焦点（tab 穿越或误点）不会触发一次"原地设置"
    const touchedRef = useRef(false)

    const { data, isError, isLoading, isFetching } = useQuery({
        queryKey: ["serverTime"],
        queryFn: () => apiGet<ServerTime>("/api/server/currentTime"),
        refetchInterval: 30_000,
    })

    const { data: gachaTimeline, isError: gachaTimelineError, isLoading: gachaTimelineLoading } = useQuery({
        queryKey: ["clairvoyanceGacha"],
        queryFn: () => apiGet<ClairvoyanceGachaTimeline>("/api/server/clairvoyance/gacha"),
        refetchInterval: 30_000,
    })

    const { data: activityTimeline, isError: activityTimelineError, isLoading: activityTimelineLoading } = useQuery({
        queryKey: ["clairvoyanceActivity"],
        queryFn: () => apiGet<ClairvoyanceActivityTimeline>("/api/server/clairvoyance/activity"),
        refetchInterval: 30_000,
    })

    const searchResults = useMemo(() => {
        const query = normalizeSearch(gachaSearch)
        if (!query || !gachaTimeline) return []
        return gachaTimeline.searchIndex
            .filter(row => {
                const haystack = normalizeSearch(`${row.characterId} ${row.name} ${row.title}`)
                return haystack.includes(query)
            })
            .slice(0, 20)
    }, [gachaSearch, gachaTimeline])

    const activityTimelineByKey = useMemo(() => {
        return new Map((activityTimeline?.timeline ?? []).map(activity => [activityKey(activity), activity]))
    }, [activityTimeline])

    // 两个页签共用同一 CDN 基线（同一 content 快照），徽章取先到者
    const clairvoyanceCdnVersion = gachaTimeline?.cdnVersion ?? activityTimeline?.cdnVersion

    // 近期卡池 = 进行中 ∪ 未来 7 天内开始；进行中按结束时间升序在前，预告按开始时间升序在后
    const recentGachas = useMemo(() => {
        if (!gachaTimeline) return []
        const now = Date.parse(gachaTimeline.currentTime)
        if (!Number.isFinite(now)) return []
        const weekMs = 7 * 86_400_000
        const current = [...gachaTimeline.current]
            .sort((left, right) => parseCdnInstant(left.endDate) - parseCdnInstant(right.endDate))
            .map(gacha => ({ gacha, upcoming: false }))
        const upcoming = gachaTimeline.timeline
            .filter(gacha => {
                const start = parseCdnInstant(gacha.startDate)
                return start > now && start <= now + weekMs
            })
            .sort((left, right) => parseCdnInstant(left.startDate) - parseCdnInstant(right.startDate))
            .map(gacha => ({ gacha, upcoming: true }))
        return [...current, ...upcoming]
    }, [gachaTimeline])

    // 近期活动 = 活跃窗口覆盖现在 ∪ 未来 7 天内开始（与近期卡池同规则、同排序）
    const recentActivities = useMemo(() => {
        if (!activityTimeline) return []
        const now = Date.parse(activityTimeline.currentTime)
        if (!Number.isFinite(now)) return []
        const weekMs = 7 * 86_400_000
        const endEpoch = (activity: AdminActivityEvent): number => (
            activity.activeEndTime === null ? Number.POSITIVE_INFINITY : Date.parse(activity.activeEndTime)
        )
        const live = activityTimeline.timeline
            .filter(activity => Date.parse(activity.startTime) <= now && now <= endEpoch(activity))
            .sort((left, right) => endEpoch(left) - endEpoch(right))
            .map(activity => ({ activity, upcoming: false }))
        const upcoming = activityTimeline.timeline
            .filter(activity => {
                const start = Date.parse(activity.startTime)
                return start > now && start <= now + weekMs
            })
            .sort((left, right) => Date.parse(left.startTime) - Date.parse(right.startTime))
            .map(activity => ({ activity, upcoming: true }))
        return [...live, ...upcoming]
    }, [activityTimeline])

    const activityResults = useMemo(() => {
        const query = normalizeSearch(activitySearch)
        if (!query || !activityTimeline) return []
        return activityTimeline.searchIndex
            .filter(row => {
                const haystack = normalizeSearch([
                    row.eventId,
                    row.stringId,
                    row.name,
                    row.family,
                    row.familyLabel,
                    ...row.aliases,
                ].join(" "))
                return haystack.includes(query)
            })
            .slice(0, 20)
            .flatMap(row => {
                const activity = activityTimelineByKey.get(activityKey(row))
                return activity ? [activity] : []
            })
    }, [activitySearch, activityTimeline, activityTimelineByKey])

    // 时间线统一单列列表（维护者指定）: 恒为完整时间线, 与上方搜索区互不影响
    const timelineGachas = useMemo(() => gachaTimeline?.timeline ?? [], [gachaTimeline])
    const gachaPageCount = Math.max(1, Math.ceil(timelineGachas.length / TIMELINE_PAGE_SIZE))
    const safeGachaPage = Math.min(gachaPage, gachaPageCount)
    const visibleTimelineGachas = timelineGachas.slice((safeGachaPage - 1) * TIMELINE_PAGE_SIZE, safeGachaPage * TIMELINE_PAGE_SIZE)

    // 活动时间线同构: 恒为完整时间线, 与活动搜索区互不影响
    const timelineActivities = useMemo(() => activityTimeline?.timeline ?? [], [activityTimeline])
    const activityPageCount = Math.max(1, Math.ceil(timelineActivities.length / TIMELINE_PAGE_SIZE))
    const safeActivityPage = Math.min(activityPage, activityPageCount)
    const visibleTimelineActivities = timelineActivities.slice((safeActivityPage - 1) * TIMELINE_PAGE_SIZE, safeActivityPage * TIMELINE_PAGE_SIZE)

    const isoText = data?.date ? data.date.replace("T", " ") : "-"
    const shownDraft = draftSegments ?? (data ? formatDraft(dayjs(data.date)) : null)
    const beginEditingTime = () => {
        if (!data || isLoading) return
        const next = dayjs(data.date)
        setPicked(next)
        setDraftSegments(formatDraft(next))
        setEditingTime(true)
    }
    const applyPickedTime = () => {
        touchedRef.current = false
        if (!picked || !draftSegments || setTime.isPending || applyingRef.current) return
        applyingRef.current = true
        const next = normalizeDraft(picked, draftSegments)
        setPicked(next)
        setDraftSegments(formatDraft(next))
        setTime.mutate(next)
    }
    const cancelEditingTime = () => {
        touchedRef.current = false
        setEditingTime(false)
        setPicked(null)
        setDraftSegments(null)
    }
    const focusSegment = (index: number) => {
        const next = Math.max(0, Math.min(timeSegments.length - 1, index))
        segmentRefs.current[next]?.focus()
        segmentRefs.current[next]?.select()
    }
    const adjustSegment = (key: SegmentKey, amount: number) => {
        touchedRef.current = true
        const base = normalizeDraft(picked ?? dayjs(data?.date), draftSegments ?? formatDraft(picked ?? dayjs(data?.date)))
        const next = setSegmentValue(base, key, segmentValue(base, key) + amount, true)
        setPicked(next)
        setDraftSegments(formatDraft(next))
    }
    const updateSegmentText = (key: SegmentKey, value: string) => {
        touchedRef.current = true
        const segment = timeSegments.find(s => s.key === key)!
        const digits = value.replace(/\D/g, "").slice(0, segment.digits)
        const baseDate = picked ?? dayjs(data?.date)
        const baseDraft = draftSegments ?? formatDraft(baseDate)
        const nextDraft = { ...baseDraft, [key]: digits }
        let nextPicked = baseDate
        if (digits.length === segment.digits) {
            const parsed = Number.parseInt(digits, 10)
            if (Number.isFinite(parsed)) {
                nextPicked = setSegmentValue(normalizeDraft(baseDate, baseDraft), key, parsed, false)
                setPicked(nextPicked)
            }
        }
        setDraftSegments(digits.length === segment.digits ? formatDraft(nextPicked) : nextDraft)
    }

    const setTime = useMutation({
        mutationFn: (t: Dayjs) =>
            apiGet<ServerTime>(`/api/server/time?time=${encodeURIComponent(t.format("YYYY-MM-DDTHH:mm:ssZ"))}`),
        onSuccess: () => {
            applyingRef.current = false
            message.success("服务器时间已设置")
            setEditingTime(false)
            setPicked(null)
            setDraftSegments(null)
            qc.invalidateQueries({ queryKey: ["serverTime"] })
            qc.invalidateQueries({ queryKey: ["clairvoyanceGacha"] })
            qc.invalidateQueries({ queryKey: ["clairvoyanceActivity"] })
        },
        onError: (e: Error) => {
            applyingRef.current = false
            message.error(e.message)
        },
    })

    const resetTime = useMutation({
        mutationFn: () => apiGet<ServerTime>("/api/server/resetTime"),
        onSuccess: () => {
            message.success("已重置为系统时间")
            setEditingTime(false)
            setPicked(null)
            setDraftSegments(null)
            qc.invalidateQueries({ queryKey: ["serverTime"] })
            qc.invalidateQueries({ queryKey: ["clairvoyanceGacha"] })
            qc.invalidateQueries({ queryKey: ["clairvoyanceActivity"] })
        },
        onError: (e: Error) => message.error(e.message),
    })

    // 卡头 Segmented 的两个视图（方案 A，设计稿 clairvoyance-tab-design.html）：
    // 标题恒为「千里眼」，卡体按视图条件渲染；数据流 / queryKey / 端点零改动，纯呈现层重排。
    const gachaBody = gachaTimelineError ? (
        <Alert type="error" showIcon message="千里眼数据加载失败" description="接口 /api/server/clairvoyance/gacha 不可用。" />
    ) : (
        <div className="admin-dash-sections">

<section className="admin-dash-section">
                <div className="admin-dash-section-title">UP 角色搜索</div>
                <div className="admin-dash-section-body">
                    <Input
                        allowClear
                        className="admin-time-search"
                        placeholder="输入角色名、称号或角色 ID"
                        value={gachaSearch}
                        onChange={event => setGachaSearch(event.target.value)}
                    />
                    {gachaSearch && (
                        searchResults.length > 0 ? (
                            searchResults.map(row => (
                                <div key={row.characterId} className="admin-search-character">
                                    <span className="admin-tl-up-av" aria-hidden>
                                        {row.name.slice(0, 1)}
                                        <img
                                            className="admin-tl-up-av-img"
                                            src={`/api/content/character_avatar/${row.characterId}`}
                                            alt=""
                                            loading="lazy"
                                            onError={event => event.currentTarget.classList.add("admin-tl-up-av-broken")}
                                        />
                                    </span>
                                    <div className="admin-search-character-info">
                                        <Typography.Text strong>{row.name} #{row.characterId}</Typography.Text>
                                        {row.title && <Typography.Text type="secondary">{row.title}</Typography.Text>}
                                    <div className="admin-search-gacha-list">
                                        {row.gachas.map(gacha => (
                                            <div key={gacha.id} className="admin-search-gacha-row">
                                                <span className="admin-search-gacha-name">
                                                    #{gacha.id} {gacha.name}
                                                </span>
                                                {renderGachaStatusBadge(gacha, gachaTimeline?.currentTime)}
                                                <span className="admin-search-gacha-period admin-mono">
                                                    {renderGachaPeriod(gacha)}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的 UP 角色" />
                        )
                    )}
                </div>
            </section>
<section className="admin-dash-section">
                <div className="admin-dash-section-title">近期卡池</div>
                <div className="admin-dash-section-body">
                    {gachaTimelineLoading ? (
                        <Typography.Text type="secondary">加载中...</Typography.Text>
                    ) : gachaTimeline && recentGachas.length > 0 ? (
                        recentGachas.map(({ gacha, upcoming }) => (
                            <div key={gacha.id} className="admin-clairvoyance-panel">
                                <div className="admin-pool-top">
                                    <span className="admin-pool-name">{gacha.name} #{gacha.id}</span>
                                    {renderPoolCardBadge(gacha, gachaTimeline?.currentTime)}
                                    <span className="admin-pool-win admin-mono">{renderGachaCompactPeriod(gacha)}</span>
                                    <span className="admin-pool-remaining">
                                        {upcoming
                                            ? renderGachaStartCountdown(gacha, gachaTimeline?.currentTime)
                                            : renderRemainingDays(gacha, gachaTimeline?.currentTime)}
                                    </span>
                                </div>
                                {renderRateUpCharacters(
                                    gacha.rateUpCharacters,
                                    expandedPoolIds.has(gacha.id),
                                    () => togglePoolExpanded(gacha.id),
                                )}
                            </div>
                        ))
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近七日没有进行中或预告的短期 UP 角色池" />
                    )}
                </div>
            </section>

            

            <section className="admin-dash-section">
                <div className="admin-dash-section-title">时间线</div>
                <div className="admin-dash-section-body">
                    {gachaTimelineLoading ? (
                        <Typography.Text type="secondary">加载中...</Typography.Text>
                    ) : visibleTimelineGachas.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无卡池时间线" />
                    ) : (
                        <>
                            <div className="admin-tl-list">
                                {visibleTimelineGachas.map(gacha => (
                                    <div key={gacha.id} className="admin-tl-item">
                                        <div className="admin-tl-head">
                                            <span className="admin-tl-name">{gacha.name}</span>
                                            <span className="admin-tl-id admin-mono">#{gacha.id}</span>
                                        </div>
                                        <div className="admin-tl-time">
                                            <span className="admin-mono">{renderGachaCompactPeriod(gacha)}</span>
                                            {renderGachaStatusBadge(gacha, gachaTimeline?.currentTime)}
                                            <span>{renderRemainingDays(gacha, gachaTimeline?.currentTime)}</span>
                                        </div>
                                        <div className="admin-tl-body">
                                            {renderUpCharacterChips(gacha.rateUpCharacters)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                            {timelineGachas.length > TIMELINE_PAGE_SIZE && (
                                <Pagination
                                    size="small"
                                    className="admin-tl-pagination"
                                    current={safeGachaPage}
                                    pageSize={TIMELINE_PAGE_SIZE}
                                    total={timelineGachas.length}
                                    showSizeChanger={false}
                                    onChange={setGachaPage}
                                />
                            )}
                        </>
                    )}
                </div>
            </section>
        </div>
    )

    const activityBody = activityTimelineError ? (
        <Alert type="error" showIcon message="活动日程加载失败" description="接口 /api/server/clairvoyance/activity 不可用。" />
    ) : (
        <div className="admin-dash-sections">

<section className="admin-dash-section">
                <div className="admin-dash-section-title">活动搜索</div>
                <div className="admin-dash-section-body">
                    <Input
                        allowClear
                        className="admin-time-search"
                        placeholder="输入活动名、别名、stringId 或活动 ID"
                        value={activitySearch}
                        onChange={event => setActivitySearch(event.target.value)}
                    />
                    {activitySearch && (
                        activityResults.length > 0 ? (
                            activityResults.map(activity => renderActivityCard(activity, false, activityTimeline?.currentTime))
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的活动" />
                        )
                    )}
                </div>
            </section>
<section className="admin-dash-section">
                <div className="admin-dash-section-title">近期活动</div>
                <div className="admin-dash-section-body">
                    {activityTimelineLoading ? (
                        <Typography.Text type="secondary">加载中...</Typography.Text>
                    ) : activityTimeline && recentActivities.length > 0 ? (
                        recentActivities.map(({ activity, upcoming }) => (
                            renderActivityCard(activity, upcoming, activityTimeline.currentTime)
                        ))
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近七日没有进行中或预告的活动" />
                    )}
                </div>
            </section>

            

            <section className="admin-dash-section">
                <div className="admin-dash-section-title">活动时间线</div>
                <div className="admin-dash-section-body">
                    {activityTimelineLoading ? (
                        <Typography.Text type="secondary">加载中...</Typography.Text>
                    ) : visibleTimelineActivities.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无活动时间线" />
                    ) : (
                        <>
                            <div className="admin-tl-list">
                                {visibleTimelineActivities.map(activity => (
                                    <div key={activityKey(activity)} className="admin-tl-item">
                                        <div className="admin-tl-head">
                                            <span className="admin-tl-name">{activity.name}</span>
                                            <span className="admin-tl-id admin-mono">#{activity.eventId}</span>
                                            <span className={activityFamilyBadgeClass(activity.familyLabel)}>{activity.familyLabel}</span>
                                        </div>
                                        <div className="admin-tl-time">
                                            <span className="admin-mono">{renderActivityCompactPeriod(activity)}</span>
                                            {renderActivityStatusBadge(activity, activityTimeline?.currentTime)}
                                            <span>{renderActivityRemainingDays(activity, activityTimeline?.currentTime)}</span>
                                            {activity.closeEndTime !== null && (
                                                <span>换牌截止 {formatGameWallTime(activity.closeEndTime)}</span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                            {timelineActivities.length > TIMELINE_PAGE_SIZE && (
                                <Pagination
                                    size="small"
                                    className="admin-tl-pagination"
                                    current={safeActivityPage}
                                    pageSize={TIMELINE_PAGE_SIZE}
                                    total={timelineActivities.length}
                                    showSizeChanger={false}
                                    onChange={setActivityPage}
                                />
                            )}
                        </>
                    )}
                </div>
            </section>
        </div>
    )
    return (
        <AdminPage
            eyebrow="TIME"
            title="时间 / 千里眼"
            description="管理服务端全局模拟时间，并按固定 CDN 基线查看短期 UP 角色池与活动日程时间线。"
            onRefresh={() => {
                qc.invalidateQueries({ queryKey: ["serverTime"] })
                qc.invalidateQueries({ queryKey: ["clairvoyanceGacha"] })
                qc.invalidateQueries({ queryKey: ["clairvoyanceActivity"] })
            }}
            refreshing={isFetching || gachaTimelineLoading || activityTimelineLoading}
        >
            <Space direction="vertical" size="large" className="admin-stack">
                {isError ? (
                    <Alert type="error" showIcon message="服务器模拟时间加载失败" description="接口 /api/server/currentTime 不可用。" />
                ) : (
                    <section className="admin-hero admin-time-hero">
                        <div className="admin-time-hero-in">
                            <div className="admin-time-hero-clock">
                                <div className="admin-time-hero-headrow">
                                    <div className="admin-time-hero-headblock">
                                        <div className="admin-time-hero-head">当前服务器模拟时间</div>
                                        <span className="admin-time-hero-head-em">点击数字修改</span>
                                    </div>
                                    <div className="admin-time-hero-side">
                                        <Button
                                            className="admin-time-hero-reset"
                                            icon={<UndoOutlined />}
                                            loading={resetTime.isPending}
                                            onClick={() => resetTime.mutate()}
                                        >
                                            跟随系统时间
                                        </Button>
                                    </div>
                                </div>
                                <div className="admin-time-hero-rule" aria-hidden="true" />
                                <div className="admin-time-hero-section">
                                    <span>时间设置</span>
                                    {data && (
                                        <span className={data.isCustom ? "admin-badge-warn" : "admin-badge-info"}>
                                            {data.isCustom ? "自定义模拟" : "跟随系统"}
                                        </span>
                                    )}
                                </div>
                                <div className="admin-time-hero-clockzone">
                                    <div
                                        className="admin-time-hero-digits"
                                        onBlur={(event) => {
                                            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                                            if (touchedRef.current) applyPickedTime()
                                            else cancelEditingTime()
                                        }}
                                    >
                                        {/* 日期一行 + 时间一行, 与总览页时钟同款排版 (维护者 2026-09-29) */}
                                        {[timeSegments.slice(0, 3), timeSegments.slice(3)].map((group, groupIndex) => (
                                            <div className="admin-time-hero-digits-row" key={groupIndex}>
                                                {group.map((segment, groupOffset) => {
                                                    const index = groupIndex * 3 + groupOffset
                                                    return (
                                            <span className="admin-time-hero-cell" key={segment.key}>
                                                <input
                                                    ref={(node) => { segmentRefs.current[index] = node }}
                                                    type="text"
                                                    inputMode="numeric"
                                                    aria-label={`编辑${segment.label}`}
                                                    className={segment.key === "year" ? "admin-time-hero-seg admin-time-hero-seg-year" : "admin-time-hero-seg"}
                                                    value={shownDraft?.[segment.key] ?? ""}
                                                    placeholder="--"
                                                    disabled={isLoading || !data}
                                                    onChange={(event) => updateSegmentText(segment.key, event.target.value)}
                                                    onFocus={(event) => {
                                                        if (!editingTime) beginEditingTime()
                                                        setFocusedKey(segment.key)
                                                        event.target.select()
                                                    }}
                                                    onClick={(event) => {
                                                        event.currentTarget.select()
                                                        setFocusedKey(segment.key)
                                                    }}
                                                    onKeyDown={(event) => {
                                                        if (event.key === "ArrowRight") {
                                                            event.preventDefault()
                                                            focusSegment(index + 1)
                                                        } else if (event.key === "ArrowLeft") {
                                                            event.preventDefault()
                                                            focusSegment(index - 1)
                                                        } else if (event.key === "ArrowUp") {
                                                            event.preventDefault()
                                                            adjustSegment(segment.key, 1)
                                                        } else if (event.key === "ArrowDown") {
                                                            event.preventDefault()
                                                            adjustSegment(segment.key, -1)
                                                        } else if (event.key === "Enter") {
                                                            event.preventDefault()
                                                            applyPickedTime()
                                                        } else if (event.key === "Escape") {
                                                            event.preventDefault()
                                                            cancelEditingTime()
                                                        }
                                                    }}
                                                />
                                                <span className="admin-time-hero-unit">{segment.label}</span>
                                            </span>
                                                )
                                            })}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            {coarsePointer && editingTime && (
                                <div className="admin-time-stepper" role="group" aria-label="调整选中字段">
                                    <button type="button" className="admin-time-stepper-btn"
                                        onMouseDown={event => event.preventDefault()}
                                        onClick={() => adjustSegment(focusedKey, -1)}
                                        aria-label="减小">−</button>
                                    <span className="admin-time-stepper-label">
                                        {timeSegments.find(seg => seg.key === focusedKey)?.label ?? ""}
                                    </span>
                                    <button type="button" className="admin-time-stepper-btn"
                                        onMouseDown={event => event.preventDefault()}
                                        onClick={() => adjustSegment(focusedKey, 1)}
                                        aria-label="增大">＋</button>
                                </div>
                            )}
                            <div className="admin-time-hero-sub">
                                {/* 桌面 ≥768px 专用：状态徽章 + 跟随系统按钮回到时钟下方单行（F2 同行方案） */}
                                <span className="admin-time-hero-submode">
                                    {data && (
                                        <span className={data.isCustom ? "admin-badge-warn" : "admin-badge-info"}>
                                            {data.isCustom ? "自定义模拟" : "跟随系统"}
                                        </span>
                                    )}
                                    <Button
                                        className="admin-time-hero-reset"
                                        icon={<UndoOutlined />}
                                        loading={resetTime.isPending}
                                        onClick={() => resetTime.mutate()}
                                    >
                                        跟随系统时间
                                    </Button>
                                </span>
                                <span className="admin-mono">UTC：{isoText} · Unix 秒：{data?.servertime ?? "-"}</span>
                                <span className="admin-time-hero-hint">{coarsePointer ? "点选字段后用上方 ＋/− 调整数值。" : "↑/↓ 调整数值，←/→ 切换单位；离开编辑区自动应用，Esc 取消。"}</span>
                            </div>
                        </div>
                    </section>
                )}
                <Card
                    className="admin-clairvoyance-card"
                    title={
                        <div className="admin-clairvoyance-head" role="toolbar" aria-label="千里眼视图切换">
                            <span className="admin-clairvoyance-head-title">千里眼</span>
                            <Segmented
                                options={[
                                    { label: "卡池", value: "gacha" },
                                    { label: "活动", value: "activity" },
                                ]}
                                value={clairvoyanceTab}
                                onChange={value => setClairvoyanceTab(value as "gacha" | "activity")}
                            />
                        </div>
                    }
                    extra={clairvoyanceCdnVersion && <Tag color="cyan">CDN {clairvoyanceCdnVersion}</Tag>}
                >
                    {clairvoyanceTab === "gacha" ? gachaBody : activityBody}
                </Card>
            <div className="admin-page-note admin-page-note-footer">
                <div>
                    <Typography.Text strong>短期 UP 角色池追踪范围</Typography.Text>
                    <Typography.Text type="secondary">
                        范围限定为固定 CDN 基线内 pageKind=0、持续不超过 60 天且包含 UP 角色的角色扭蛋。
                    </Typography.Text>
                </div>
                <div>
                    <Typography.Text strong>活动日程追踪范围</Typography.Text>
                    <Typography.Text type="secondary">
                        固定 CDN 基线内 13 族活动主表；活跃截止前为进行中，活跃截止后进入换牌期，换牌截止后结束；无活跃截止的条目开始后长期开放。
                    </Typography.Text>
                </div>
            </div>
            </Space>
        </AdminPage>
    )
}
