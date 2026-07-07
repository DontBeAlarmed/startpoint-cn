import { Card, Segmented, Button, Space, Statistic, Progress, Spin, Empty, message, Typography } from "antd"
import { ReloadOutlined, CloseOutlined } from "@ant-design/icons"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { apiGet, apiPost, apiDelete } from "../api/client"

const { Text } = Typography

type PoolMode = "natural" | "play" | "test"

// 卡池组：每组聚合 基础 + 保底 两个 movie（与旧 seeds.html 一致）
const GROUPS = [
    { id: "fes", name: "流星祭", movies: ["fes", "fes_guarantee"] },
    { id: "normal", name: "普通", movies: ["normal", "normal_guarantee"] },
]

const TAGS = ["未测试", "热血躲避球", "普通躲避球", "冷血躲避球"] as const
const TAG_SHORT = ["未", "热", "普", "冷"]
const TAG_COLOR = ["#6e7681", "#f85149", "#1677ff", "#6e7681"]
type Tag = typeof TAGS[number]

interface SeedStats {
    movieId: string; unknown: number; movie_total: number
    confirm: number; confirm_total: number
    play_r3: number; play_r4: number; play_r5: number; play_total: number
    mov_play: number; verified: number; verified_total: number
    pending: number; pending_total: number
    test_seeds: (number | null)[]
    mode: PoolMode; total: number; tested: number; coverage: number
}
interface PlayItem { seed: number; rarity: number; tag: Tag; play?: boolean }
interface ListResp { play: PlayItem[]; verified: { seed: number; rarity: number }[]; movieId: string }

// 每个种子附带来源 movie 与是否保底
interface SeedRow { seed: number; rarity: number; tag: Tag; movie: string; isGuarantee: boolean }

interface GroupData {
    mode: PoolMode
    testSeeds: (number | null)[]
    confirm: number; pending: number; unknown: number
    verified: number; play: number
    baseConfirm: number; gtConfirm: number
    total: number; tested: number; coverage: number
    playRows: SeedRow[]
    verifiedRows: SeedRow[]
    playBySeed: Record<number, SeedRow>
}

async function fetchGroup(movies: string[]): Promise<GroupData> {
    const stats = await Promise.all(movies.map(m => apiGet<SeedStats>(`/api/seeds/stats?movieId=${m}`)))
    const lists = await Promise.all(movies.map(m => apiGet<ListResp>(`/api/seeds/list?movieId=${m}`)))

    const agg = { confirm: 0, pending: 0, unknown: 0, verified: 0, play: 0, total: 0, tested: 0, baseConfirm: 0, gtConfirm: 0 }
    for (const s of stats) {
        agg.confirm += s.confirm || 0
        agg.pending += s.pending || 0
        agg.unknown += s.unknown || 0
        agg.verified += s.verified || 0
        agg.play += s.mov_play || 0
        agg.total += s.movie_total || s.total || 0
        agg.tested += s.tested || 0
        if ((s.movieId || "").endsWith("_guarantee")) agg.gtConfirm += s.confirm || 0
        else agg.baseConfirm += s.confirm || 0
    }

    const playRows: SeedRow[] = []
    const verifiedRows: SeedRow[] = []
    const playBySeed: Record<number, SeedRow> = {}
    lists.forEach((data, i) => {
        const movie = movies[i]
        const isGuarantee = movie.endsWith("_guarantee")
        for (const p of data.play || []) {
            const row: SeedRow = { seed: p.seed, rarity: p.rarity, tag: p.tag || "未测试", movie, isGuarantee }
            playRows.push(row); playBySeed[p.seed] = row
        }
        for (const p of data.verified || []) {
            verifiedRows.push({ seed: p.seed, rarity: p.rarity, tag: "未测试", movie, isGuarantee })
        }
    })

    return {
        mode: stats[0].mode,
        testSeeds: stats[0].test_seeds || [null, null, null],
        confirm: agg.confirm, pending: agg.pending, unknown: agg.unknown,
        verified: agg.verified, play: agg.play,
        baseConfirm: agg.baseConfirm, gtConfirm: agg.gtConfirm,
        total: agg.total, tested: agg.tested,
        coverage: agg.total > 0 ? Math.round(agg.tested / agg.total * 100) : 0,
        playRows, verifiedRows, playBySeed,
    }
}

