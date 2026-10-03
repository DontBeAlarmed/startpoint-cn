import { useState } from "react"
import {
    Alert,
    Button,
    Card,
    Grid,
    Popconfirm,
    Space,
    Table,
    Typography,
    message,
} from "antd"
import { Eye, Pencil, Plus } from "lucide-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { ApiError, apiDelete, apiGet, apiPost } from "../api/client"
import { AdminPage } from "../components/AdminPage"
import GiftEditor from "../features/gifts/GiftEditor"
import GiftRedemptions from "../features/gifts/GiftRedemptions"
import { GiftsMobileView } from "../features/gifts/GiftsMobileView"
import { giftRewardChipTexts } from "../features/gifts/rewardDisplay"
import type { AdminGiftRow, GiftPage } from "../features/gifts/types"

function invalidateGifts(queryClient: ReturnType<typeof useQueryClient>, id?: number) {
    queryClient.invalidateQueries({ queryKey: ["adminGifts"] })
    if (id !== undefined) {
        queryClient.invalidateQueries({ queryKey: ["adminGiftRedemptions", id] })
    }
}

interface CharacterLookupRow {
    readonly name: string
    readonly title: string
}

interface EquipmentLookupRow {
    readonly name: string
}

type CharacterLookup = Record<string, CharacterLookupRow>
type EquipmentLookup = Record<string, EquipmentLookupRow>

const { useBreakpoint } = Grid

