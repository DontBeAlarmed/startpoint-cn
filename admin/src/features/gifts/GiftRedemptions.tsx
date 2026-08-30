import { useState } from "react"
import { Alert, Button, Card, Input, Space, Table } from "antd"
import { useQuery } from "@tanstack/react-query"

import { apiGet } from "../../api/client"
import type { AdminGiftRow, GiftRedemptionPage, GiftRedemptionRow } from "./types"

interface GiftRedemptionsProps {
    gift: AdminGiftRow
    onClose: () => void
}

export default function GiftRedemptions({ gift, onClose }: GiftRedemptionsProps) {
    const [page, setPage] = useState(1)
    const [pageSize, setPageSize] = useState(20)
    const [search, setSearch] = useState("")

    const redemptions = useQuery({
        queryKey: ["adminGiftRedemptions", gift.id, page, pageSize, search],
        queryFn: () => apiGet<GiftRedemptionPage>(`/api/gifts/${gift.id}/redemptions?page=${page}&pageSize=${pageSize}&q=${encodeURIComponent(search)}`),
    })

    return (
        <Card
            title={`领取记录 · ${gift.code}`}
            extra={<Button onClick={onClose}>关闭</Button>}
            className="admin-table-card"
        >
            <Space direction="vertical" size="large" className="admin-stack">
                {redemptions.isError && (
                    <Alert
                        type="error"
                        showIcon
                        message="领取记录不可用"
                        action={<Button onClick={() => redemptions.refetch()}>重试</Button>}
                    />
                )}
                <Input
                    value={search}
                    placeholder="搜索玩家名或精确 Player/Account ID"
                    onChange={event => setSearch(event.target.value)}
                    allowClear
                />
                <Table<GiftRedemptionRow>
                    rowKey="playerId"
                    loading={redemptions.isLoading}
                    dataSource={redemptions.data?.rows ?? []}
                    scroll={{ x: "max-content" }}
                    locale={{ emptyText: "暂无领取记录" }}
                    pagination={{
                        current: page,
                        pageSize,
                        total: redemptions.data?.totalCount ?? 0,
                        showSizeChanger: true,
                        onChange: (nextPage, nextPageSize) => {
                            setPage(nextPage)
                            setPageSize(nextPageSize)
                        },
                    }}
                    columns={[
                        { title: "Player ID", dataIndex: "playerId", width: 110 },
                        { title: "Account ID", dataIndex: "accountId", width: 120 },
                        { title: "玩家名", dataIndex: "playerName", width: 180 },
                        {
                            title: "领取时间",
                            dataIndex: "redeemedAt",
                            width: 190,
                            render: value => new Date(value).toLocaleString("zh-CN"),
                        },
                        { title: "奖励版本", dataIndex: "rewardRevision", width: 100 },
                        {
                            title: "奖励快照",
                            dataIndex: "rewardSnapshot",
                            render: value => (
                                <pre className="gift-redemption-snapshot">
                                    {JSON.stringify(value, null, 2)}
                                </pre>
                            ),
                        },
                        {
                            title: "继承",
                            dataIndex: "inherited",
                            width: 90,
                            render: (value: boolean) => (value ? "是" : "否"),
                        },
                        {
                            title: "来源 Player",
                            dataIndex: "sourcePlayerId",
                            width: 130,
                            render: (value: number | null) => (value === null ? "-" : `#${value}`),
                        },
                    ]}
                />
            </Space>
        </Card>
    )
}
