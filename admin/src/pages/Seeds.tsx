import { useMemo, useState } from "react"
import { Alert, Button, Card, Empty, Grid, Modal, Space, Spin, Table, Tag, Typography } from "antd"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { apiGet } from "../api/client"
import { AdminPage, StateCard } from "../components/AdminPage"

const { Text } = Typography

interface MovieStatus {
    movieId: string
    rarityCounts: { "3": number; "4": number; "5": number }
}

interface SeedStatus {
    catalog: {
        schemaVersion: number
        clientVersion: string
        cdnVersion: string
        seedRange: { start: number; end: number }
        totalSeedCount: number
        movies: MovieStatus[]
    }
    quarantine: {
        total: number
        movies: Record<string, number>
        samples: Record<string, number[]>
    }
}

const MOVIE_LABELS: Record<string, string> = {
    normal: "普通",
    normal_guarantee: "普通保底",
    fes: "流星祭",
    fes_guarantee: "流星祭保底",
}

// 构成占比条：3★/4★/5★ 三色堆叠（审查稿 #p-seeds：水蓝/星黄/火红）。
// 颜色全部走 base.css token（--water-soft 为 #9cc3ec 的亮/暗双主题化 token），
// 内联消费于 flex 占比 span 的 background。
const RARITY_RATIO_COLORS: Array<{ rarity: "3" | "4" | "5"; color: string }> = [
    { rarity: "3", color: "var(--water-soft)" },
    { rarity: "4", color: "var(--star)" },
    { rarity: "5", color: "var(--fire)" },
]

