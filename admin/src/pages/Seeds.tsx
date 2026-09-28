import { Alert, Button, Card, Empty, Space, Spin, Table, Tag, Typography } from "antd"
import { ReloadOutlined } from "@ant-design/icons"
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

export default function Seeds() {
    const queryClient = useQueryClient()
    const { data, isLoading, isError, isFetching, refetch } = useQuery({
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
    const quarantineRows = data
        ? Object.entries(data.quarantine.samples).map(([movieId, seeds]) => ({
            movieId,
            seeds,
        }))
        : []

    return (
        <AdminPage
            eyebrow="SEEDS"
            title="动画种子"
            description="Faithful Catalog 运行状态"
            actions={
                <Button icon={<ReloadOutlined />} loading={isFetching} onClick={refresh}>
                    刷新
                </Button>
            }
        >
            <Space direction="vertical" size="large" className="admin-stack">
                <div className="admin-page-note">
                    <Typography.Text strong>种子状态说明</Typography.Text>
                    <Typography.Text type="secondary">
                        状态每 30 秒自动刷新；「Catalog 分布」为当前动画种子库的稀有度分布，「Quarantine」列出本机被隔离的种子样本。
                    </Typography.Text>
                </div>
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
                            <Table
                                size="small"
                                pagination={false}
                                scroll={{ x: 680 }}
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
                                    ]}
                                />
                            )}
                        </Card>
                    </>
                )}
            </Space>
        </AdminPage>
    )
}
