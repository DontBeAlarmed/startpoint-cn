import { useMemo, useRef, useState } from "react"
import { Alert, Button, Card, Divider, Empty, Input, Space, Table, Tag, Typography, message } from "antd"
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

function renderRateUpCharacters(characters: ClairvoyanceCharacter[]) {
    return (
        <Space wrap size={[4, 4]}>
            {characters.map(character => (
                <Tag key={character.id} color={character.rarity === 5 ? "gold" : character.rarity === 4 ? "purple" : "blue"}>
                    {character.name} #{character.id}
                </Tag>
            ))}
        </Space>
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
    const [gachaSearch, setGachaSearch] = useState("")
    const segmentRefs = useRef<Array<HTMLInputElement | null>>([])
    const applyingRef = useRef(false)

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
            qc.invalidateQueries({ queryKey: ["clairvoyanceGacha"] })
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
        },
        onError: (e: Error) => message.error(e.message),
    })

    return (
        <AdminPage
            eyebrow="TIME"
            title="时间 / 千里眼"
            description="管理服务端全局模拟时间，并按固定 CDN 基线查看短期 UP 角色池时间线。"
            actions={
                <Button
                    icon={<ReloadOutlined />}
                    loading={isFetching || gachaTimelineLoading}
                    onClick={() => {
                        qc.invalidateQueries({ queryKey: ["serverTime"] })
                        qc.invalidateQueries({ queryKey: ["clairvoyanceGacha"] })
                    }}
                >
                    刷新
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
                <Card
                    title="千里眼：短期 UP 角色池"
                    extra={gachaTimeline && <Tag color="cyan">CDN {gachaTimeline.cdnVersion}</Tag>}
                >
                    {gachaTimelineError ? (
                        <Alert type="error" showIcon message="千里眼数据加载失败" description="接口 /api/server/clairvoyance/gacha 不可用。" />
                    ) : (
                        <Space direction="vertical" size="large" className="admin-stack">
                            <Alert
                                type="info"
                                showIcon
                                message="当前阶段只追踪短期 UP 角色池"
                                description="范围限定为固定 CDN 基线内 pageKind=0、持续不超过 60 天且包含 UP 角色的角色扭蛋。"
                            />

                            <section>
                                <Typography.Title level={5}>当前生效卡池</Typography.Title>
                                {gachaTimelineLoading ? (
                                    <Typography.Text type="secondary">加载中...</Typography.Text>
                                ) : gachaTimeline && gachaTimeline.current.length > 0 ? (
                                    <Space direction="vertical" className="admin-stack">
                                        {gachaTimeline.current.map(gacha => (
                                            <div key={gacha.id} className="admin-clairvoyance-panel">
                                                <Typography.Text strong>{gacha.name} #{gacha.id}</Typography.Text>
                                                <Typography.Text type="secondary">{renderGachaPeriod(gacha)}</Typography.Text>
                                                {renderRateUpCharacters(gacha.rateUpCharacters)}
                                            </div>
                                        ))}
                                    </Space>
                                ) : (
                                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前服务器模拟时间没有命中的短期 UP 角色池" />
                                )}
                            </section>

                            <Divider style={{ margin: "0" }} />

                            <section>
                                <Typography.Title level={5}>UP 角色搜索</Typography.Title>
                                <Input
                                    allowClear
                                    placeholder="输入角色名、称号或角色 ID"
                                    value={gachaSearch}
                                    onChange={event => setGachaSearch(event.target.value)}
                                />
                                {gachaSearch && (
                                    <div style={{ marginTop: 12 }}>
                                        {searchResults.length > 0 ? (
                                            <Space direction="vertical" className="admin-stack">
                                                {searchResults.map(row => (
                                                    <div key={row.characterId} className="admin-clairvoyance-panel">
                                                        <Typography.Text strong>{row.name} #{row.characterId}</Typography.Text>
                                                        {row.title && <Typography.Text type="secondary">{row.title}</Typography.Text>}
                                                        <Space wrap size={[4, 4]}>
                                                            {row.gachas.map(gacha => (
                                                                <Tag key={gacha.id}>
                                                                    #{gacha.id} {gacha.name} / {renderGachaPeriod(gacha)}
                                                                </Tag>
                                                            ))}
                                                        </Space>
                                                    </div>
                                                ))}
                                            </Space>
                                        ) : (
                                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的 UP 角色" />
                                        )}
                                    </div>
                                )}
                            </section>

                            <Divider style={{ margin: "0" }} />

                            <section>
                                <Typography.Title level={5}>时间线</Typography.Title>
                                <Table<ClairvoyanceGacha>
                                    rowKey="id"
                                    size="small"
                                    loading={gachaTimelineLoading}
                                    dataSource={gachaTimeline?.timeline ?? []}
                                    scroll={{ x: "max-content" }}
                                    pagination={{ pageSize: 8, showSizeChanger: false }}
                                    columns={[
                                        { title: "卡池", dataIndex: "name", render: (name: string, row) => `${name} #${row.id}` },
                                        { title: "上线 / 下线", render: (_: unknown, row) => renderGachaPeriod(row), width: 300 },
                                        { title: "UP 角色", render: (_: unknown, row) => renderRateUpCharacters(row.rateUpCharacters) },
                                    ]}
                                />
                            </section>
                        </Space>
                    )}
                </Card>
            </Space>
        </AdminPage>
    )
}
