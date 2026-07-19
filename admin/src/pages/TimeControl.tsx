import { useRef, useState } from "react"
import { Alert, Button, Card, Divider, Space, Tag, Typography, message } from "antd"
import { ReloadOutlined, UndoOutlined } from "@ant-design/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import dayjs, { type Dayjs } from "dayjs"
import { apiGet } from "../api/client"
import { AdminPage } from "../components/AdminPage"

interface ServerTime {
    servertime: number
    date: string
    isCustom: boolean
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
    const segmentRefs = useRef<Array<HTMLInputElement | null>>([])
    const applyingRef = useRef(false)

    const { data, isError, isLoading, isFetching } = useQuery({
        queryKey: ["serverTime"],
        queryFn: () => apiGet<ServerTime>("/api/server/currentTime"),
        refetchInterval: 30_000,
    })

    const timeText = isLoading
        ? "加载中..."
        : isError || !data
            ? "接口不可用"
            : new Date(data.date).toLocaleString("zh-CN")
    const isoText = data?.date ? data.date.replace("T", " ") : "-"
    const startEditingTime = () => {
        if (!data || isLoading) return
        const next = dayjs(data.date)
        setPicked(next)
        setDraftSegments(formatDraft(next))
        setEditingTime(true)
        requestAnimationFrame(() => {
            segmentRefs.current[0]?.focus()
            segmentRefs.current[0]?.select()
        })
    }
    const applyPickedTime = () => {
        if (!picked || !draftSegments || setTime.isPending || applyingRef.current) return
        applyingRef.current = true
        const next = normalizeDraft(picked, draftSegments)
        setPicked(next)
        setDraftSegments(formatDraft(next))
        setTime.mutate(next)
    }
    const cancelEditingTime = () => {
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
        const base = normalizeDraft(picked ?? dayjs(data?.date), draftSegments ?? formatDraft(picked ?? dayjs(data?.date)))
        const next = setSegmentValue(base, key, segmentValue(base, key) + amount, true)
        setPicked(next)
        setDraftSegments(formatDraft(next))
    }
    const updateSegmentText = (key: SegmentKey, value: string) => {
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
        },
        onError: (e: Error) => message.error(e.message),
    })

    return (
        <AdminPage
            eyebrow="TIME"
            title="时间 / 千里眼"
            description="管理服务端全局模拟时间。后续千里眼的事件窗口、资源时序和玩家视角校验都从这里扩展。"
            actions={
                <Button
                    icon={<ReloadOutlined />}
                    loading={isFetching}
                    onClick={() => qc.invalidateQueries({ queryKey: ["serverTime"] })}
                >
                    刷新时间
                </Button>
            }
        >
            <Space direction="vertical" size="large" className="admin-stack">
                <Card
                    title="服务器模拟时间"
                    extra={<Tag color={data?.isCustom ? "orange" : "blue"}>{data?.isCustom ? "自定义模拟" : "跟随系统"}</Tag>}
                >
                    {isError ? (
                        <Alert type="error" showIcon message="服务器模拟时间加载失败" description="接口 /api/server/currentTime 不可用。" />
                    ) : (
                        <Space direction="vertical" size="large" className="admin-stack">
                            <div className="admin-time-editor">
                                <Typography.Text type="secondary">当前服务器模拟时间</Typography.Text>
                                {editingTime ? (
                                    <div className="admin-time-inline-edit">
                                        <div
                                            className="admin-time-segments"
                                            onBlur={(event) => {
                                                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                                                applyPickedTime()
                                            }}
                                        >
                                            {timeSegments.map((segment, index) => (
                                                <span className="admin-time-segment-wrap" key={segment.key}>
                                                    <Button
                                                        size="small"
                                                        className="admin-time-step"
                                                        aria-label={`${segment.label}减一`}
                                                        onMouseDown={(event) => event.preventDefault()}
                                                        onClick={() => adjustSegment(segment.key, -1)}
                                                    >
                                                        -
                                                    </Button>
                                                    <span className="admin-time-segment-main">
                                                        <input
                                                            ref={(node) => { segmentRefs.current[index] = node }}
                                                            type="text"
                                                            inputMode="numeric"
                                                            aria-label={`编辑${segment.label}`}
                                                            className="admin-time-segment"
                                                            value={draftSegments?.[segment.key] ?? ""}
                                                            onChange={(event) => updateSegmentText(segment.key, event.target.value)}
                                                            onFocus={(event) => event.target.select()}
                                                            onClick={(event) => event.currentTarget.select()}
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
                                                        <span className="admin-time-segment-label">{segment.label}</span>
                                                    </span>
                                                    <Button
                                                        size="small"
                                                        className="admin-time-step"
                                                        aria-label={`${segment.label}加一`}
                                                        onMouseDown={(event) => event.preventDefault()}
                                                        onClick={() => adjustSegment(segment.key, 1)}
                                                    >
                                                        +
                                                    </Button>
                                                </span>
                                            ))}
                                        </div>
                                        <Typography.Text type="secondary">
                                            ↑/↓ 调整数值，←/→ 切换单位；离开编辑区自动应用，Esc 取消。
                                        </Typography.Text>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className="admin-time-value"
                                        onClick={startEditingTime}
                                        disabled={isLoading || !data}
                                    >
                                        {timeText}
                                    </button>
                                )}
                                <Typography.Text type="secondary">UTC：{isoText}</Typography.Text>
                                <Typography.Text type="secondary">Unix 秒：{data?.servertime ?? "-"}</Typography.Text>
                                <Divider style={{ margin: "10px 0" }} />
                                <Button icon={<UndoOutlined />} loading={resetTime.isPending} onClick={() => resetTime.mutate()}>
                                    跟随系统时间
                                </Button>
                            </div>
                        </Space>
                    )}
                </Card>
                <Card title="千里眼预留">
                    <Space direction="vertical" className="admin-stack">
                        <Typography.Text type="secondary">
                            后续事件日程、资源开放窗口和玩家视角校验会接入同一个服务器模拟时间。
                        </Typography.Text>
                        <Divider style={{ margin: "8px 0" }} />
                        <Space wrap>
                            <Tag>事件窗口</Tag>
                            <Tag>资源时序</Tag>
                            <Tag>玩家 time_offset</Tag>
                        </Space>
                    </Space>
                </Card>
            </Space>
        </AdminPage>
    )
}
