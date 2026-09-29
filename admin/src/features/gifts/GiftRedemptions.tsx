import { useState } from "react"
import { Alert, Button, Card, Input, Select, Space, Table } from "antd"
import { useQuery } from "@tanstack/react-query"

import { apiGet } from "../../api/client"
import type { AdminGiftRow, GiftRedemptionPage, GiftRedemptionRow } from "./types"

interface GiftRedemptionsProps {
    gift: AdminGiftRow
    /** 页面已加载的礼包行（含 code），供面板内按 code 切换查看；数据逻辑不动。 */
    gifts?: readonly AdminGiftRow[]
    onGiftChange?: (gift: AdminGiftRow) => void
    onClose: () => void
}

export default function GiftRedemptions({ gift, gifts, onGiftChange, onClose }: GiftRedemptionsProps) {
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
            extra={(
                <Space>
                    <span className={gift.redemptionCount > 0 ? "admin-badge-info" : "admin-badge-muted"}>
                        已领取 {gift.redemptionCount}
                    </span>
                    <Button onClick={onClose}>关闭</Button>
                </Space>
            )}
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
                <Space wrap size="small" className="gift-redemption-filters">
                    {gifts !== undefined && gifts.length > 0 && onGiftChange !== undefined && (
                        <Select
                            value={gift.id}
                            showSearch
                            optionFilterProp="label"
                            placeholder="按 code 筛选"
                            style={{ minWidth: 200 }}
                            onChange={nextId => {
                                const next = gifts.find(g => g.id === nextId)
                                if (next !== undefined) {
                                    setPage(1)
                                    setSearch("")
                                    onGiftChange(next)
                                }
                            }}
                            options={gifts.map(g => ({
                                value: g.id,
                                label: `${g.code}（已领取 ${g.redemptionCount}）`,
                            }))}
                        />
                    )}
                    <Input
                        value={search}
                        placeholder="搜索玩家名或精确 Player/Account ID"
                        onChange={event => setSearch(event.target.value)}
                        allowClear
                        style={{ minWidth: 220 }}
                    />
                </Space>
                <Table<GiftRedemptionRow>
                    rowKey="playerId"
                    loading={redemptions.isLoading}
                    dataSource={redemptions.data?.rows ?? []}
                    scroll={{ x: "max-content" }}
                    tableLayout="fixed"
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
                        { title: "Account ID", dataIndex: "accountId", width: 120, responsive: ["sm"] as any },
                        { title: "玩家名", dataIndex: "playerName", width: 180 },
                        {
                            title: "领取时间",
                            dataIndex: "redeemedAt",
                            width: 190,
                            responsive: ["sm"] as any,
                            render: value => new Date(value).toLocaleString("zh-CN"),
                        },
                        { title: "奖励版本", dataIndex: "rewardRevision", width: 100, responsive: ["sm"] as any },
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
                            responsive: ["sm"] as any,
                            render: (value: boolean) => (value
                                ? <span className="admin-badge-info">是</span>
                                : <span className="admin-badge-muted">否</span>),
                        },
                        {
                            title: "来源 Player",
                            dataIndex: "sourcePlayerId",
                            width: 130,
                            responsive: ["sm"] as any,
                            render: (value: number | null) => (value === null ? "-" : `#${value}`),
                        },
                    ]}
                />
            </Space>
        </Card>
    )
}
