import { useState } from "react"
import {
    Alert,
    Button,
    Card,
    Space,
    Typography,
    message,
} from "antd"
import { Plus } from "lucide-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { ApiError, apiDelete, apiGet, apiPost } from "../api/client"
import { AdminPage } from "../components/AdminPage"
import GiftEditor from "../features/gifts/GiftEditor"
import { GiftsCardView } from "../features/gifts/GiftsCardView"
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

export default function Gifts() {
    const queryClient = useQueryClient()
    const [page, setPage] = useState(1)
    const [pageSize, setPageSize] = useState(20)
    const [editorGift, setEditorGift] = useState<AdminGiftRow | null>(null)
    const [editorOpen, setEditorOpen] = useState(false)
    // 领取记录内嵌在对应礼包卡内展开(同账号页存档列表模式), 单开互斥
    const [expandedGiftId, setExpandedGiftId] = useState<number | null>(null)

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
            setExpandedGiftId(current => current === row.id ? null : current)
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
                {gifts.isError && (
                    <Alert
                        type="error"
                        showIcon
                        message="礼包列表不可用"
                        action={<Button onClick={() => gifts.refetch()}>重试</Button>}
                    />
                )}
                {/* 2026-10-04 卡片化改造: 双视口统一卡片(同账号页 acc-card 结构),
                    领取记录内嵌进对应礼包卡展开; 原桌面表格/移动 List 撤销 */}
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
                    <GiftsCardView
                        rows={gifts.data?.rows ?? []}
                        loading={gifts.isLoading}
                        page={page}
                        pageSize={pageSize}
                        totalCount={gifts.data?.totalCount ?? 0}
                        rewardLookups={rewardLookups}
                        expandedGiftId={expandedGiftId}
                        onToggleExpand={id => setExpandedGiftId(current => current === id ? null : id)}
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
                    />
                </Card>
                <div className="admin-page-note admin-page-note-footer">
                    <Typography.Text strong>礼包维护须知</Typography.Text>
                    <Typography.Text type="secondary">
                        删除礼包不可恢复，会清除全部领取记录，同 code 重建后可重新领取；生效中的礼包编辑/删除会置灰并提示需先停用。
                    </Typography.Text>
                </div>
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
