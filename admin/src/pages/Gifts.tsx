import { useState } from "react"
import {
    Alert,
    Button,
    Card,
    Popconfirm,
    Space,
    Table,
    Tag,
    message,
} from "antd"
import { Eye, Pencil, Plus, Trash2 } from "lucide-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { ApiError, apiDelete, apiGet, apiPost } from "../api/client"
import { AdminPage } from "../components/AdminPage"
import GiftEditor from "../features/gifts/GiftEditor"
import GiftRedemptions from "../features/gifts/GiftRedemptions"
import type { AdminGiftRow, GiftPage } from "../features/gifts/types"

function invalidateGifts(queryClient: ReturnType<typeof useQueryClient>, id?: number) {
    queryClient.invalidateQueries({ queryKey: ["adminGifts"] })
    if (id !== undefined) {
        queryClient.invalidateQueries({ queryKey: ["adminGiftRedemptions", id] })
    }
}

function rewardSummary(row: AdminGiftRow): string {
    return row.rewards.map(reward => {
        const objectText = reward.typeId === null ? "" : ` #${reward.typeId}`
        return `${reward.type}${objectText} x${reward.number}`
    }).join(", ")
}

export default function Gifts() {
    const queryClient = useQueryClient()
    const [page, setPage] = useState(1)
    const [pageSize, setPageSize] = useState(20)
    const [editorGift, setEditorGift] = useState<AdminGiftRow | null>(null)
    const [editorOpen, setEditorOpen] = useState(false)
    const [redemptionGift, setRedemptionGift] = useState<AdminGiftRow | null>(null)

    const gifts = useQuery({
        queryKey: ["adminGifts", page, pageSize],
        queryFn: () => apiGet<GiftPage>(`/api/gifts?page=${page}&pageSize=${pageSize}`),
    })

    const start = useMutation({
        mutationFn: (row: AdminGiftRow) => apiPost<AdminGiftRow>(`/api/gifts/${row.id}/start`, { revision: row.revision }),
        onSuccess: row => {
            message.success("礼包已启动")
            invalidateGifts(queryClient, row.id)
        },
        onError: (error: Error) => {
            message.error(error instanceof ApiError && error.status === 409
                ? "礼包已被其他操作修改，请刷新"
                : error.message)
        },
    })

    const stop = useMutation({
        mutationFn: (row: AdminGiftRow) => apiPost<AdminGiftRow>(`/api/gifts/${row.id}/stop`, { revision: row.revision }),
        onSuccess: row => {
            message.success("礼包已停止")
            invalidateGifts(queryClient, row.id)
        },
        onError: (error: Error) => {
            message.error(error instanceof ApiError && error.status === 409
                ? "礼包已被其他操作修改，请刷新"
                : error.message)
        },
    })

    const remove = useMutation({
        mutationFn: (row: AdminGiftRow) => apiDelete<{ ok: boolean }>(`/api/gifts/${row.id}?revision=${row.revision}`),
        onSuccess: (_result, row) => {
            message.success("礼包已删除")
            setRedemptionGift(current => current?.id === row.id ? null : current)
            invalidateGifts(queryClient)
        },
        onError: (error: Error) => {
            message.error(error instanceof ApiError && error.status === 409
                ? "礼包已被其他操作修改，请刷新"
                : error.message)
        },
    })

    return (
        <AdminPage
            eyebrow="OPERATIONS"
            title="礼包"
            description="维护公共兑换 code 和奖励定义；领取记录只用于运营查看。"
            actions={(
                <Button
                    type="primary"
                    icon={<Plus size={16} />}
                    onClick={() => {
                        setEditorGift(null)
                        setEditorOpen(true)
                    }}
                >
                    新建礼包
                </Button>
            )}
        >
            <Space direction="vertical" size="large" className="admin-stack">
                {gifts.isError && (
                    <Alert
                        type="error"
                        showIcon
                        message="礼包列表不可用"
                        action={<Button onClick={() => gifts.refetch()}>重试</Button>}
                    />
                )}
                <Card title="公共礼包" className="admin-table-card">
                    <Table<AdminGiftRow>
                        rowKey="id"
                        loading={gifts.isLoading}
                        dataSource={gifts.data?.rows ?? []}
                        scroll={{ x: "max-content" }}
                        locale={{ emptyText: "暂无礼包" }}
                        pagination={{
                            current: page,
                            pageSize,
                            total: gifts.data?.totalCount ?? 0,
                            showSizeChanger: true,
                            onChange: (nextPage, nextPageSize) => {
                                setPage(nextPage)
                                setPageSize(nextPageSize)
                            },
                        }}
                        columns={[
                            { title: "Code", dataIndex: "code", width: 180 },
                            {
                                title: "状态",
                                dataIndex: "status",
                                width: 90,
                                render: (_, row) => (
                                    <Tag color={row.status === "active" ? "green" : "default"}>
                                        {row.status === "active" ? "启用" : "停止"}
                                    </Tag>
                                ),
                            },
                            {
                                title: "奖励",
                                dataIndex: "rewards",
                                width: 280,
                                render: (_, row) => rewardSummary(row),
                            },
                            { title: "奖励版本", dataIndex: "rewardRevision", width: 100 },
                            { title: "版本", dataIndex: "revision", width: 80 },
                            { title: "已领取", dataIndex: "redemptionCount", width: 90 },
                            {
                                title: "更新时间",
                                dataIndex: "updatedAt",
                                width: 190,
                                render: value => new Date(value).toLocaleString("zh-CN"),
                            },
                            {
                                title: "操作",
                                fixed: "right",
                                width: 250,
                                render: (_, row) => {
                                    if (row.status === "stopped") return (
                                        <Space>
                                            <Button
                                                size="small"
                                                loading={start.isPending && start.variables?.id === row.id}
                                                onClick={() => start.mutate(row)}
                                            >
                                                启动
                                            </Button>
                                            <Button
                                                size="small"
                                                icon={<Pencil size={15} />}
                                                onClick={() => {
                                                    setEditorGift(row)
                                                    setEditorOpen(true)
                                                }}
                                            >
                                                编辑
                                            </Button>
                                            <Popconfirm
                                                title="删除这个礼包？"
                                                description="此操作不可恢复，将清除全部领取记录，同 code 重建后可重新领取。"
                                                okText="删除"
                                                cancelText="取消"
                                                okButtonProps={{ danger: true }}
                                                onConfirm={() => remove.mutate(row)}
                                            >
                                                <Button danger size="small" icon={<Trash2 size={15} />}>
                                                    删除
                                                </Button>
                                            </Popconfirm>
                                            <Button
                                                size="small"
                                                icon={<Eye size={15} />}
                                                onClick={() => setRedemptionGift(row)}
                                            >
                                                记录
                                            </Button>
                                        </Space>
                                    )
                                    return (
                                        <Space>
                                            <Button
                                                size="small"
                                                loading={stop.isPending && stop.variables?.id === row.id}
                                                onClick={() => stop.mutate(row)}
                                            >
                                                {row.status === "active" ? "停止" : "启动"}
                                            </Button>
                                            <Button
                                                size="small"
                                                icon={<Eye size={15} />}
                                                onClick={() => setRedemptionGift(row)}
                                            >
                                                记录
                                            </Button>
                                        </Space>
                                    )
                                },
                            },
                        ]}
                    />
                </Card>
                {redemptionGift && (
                    <GiftRedemptions
                        gift={redemptionGift}
                        onClose={() => setRedemptionGift(null)}
                    />
                )}
            </Space>
            <GiftEditor
                gift={editorGift}
                open={editorOpen}
                onClose={() => setEditorOpen(false)}
                onSaved={row => invalidateGifts(queryClient, row.id)}
            />
        </AdminPage>
    )
}