function formatClock(timestamp: number): string {
    if (timestamp <= 0) return "--:--:--"
    const d = new Date(timestamp)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export default function Seeds() {
    const queryClient = useQueryClient()
    const [quarantineView, setQuarantineView] = useState<{ movieId: string; seeds: number[] } | null>(null)
    // <768 用卡片视图: Catalog 宽表格在窄屏按容器重新分配列宽, 前方列被挤压 (维护者 2026-09-30)
    const screens = Grid.useBreakpoint()
    const catalogAsCards = !screens.md
    const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useQuery({
        queryKey: ["gacha-seed-status"],
        queryFn: () => apiGet<SeedStatus>("/api/seeds/status"),
        refetchInterval: 30_000,
    })

    const refresh = () => {
        queryClient.invalidateQueries({ queryKey: ["gacha-seed-status"] })
    }

    const rows = data
        ? data.catalog.movies.map(movie => ({
            ...movie,
            key: movie.movieId,
            total: movie.rarityCounts["3"] + movie.rarityCounts["4"] + movie.rarityCounts["5"],
            quarantined: data.quarantine.movies[movie.movieId] ?? 0,
        }))
        : []
    const quarantineRows = useMemo(() => (data
        ? Object.entries(data.quarantine.samples).map(([movieId, seeds]) => ({
            movieId,
            seeds,
        }))
        : []), [data])

    return (
        <AdminPage
            eyebrow="SEEDS"
            title="动画种子"
            description="Faithful Catalog 运行状态"
            onRefresh={refresh}
            refreshing={isFetching}
            actions={
                dataUpdatedAt > 0 && (
                    <span className="admin-seed-refresh">
                        最后刷新 {formatClock(dataUpdatedAt)}
                        <span className="admin-badge-ok">30s 自动</span>
                    </span>
                )
            }
        >
            <Space direction="vertical" size="large" className="admin-stack">
                {isLoading ? (
                    <StateCard><Spin size="large" /></StateCard>
                ) : isError || !data ? (
                    <Alert
                        type="error"
                        showIcon
                        message="动画种子状态不可用"
                        action={<Button onClick={() => refetch()}>重试</Button>}
                    />
                ) : (
                    <>
                        <div className="admin-stat-band admin-seed-stats">
                            <div className="admin-stat-band-item">
                                <span className="admin-stat-band-label">客户端</span>
                                <span className="admin-stat-band-value">{data.catalog.clientVersion}</span>
                            </div>
                            <div className="admin-stat-band-item">
                                <span className="admin-stat-band-label">CDN</span>
                                <span className="admin-stat-band-value">{data.catalog.cdnVersion}</span>
                            </div>
                            <div className="admin-stat-band-item">
                                <span className="admin-stat-band-label">分类记录</span>
                                <span className="admin-stat-band-value">{data.catalog.totalSeedCount}</span>
                            </div>
                            <div className="admin-stat-band-item">
                                <span className="admin-stat-band-label">本机隔离</span>
                                <span className={data.quarantine.total > 0
                                    ? "admin-stat-band-value admin-seed-stat-alert"
                                    : "admin-stat-band-value"}
                                >
                                    {data.quarantine.total}
                                </span>
                            </div>
                        </div>

                        <Card title="Catalog 分布" className="admin-table-card">
                            {catalogAsCards && (
                                <div className="admin-seed-catalog-cards">
                                    {rows.map(row => (
                                        <div className="admin-seed-catalog-card" key={row.movieId}>
                                            <div className="admin-mobile-list-heading">
                                                <span className="admin-mobile-heading-main">
                                                    <Typography.Text strong>{MOVIE_LABELS[row.movieId] ?? row.movieId}</Typography.Text>
                                                    <Typography.Text type="secondary">{row.movieId}</Typography.Text>
                                                </span>
                                                <Typography.Text>合计 {row.total}</Typography.Text>
                                            </div>
                                            {row.total > 0 && (
                                                <div className="admin-seed-ratio">
                                                    <div className="admin-seed-ratio-bar" aria-hidden>
                                                        {RARITY_RATIO_COLORS.map(({ rarity, color }) => (
                                                            <span
                                                                key={rarity}
                                                                style={{ flex: row.rarityCounts[rarity], background: color }}
                                                            />
                                                        ))}
                                                    </div>
                                                    <span className="admin-seed-ratio-text admin-mono">
                                                        {RARITY_RATIO_COLORS.map(({ rarity }) => (
                                                            <span key={rarity}>
                                                                {rarity}★ {Math.round(row.rarityCounts[rarity] * 100 / row.total)}
                                                                {rarity === "5" ? "" : " · "}
                                                            </span>
                                                        ))}
                                                    </span>
                                                </div>
                                            )}
                                            <div className="admin-mobile-detail-list">
                                                <div><span>★3</span><strong>{row.rarityCounts["3"]}</strong></div>
                                                <div><span>★4</span><strong>{row.rarityCounts["4"]}</strong></div>
                                                <div><span>★5</span><strong>{row.rarityCounts["5"]}</strong></div>
                                                <div>
                                                    <span>隔离</span>
                                                    <strong>{row.quarantined > 0
                                                        ? <span className="admin-badge-warn">{row.quarantined}</span>
                                                        : <span className="admin-muted">0</span>}
                                                    </strong>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {!catalogAsCards && ( <>
                            <Table
                                size="small"
                                pagination={false}
                                scroll={{ x: 870 }}
                                tableLayout="fixed"
                                dataSource={rows}
                                columns={[
                                    {
                                        title: "Movie",
                                        dataIndex: "movieId",
                                        width: 190,
                                        render: (movieId: string) => (
                                            <Space>
                                                <Text strong>{MOVIE_LABELS[movieId] ?? movieId}</Text>
                                                <Text type="secondary">{movieId}</Text>
                                            </Space>
                                        ),
                                    },
                                    { title: "★3", dataIndex: ["rarityCounts", "3"], align: "right", width: 100 },
                                    { title: "★4", dataIndex: ["rarityCounts", "4"], align: "right", width: 100 },
                                    { title: "★5", dataIndex: ["rarityCounts", "5"], align: "right", width: 100 },
                                    {
                                        title: "构成占比",
                                        key: "ratio",
                                        width: 190,
                                        render: (_, row) => {
                                            const total = row.total
                                            if (total <= 0) return <span className="admin-muted">-</span>
                                            return (
                                                <div className="admin-seed-ratio">
                                                    <div className="admin-seed-ratio-bar" aria-hidden>
                                                        {RARITY_RATIO_COLORS.map(({ rarity, color }) => (
                                                            <span
                                                                key={rarity}
                                                                style={{ flex: row.rarityCounts[rarity], background: color }}
                                                            />
                                                        ))}
                                                    </div>
                                                    <span className="admin-seed-ratio-text admin-mono">
                                                        {RARITY_RATIO_COLORS.map(({ rarity }) => (
                                                            <span key={rarity}>
                                                                {rarity}★ {Math.round(row.rarityCounts[rarity] * 100 / total)}
                                                                {rarity === "5" ? "" : " · "}
                                                            </span>
                                                        ))}
                                                    </span>
                                                </div>
                                            )
                                        },
                                    },
                                    { title: "合计", dataIndex: "total", align: "right", width: 110 },
                                    {
                                        title: "隔离",
                                        dataIndex: "quarantined",
                                        align: "right",
                                        width: 80,
                                        render: (count: number) => count > 0
                                            ? <span className="admin-badge-warn">{count}</span>
                                            : <span className="admin-muted">0</span>,
                                    },
                                ]}
                            />
                            <Text type="secondary">
                                Seed {data.catalog.seedRange.start.toLocaleString()} - {data.catalog.seedRange.end.toLocaleString()}
                            </Text>
                            </> )}
                        </Card>

                        <Card title="Quarantine" className="admin-table-card">
                            {data.quarantine.total === 0 ? (
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无隔离记录" />
                            ) : (
                                <Table
                                    size="small"
                                    pagination={false}
                                    rowKey="movieId"
                                    dataSource={quarantineRows}
                                    columns={[
                                        {
                                            title: "Movie",
                                            dataIndex: "movieId",
                                            width: 190,
                                            render: (movieId: string) => (
                                                <Space>
                                                    <Text strong>{MOVIE_LABELS[movieId] ?? movieId}</Text>
                                                    <Text type="secondary">{movieId}</Text>
                                                </Space>
                                            ),
                                        },
                                        {
                                            title: "隔离种子",
                                            dataIndex: "seeds",
                                            render: (seeds: number[]) => (
                                                <Space wrap size={[6, 6]}>
                                                    {seeds.map(seed => <Tag key={seed}>{seed}</Tag>)}
                                                </Space>
                                            ),
                                        },
                                        {
                                            title: "操作",
                                            key: "view",
                                            width: 90,
                                            render: (_, row) => (
                                                <Button size="small" onClick={() => setQuarantineView(row)}>
                                                    查看
                                                </Button>
                                            ),
                                        },
                                    ]}
                                />
                            )}
                        </Card>

                        <Modal
                            open={quarantineView !== null}
                            title={quarantineView
                                ? `隔离详情 · ${MOVIE_LABELS[quarantineView.movieId] ?? quarantineView.movieId}`
                                : "隔离详情"}
                            footer={null}
                            width="min(92vw, 560px)"
                            onCancel={() => setQuarantineView(null)}
                        >
                            {quarantineView && (
                                <Space direction="vertical" size="middle" className="admin-stack">
                                    <div className="admin-page-note">
                                        <Typography.Text strong>{quarantineView.movieId}</Typography.Text>
                                        <Typography.Text type="secondary">
                                            命中 {quarantineView.seeds.length} 个种子
                                        </Typography.Text>
                                    </div>
                                    <div>
                                        <Typography.Text type="secondary">Catalog 种子区间</Typography.Text>
                                        <div className="admin-mono">
                                            Seed {data.catalog.seedRange.start.toLocaleString()} - {data.catalog.seedRange.end.toLocaleString()}
                                        </div>
                                    </div>
                                    <div>
                                        <Typography.Text type="secondary">命中记录</Typography.Text>
                                        <div>
                                            <Space wrap size={[6, 6]} className="admin-seed-quarantine-tags">
                                                {quarantineView.seeds.map(seed => <Tag key={seed}>{seed}</Tag>)}
                                            </Space>
                                        </div>
                                    </div>
                                </Space>
                            )}
                        </Modal>
                    </>
                )}
                <div className="admin-page-note admin-page-note-footer">
                    <Typography.Text strong>种子状态说明</Typography.Text>
                    <Typography.Text type="secondary">
                        状态每 30 秒自动刷新；「Catalog 分布」为当前动画种子库的稀有度分布，「Quarantine」列出本机被隔离的种子样本。
                    </Typography.Text>
                </div>
            </Space>
        </AdminPage>
    )
}