export default function Gifts() {
    const queryClient = useQueryClient()
    const screens = useBreakpoint()
    const isMobile = !screens.md
    const [page, setPage] = useState(1)
    const [pageSize, setPageSize] = useState(20)
    const [editorGift, setEditorGift] = useState<AdminGiftRow | null>(null)
    const [editorOpen, setEditorOpen] = useState(false)
    const [redemptionGift, setRedemptionGift] = useState<AdminGiftRow | null>(null)

    const gifts = useQuery({
        queryKey: ["adminGifts", page, pageSize],
        queryFn: () => apiGet<GiftPage>(`/api/gifts?page=${page}&pageSize=${pageSize}`),
    })

    // 奖励对象名称化：与邮件/玩家详情共用 /api/lookup 只读接口（queryKey 同 Mail 模式）。
    const { data: itemLookup = {} } = useQuery({
        queryKey: ["mailAttachmentLookup", 1],
        queryFn: () => apiGet<Record<string, string>>("/api/lookup/items"),
        staleTime: Infinity,
    })
    const { data: characterLookup = {} } = useQuery({
        queryKey: ["mailAttachmentLookup", 5],
        queryFn: () => apiGet<CharacterLookup>("/api/lookup/characters"),
        staleTime: Infinity,
    })
    const { data: equipmentLookup = {} } = useQuery({
        queryKey: ["mailAttachmentLookup", 6],
        queryFn: () => apiGet<EquipmentLookup>("/api/lookup/equipment"),
        staleTime: Infinity,
    })
    const rewardLookups = { items: itemLookup, characters: characterLookup, equipment: equipmentLookup }

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

    const refresh = () => {
        queryClient.invalidateQueries({ queryKey: ["adminGifts"] })
        queryClient.invalidateQueries({ queryKey: ["adminGiftRedemptions"] })
    }

    return (
        <AdminPage
            eyebrow="GIFTS"
            title="礼包"
            description="维护公共兑换 code 和奖励定义；领取记录只用于运营查看。"
            onRefresh={refresh}
            refreshing={gifts.isFetching}
        >
            <Space direction="vertical" size="large" className="admin-stack">
                <div className="admin-page-note">
                    <Typography.Text strong>礼包维护须知</Typography.Text>
                    <Typography.Text type="secondary">
                        删除礼包不可恢复，会清除全部领取记录，同 code 重建后可重新领取；启动中的礼包不提供编辑入口，需先停止再修改。
                    </Typography.Text>
                </div>
                {gifts.isError && (
                    <Alert
                        type="error"
                        showIcon
                        message="礼包列表不可用"
                        action={<Button onClick={() => gifts.refetch()}>重试</Button>}
                    />
                )}
                {/* <768px 走账号页已验证的移动卡片视图；>=768px 桌面表格一字不动 */}
                {isMobile && (
                    <Card
                        title="公共礼包"
                        className="admin-mobile-list-card"
                        extra={(
                            <Button
                                type="primary"
                                size="small"
                                icon={<Plus size={14} />}
                                onClick={() => {
                                    setEditorGift(null)
                                    setEditorOpen(true)
                                }}
                            >
                                新建礼包
                            </Button>
                        )}
                    >
                        <GiftsMobileView
                            rows={gifts.data?.rows ?? []}
                            loading={gifts.isLoading}
                            page={page}
                            pageSize={pageSize}
                            totalCount={gifts.data?.totalCount ?? 0}
                            rewardLookups={rewardLookups}
                            onPageChange={(nextPage, nextPageSize) => {
                                setPage(nextPage)
                                setPageSize(nextPageSize)
                            }}
                            onStart={row => start.mutateAsync(row)}
                            onStop={row => stop.mutateAsync(row)}
                            onEdit={row => {
                                setEditorGift(row)
                                setEditorOpen(true)
                            }}
                            onDelete={row => remove.mutateAsync(row)}
                            onOpenRedemptions={setRedemptionGift}
                        />
                    </Card>
                )}
                {!isMobile && (
                    <Card
                        title="公共礼包"
                        className="admin-table-card"
                        extra={(
                            <Button
                                type="primary"
                                size="small"
                                icon={<Plus size={14} />}
                                onClick={() => {
                                    setEditorGift(null)
                                    setEditorOpen(true)
                                }}
                            >
                                新建礼包
                            </Button>
                        )}
                    >
                        <Table<AdminGiftRow>
                            rowKey="id"
                            className="admin-ops-table"
                            loading={gifts.isLoading}
                            dataSource={gifts.data?.rows ?? []}
                            scroll={{ x: "max-content" }}
                            tableLayout="fixed"
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
                                { title: "Code", dataIndex: "code", width: 150, render: (_: unknown, row) => <span className="gift-code-cell">{row.code}</span> },
                                {
                                    title: "状态",
                                    dataIndex: "status",
                                    width: 90,
                                    responsive: ["sm"] as any,
                                    render: (_, row) => (
                                        <span className={row.status === "active" ? "admin-badge-ok" : "admin-badge-muted"}>
                                            {row.status === "active" ? "启用" : "停止"}
                                        </span>
                                    ),
                                },
                                {
                                    title: "奖励",
                                    dataIndex: "rewards",
                                    width: 280,
                                    responsive: ["sm"] as any,
                                    render: (_, row) => {
                                        const chips = giftRewardChipTexts(row.rewards, rewardLookups)
                                        return (
                                            <span className="gift-reward-chips">
                                                {chips.slice(0, 2).map((text, index) => (
                                                    <span key={index} className="gift-reward-chip">{text}</span>
                                                ))}
                                                {chips.length > 2 && (
                                                    <span
                                                        className="gift-reward-chip gift-reward-chip-more"
                                                        title={chips.join("\n")}
                                                    >
                                                        +{chips.length - 2}
                                                    </span>
                                                )}
                                            </span>
                                        )
                                    },
                                },
                                { title: "奖励版本", dataIndex: "rewardRevision", width: 100, responsive: ["sm"] as any },
                                { title: "版本", dataIndex: "revision", width: 80, responsive: ["sm"] as any },
                                { title: "已领取", dataIndex: "redemptionCount", width: 90, responsive: ["sm"] as any },
                                {
                                    title: "更新时间",
                                    dataIndex: "updatedAt",
                                    width: 190,
                                    responsive: ["sm"] as any,
                                    render: value => new Date(value).toLocaleString("zh-CN"),
                                },
                                {
                                    title: "操作",
                                    fixed: "right",
                                    width: 250,
                                    render: (_, row) => {
                                        if (row.status === "stopped") return (
                                            <Space className="admin-action-row">
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
                                                    <Button size="small" type="text" danger>
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
                                            <Space className="admin-action-row">
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
                )}
                {redemptionGift && (
                    <GiftRedemptions
                        gift={redemptionGift}
                        gifts={gifts.data?.rows ?? []}
                        onGiftChange={setRedemptionGift}
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