// 列定义：★3 不分保底，★4/★5 各分普通/保底
const COLUMNS: { key: string; label: string; rarity: number; guarantee: boolean; color: string }[] = [
    { key: "r3", label: "★3", rarity: 3, guarantee: false, color: "#f85149" },
    { key: "r4", label: "★4", rarity: 4, guarantee: false, color: "#d29922" },
    { key: "r4b", label: "★4保底", rarity: 4, guarantee: true, color: "#b0882c" },
    { key: "r5", label: "★5", rarity: 5, guarantee: false, color: "#3fb950" },
    { key: "r5b", label: "★5保底", rarity: 5, guarantee: true, color: "#2ea043" },
]

function inColumn(row: SeedRow, rarity: number, guarantee: boolean): boolean {
    if (row.rarity !== rarity) return false
    if (rarity === 3) return true // ★3 不分保底
    return row.isGuarantee === guarantee
}

export default function Seeds() {
    const qc = useQueryClient()
    const [groupId, setGroupId] = useState("fes")
    const group = GROUPS.find(g => g.id === groupId)!

    const { data, isLoading, isError, refetch, isFetching } = useQuery({
        queryKey: ["seeds", groupId],
        queryFn: () => fetchGroup(group.movies),
    })

    const invalidate = () => qc.invalidateQueries({ queryKey: ["seeds"] })

    const setMode = useMutation({
        mutationFn: (mode: PoolMode) => apiPost("/api/seeds/mode", { mode }),
        onSuccess: () => { message.success("模式已切换"); invalidate() },
        onError: (e: Error) => message.error(e.message),
    })
    const setTag = useMutation({
        mutationFn: (v: { seed: number; tag: Tag; movie: string }) =>
            apiPost("/api/seeds/tag", { seed: v.seed, tag: v.tag, movieId: v.movie }),
        onSuccess: () => invalidate(),
        onError: (e: Error) => message.error(e.message),
    })
    const setTestSeed = useMutation({
        mutationFn: (v: { seed: number; rarity: number }) => apiPost("/api/seeds/test-seed", v),
        onSuccess: () => { message.success("已设为测试种子"); invalidate() },
        onError: (e: Error) => message.error(e.message),
    })
    const clearTestSeed = useMutation({
        mutationFn: (rarity: number) => apiDelete(`/api/seeds/test-seed?rarity=${rarity}`),
        onSuccess: () => invalidate(),
        onError: (e: Error) => message.error(e.message),
    })

    // 单个种子行
    const SeedLine = ({ row, showTest }: { row: SeedRow; showTest: boolean }) => {
        const cold = row.tag === "冷血躲避球"
        const isTest = data?.testSeeds[row.rarity - 3] === row.seed
        return (
            <div style={{
                display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center",
                padding: "2px 0", borderBottom: "1px solid #f0f0f0", fontSize: 12,
                opacity: cold ? 0.4 : 1, textDecoration: cold ? "line-through" : "none",
            }}>
                <span style={{ width: 66, color: cold ? undefined : "#a371f7" }}>{row.seed}</span>
                {TAGS.map((t, i) => (
                    <button key={t} title={t}
                        onClick={() => setTag.mutate({ seed: row.seed, tag: t, movie: row.movie })}
                        style={{
                            cursor: "pointer", fontSize: 11, lineHeight: "16px", padding: "0 5px",
                            borderRadius: 8, border: `1px solid ${row.tag === t ? TAG_COLOR[i] : "#d9d9d9"}`,
                            background: row.tag === t ? TAG_COLOR[i] : "transparent",
                            color: row.tag === t ? "#fff" : "inherit",
                        }}>{TAG_SHORT[i]}</button>
                ))}
                {showTest && (
                    <button disabled={cold}
                        onClick={() => setTestSeed.mutate({ seed: row.seed, rarity: row.rarity })}
                        style={{
                            cursor: cold ? "not-allowed" : "pointer", fontSize: 11, lineHeight: "16px", padding: "0 5px",
                            borderRadius: 8, border: `1px solid ${isTest ? "#a371f7" : "#d9d9d9"}`,
                            background: isTest ? "#a371f7" : "transparent", color: isTest ? "#fff" : "inherit",
                        }}>★{row.rarity}测试</button>
                )}
            </div>
        )
    }

    const SeedColumns = ({ rows, showTest }: { rows: SeedRow[]; showTest: boolean }) => (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16 }}>
            {COLUMNS.map(col => {
                const items = rows.filter(r => inColumn(r, col.rarity, col.guarantee))
                return (
                    <div key={col.key}>
                        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, color: col.color }}>
                            {col.label} ({items.length})
                        </div>
                        {items.length === 0
                            ? <Text type="secondary" style={{ fontSize: 12 }}>暂无</Text>
                            : items.map(r => <SeedLine key={`${r.movie}_${r.seed}`} row={r} showTest={showTest} />)}
                    </div>
                )
            })}
        </div>
    )

    if (isLoading) return <div style={{ textAlign: "center", marginTop: 100 }}><Spin size="large" /></div>
    if (isError || !data) return <Card><Text type="danger">种子接口不可用</Text></Card>

    return (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Space wrap>
                <Button icon={<ReloadOutlined />} loading={isFetching} onClick={() => refetch()}>刷新</Button>
                <Text type="secondary">模式:</Text>
                <Segmented
                    value={data.mode}
                    onChange={v => setMode.mutate(v as PoolMode)}
                    options={[
                        { label: "自然模式", value: "natural" },
                        { label: "播放模式", value: "play" },
                        { label: "测试模式", value: "test" },
                    ]}
                />
                <Text type="secondary">卡池:</Text>
                <Segmented value={groupId} onChange={v => setGroupId(v as string)}
                    options={GROUPS.map(g => ({ label: g.name, value: g.id }))} />
            </Space>

            <Card size="small">
                <Space size="large" wrap>
                    <Statistic title="验证池" value={data.verified} valueStyle={{ color: "#a371f7" }} />
                    <Statistic title="播放池" value={data.play} valueStyle={{ color: "#a371f7" }} />
                    <Statistic title="确认·非保底" value={data.baseConfirm} valueStyle={{ color: "#3fb950" }} />
                    <Statistic title="确认·保底" value={data.gtConfirm} valueStyle={{ color: "#b0882c" }} />
                </Space>
            </Card>

            <Card title="验证池" size="small"
                extra={<Text type="secondary" style={{ fontSize: 12 }}>play=1 ✓ + 稀有度 ✓，自然模式优先</Text>}>
                <div style={{ marginBottom: 12 }}>
                    <Space wrap size="small">
                        <Text type="secondary" style={{ fontSize: 12 }}>testSeed:</Text>
                        {[3, 4, 5].map(r => {
                            const ts = data.testSeeds[r - 3]
                            const e = ts != null ? data.playBySeed[ts] : undefined
                            return (
                                <span key={r} style={{ fontSize: 12 }}>
                                    ★{r}=
                                    {ts != null ? (
                                        <>
                                            <span style={{ color: "#a371f7" }}> {ts} </span>
                                            <span style={{ color: "#888" }}>[{TAG_SHORT[TAGS.indexOf(e?.tag ?? "未测试")]}]</span>
                                            <Button type="text" size="small" danger icon={<CloseOutlined />}
                                                onClick={() => clearTestSeed.mutate(r)} />
                                        </>
                                    ) : <span style={{ color: "#888" }}> [无] </span>}
                                </span>
                            )
                        })}
                    </Space>
                </div>
                {data.verifiedRows.length > 0
                    ? <SeedColumns rows={data.verifiedRows} showTest />
                    : <Empty description="暂无已验证种子" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
            </Card>

            <Card title="播放池" size="small"
                extra={<Text type="secondary" style={{ fontSize: 12 }}>play=1 ✓，稀有度待 C3032 校验</Text>}>
                {data.playRows.length > 0
                    ? <SeedColumns rows={data.playRows} showTest={false} />
                    : <Empty description="暂无播放种子" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
            </Card>

            <Card title="测试池" size="small"
                extra={<Text type="secondary" style={{ fontSize: 12 }}>确认池 ≥ 等待校验 ≥ 测试池</Text>}>
                <Space size="large" wrap style={{ marginBottom: 12 }}>
                    <Statistic title="确认池" value={data.confirm} valueStyle={{ color: "#3fb950" }} />
                    <Statistic title="等待校验" value={data.pending} valueStyle={{ color: "#3fb950" }} />
                    <Statistic title="测试池(未知)" value={data.unknown} valueStyle={{ color: "#6e7681" }} />
                </Space>
                <Progress percent={data.coverage} size="small" style={{ maxWidth: 400 }} />
                <div><Text type="secondary" style={{ fontSize: 12 }}>已测 {data.tested.toLocaleString()} / {data.total.toLocaleString()} · 覆盖率 {data.coverage}%</Text></div>
            </Card>
        </Space>
    )
}
