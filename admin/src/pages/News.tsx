import { useState } from "react"
import {
    Alert,
    Button,
    Card,
    Popconfirm,
    Space,
    Switch,
    Table,
    Typography,
    message,
} from "antd"
import { ReloadOutlined } from "@ant-design/icons"
import { Pencil, Plus } from "lucide-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { ApiError, apiDelete, apiGet, apiPatch } from "../api/client"
import { AdminPage } from "../components/AdminPage"
import NewsEditor from "../features/news/NewsEditor"
import { NewsThumb } from "../features/news/newsPreview"
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
            actions={(
                <>
                    <Button
                        icon={<ReloadOutlined />}
                        loading={news.isFetching}
                        onClick={refresh}
                    >
                        刷新
                    </Button>
                    <Button type="primary" icon={<Plus size={16} />} onClick={openCreate}>
                        新建公告
                    </Button>
                </>
            )}
        >
            <Space direction="vertical" size="large" className="admin-stack">
                <div className="admin-page-note">
                    <Typography.Text strong>公告维护须知</Typography.Text>
                    <Typography.Text type="secondary">
                        删除公告为物理删除且无法恢复；公告内容使用客户端 RichText 标签，不支持属性和外部链接。
                    </Typography.Text>
                </div>
                {news.isError && (
                    <Alert
                        type="error"
                        showIcon
                        message="公告列表不可用"
                        action={<Button onClick={() => news.refetch()}>重试</Button>}
                    />
                )}
                <Card title="普通公告" className="admin-table-card">
                    <Table<AdminNewsRow>
                        rowKey="id"
                        className="admin-ops-table"
                        loading={news.isLoading}
                        dataSource={news.data?.rows ?? []}
                        scroll={{ x: "max-content" }}
                        locale={{ emptyText: "暂无公告" }}
                        pagination={{
                            current: page,
                            pageSize,
                            total: news.data?.totalCount ?? 0,
                            showSizeChanger: true,
                            onChange: (nextPage, nextPageSize) => {
                                setPage(nextPage)
                                setPageSize(nextPageSize)
                            },
                        }}
                        columns={[
                            {
                                title: "缩略图",
                                dataIndex: "thumbnail",
                                width: 90,
                                align: "center",
                                render: (_: unknown, row) => <NewsThumb thumbnail={row.thumbnail} />,
                            },
                            { title: "标题", dataIndex: "title", width: 260 },
                            {
                                title: "分类",
                                dataIndex: "category",
                                width: 100,
                                responsive: ["sm"] as any,
                                render: (category: AdminNewsRow["category"]) => (
                                    <span className={CATEGORY_BADGE_CLASS[category]}>{CATEGORY_LABELS[category]}</span>
                                ),
                            },
                            {
                                title: "发布时间",
                                dataIndex: "publishedAtReal",
                                width: 190,
                                responsive: ["sm"] as any,
                                render: value => new Date(value).toLocaleString("zh-CN"),
                            },
                            { title: "标签", dataIndex: "label", width: 80, align: "right", responsive: ["sm"] as any },
                            {
                                title: "状态",
                                width: 110,
                                render: (_, row) => (
                                    <Switch
                                        checked={row.enabled}
                                        checkedChildren="启用"
                                        unCheckedChildren="停用"
                                        loading={toggle.isPending && toggle.variables?.id === row.id}
                                        onChange={() => toggle.mutate(row)}
                                    />
                                ),
                            },
                            {
                                title: "操作",
                                fixed: "right",
                                width: 180,
                                render: (_, row) => (
                                    <div className="admin-action-row">
                                        <Button
                                            size="small"
                                            icon={<Pencil size={15} />}
                                            onClick={() => openEdit(row)}
                                        >
                                            编辑
                                        </Button>
                                        <Popconfirm
                                            title="删除这条公告？"
                                            description="此操作会物理删除公告，且无法恢复。"
                                            okText="删除"
                                            cancelText="取消"
                                            okButtonProps={{ danger: true }}
                                            onConfirm={() => remove.mutate(row)}
                                        >
                                            <Button size="small" type="text" danger>
                                                删除
                                            </Button>
                                        </Popconfirm>
                                    </div>
                                ),
                            },
                        ]}
                    />
                </Card>
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
