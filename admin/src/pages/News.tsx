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

import { ApiError, apiDelete, apiGet, apiPatch } from "../api/client"
import { AdminPage } from "../components/AdminPage"
import NewsEditor from "../features/news/NewsEditor"
import { NewsCardView } from "../features/news/NewsCardView"
import type { AdminNewsRow, NewsPage } from "../features/news/types"

const CATEGORY_LABELS: Record<AdminNewsRow["category"], string> = {
    1: "主题",
    2: "活动",
    3: "问题",
}

// 分类语义色（审查稿 #p-news：主题=水蓝 / 活动=风绿 / 问题=雷黄）。
const CATEGORY_BADGE_CLASS: Record<AdminNewsRow["category"], string> = {
    1: "admin-badge-info",
    2: "admin-badge-ok",
    3: "admin-badge-warn",
}

function invalidateNews(queryClient: ReturnType<typeof useQueryClient>, id?: number) {
    queryClient.invalidateQueries({ queryKey: ["adminNews"] })
    if (id !== undefined) {
        queryClient.invalidateQueries({ queryKey: ["adminNewsDetail", id] })
    }
}

export default function News() {
    const queryClient = useQueryClient()
    const [page, setPage] = useState(1)
    const [pageSize, setPageSize] = useState(20)
    const [editorNews, setEditorNews] = useState<AdminNewsRow | null>(null)
    const [editorOpen, setEditorOpen] = useState(false)

    const news = useQuery({
        queryKey: ["adminNews", page, pageSize],
        queryFn: () => apiGet<NewsPage>(`/api/news?page=${page}&pageSize=${pageSize}`),
    })

    const toggle = useMutation({
        mutationFn: (row: AdminNewsRow) => apiPatch<AdminNewsRow>(
            `/api/news/${row.id}/enabled`,
            { enabled: !row.enabled, revision: row.revision },
        ),
        onSuccess: row => {
            message.success(row.enabled ? "公告已启用" : "公告已停用")
            invalidateNews(queryClient, row.id)
        },
        onError: (error: Error) => {
            message.error(error instanceof ApiError && error.status === 409
                ? "公告已被其他操作修改，请刷新"
                : error.message)
            invalidateNews(queryClient)
        },
    })

    const remove = useMutation({
        mutationFn: (row: AdminNewsRow) => apiDelete<{ ok: boolean }>(
            `/api/news/${row.id}?revision=${row.revision}`,
        ),
        onSuccess: (_result, row) => {
            message.success("公告已删除")
            invalidateNews(queryClient, row.id)
        },
        onError: (error: Error) => {
            message.error(error instanceof ApiError && error.status === 409
                ? "公告已被其他操作修改，请刷新"
                : error.message)
        },
    })

    const openCreate = () => {
        setEditorNews(null)
        setEditorOpen(true)
    }

    const openEdit = (row: AdminNewsRow) => {
        setEditorNews(row)
        setEditorOpen(true)
    }

    const refresh = () => {
        queryClient.invalidateQueries({ queryKey: ["adminNews"] })
    }

    return (
        <AdminPage
            eyebrow="NEWS"
            title="公告"
            description="维护客户端的主题公告、活动通知和问题公告；系统类别暂缓。"
            onRefresh={refresh}
            refreshing={news.isFetching}
        >
            <Space direction="vertical" size="large" className="admin-stack">
                {news.isError && (
                    <Alert
                        type="error"
                        showIcon
                        message="公告列表不可用"
                        action={<Button onClick={() => news.refetch()}>重试</Button>}
                    />
                )}
                {/* 2026-10-04 卡片化改造: 双视口统一卡片(同礼包/账号页 acc-card 结构),
                    启用标识收敛到启停按钮; 原桌面表格/移动 List 撤销 */}
                <Card
                    title="普通公告"
                    className="admin-mobile-list-card"
                    extra={(
                        <Button type="primary" size="small" icon={<Plus size={14} />} onClick={openCreate}>
                            新建公告
                        </Button>
                    )}
                >
                    <NewsCardView
                        rows={news.data?.rows ?? []}
                        loading={news.isLoading}
                        page={page}
                        pageSize={pageSize}
                        totalCount={news.data?.totalCount ?? 0}
                        categoryLabels={CATEGORY_LABELS}
                        categoryBadgeClass={CATEGORY_BADGE_CLASS}
                        onPageChange={(nextPage, nextPageSize) => {
                            setPage(nextPage)
                            setPageSize(nextPageSize)
                        }}
                        onEdit={openEdit}
                        onDelete={row => remove.mutateAsync(row)}
                        onToggle={row => toggle.mutateAsync(row)}
                    />
                </Card>
                <div className="admin-page-note admin-page-note-footer">
                    <Typography.Text strong>公告维护须知</Typography.Text>
                    <Typography.Text type="secondary">
                        删除公告为物理删除且无法恢复；公告内容使用客户端 RichText 标签，不支持属性和外部链接。
                    </Typography.Text>
                </div>
            </Space>
            <NewsEditor
                news={editorNews}
                open={editorOpen}
                onClose={() => setEditorOpen(false)}
                onSaved={row => invalidateNews(queryClient, row.id)}
            />
        </AdminPage>
    )
}
