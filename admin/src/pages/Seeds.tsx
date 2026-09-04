import { Alert, Card, Col, Empty, Row, Space, Spin, Statistic, Table, Tag, Typography } from "antd"
import { useQuery } from "@tanstack/react-query"

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
    const { data, isLoading, isError } = useQuery({
        queryKey: ["gacha-seed-status"],
        queryFn: () => apiGet<SeedStatus>("/api/seeds/status"),
        refetchInterval: 30_000,
    })

    if (isLoading) return <StateCard><Spin size="large" /></StateCard>
    if (isError || !data) {
        return <Alert type="error" showIcon message="动画种子状态不可用" />
    }

    const rows = data.catalog.movies.map(movie => ({
        ...movie,
        key: movie.movieId,
        total: movie.rarityCounts["3"] + movie.rarityCounts["4"] + movie.rarityCounts["5"],
        quarantined: data.quarantine.movies[movie.movieId] ?? 0,
    }))
    const quarantineRows = Object.entries(data.quarantine.samples).map(([movieId, seeds]) => ({
        movieId,
        seeds,
    }))

    return (
        <AdminPage eyebrow="GACHA MOVIE" title="动画种子" description="Faithful Catalog 运行状态">
            <Space direction="vertical" size="large" className="admin-stack">
                <Row gutter={[16, 16]}>
                    <Col xs={12} lg={6}>
                        <Card size="small" className="admin-stat-tick"><Statistic title="客户端" value={data.catalog.clientVersion} /></Card>
                    </Col>
                    <Col xs={12} lg={6}>
                        <Card size="small" className="admin-stat-tick"><Statistic title="CDN" value={data.catalog.cdnVersion} /></Card>
                    </Col>
                    <Col xs={12} lg={6}>
                        <Card size="small" className="admin-stat-tick"><Statistic title="分类记录" value={data.catalog.totalSeedCount} /></Card>
                    </Col>
                    <Col xs={12} lg={6}>
                        <Card size="small" className="admin-stat-tick">
                            <Statistic
                                title="本机隔离"
                                value={data.quarantine.total}
                                valueStyle={data.quarantine.total > 0 ? { color: "var(--thunder)" } : undefined}
                            />
                        </Card>
                    </Col>
                </Row>

                <Card title="Catalog 分布" size="small">
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

                <Card title="Quarantine" size="small" className="admin-table-card">
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
            </Space>
        </AdminPage>
    )
}
