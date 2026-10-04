import { useState } from "react"
import { Alert, Button, Input, Table } from "antd"
import { useQuery } from "@tanstack/react-query"

import { apiGet } from "../../api/client"
import type { AdminGiftRow, GiftRedemptionPage, GiftRedemptionRow } from "./types"

interface GiftRedemptionsProps {
    gift: AdminGiftRow
}

// 领取记录内嵌面板（2026-10-04 卡片化改造）：渲染在对应礼包卡的展开区内，不再作为
// 独立 Card 出现——标题/关闭按钮/跨礼包 code 切换随卡片化移除(每卡自带本礼包记录,
// 切换即收起展开另一卡)。queryKey/API 与原面板逐字一致, 失效逻辑不受影响。
export default function GiftRedemptions({ gift }: GiftRedemptionsProps) {
    const [page, setPage] = useState(1)
    const [pageSize, setPageSize] = useState(20)
    const [search, setSearch] = useState("")

    const redemptions = useQuery({
        queryKey: ["adminGiftRedemptions", gift.id, page, pageSize, search],
        queryFn: () => apiGet<GiftRedemptionPage>(`/api/gifts/${gift.id}/redemptions?page=${page}&pageSize=${pageSize}&q=${encodeURIComponent(search)}`),
    })

    return (
        <div className="gift-redemption-embed">
            {redemptions.isError && (
                <Alert
                    type="error"
                    showIcon
                    message="领取记录不可用"
                    action={<Button onClick={() => redemptions.refetch()}>重试</Button>}
                />
            )}
            <div className="gift-redemption-filters">
                <span className={gift.redemptionCount > 0 ? "admin-badge-info" : "admin-badge-muted"}>
                    已领取 {gift.redemptionCount}
                </span>
                <Input
                    value={search}
                    placeholder="搜索玩家名或精确 Player/Account ID"
                    onChange={event => setSearch(event.target.value)}
                    allowClear
                />
            </div>
            <Table<GiftRedemptionRow>
                rowKey="playerId"
                size="small"
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
        </div>
    )
}
