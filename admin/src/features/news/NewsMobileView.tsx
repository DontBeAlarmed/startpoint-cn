import { Button, List, Popconfirm, Typography } from "antd"
import { Pencil, Trash2 } from "lucide-react"

import { NewsThumb } from "./newsPreview"
import type { AdminNewsRow } from "./types"

interface NewsMobileViewProps {
    rows: readonly AdminNewsRow[]
    loading: boolean
    page: number
    pageSize: number
    totalCount: number
    // 分类文案与语义色徽章映射仍是页面级事实源（桌面表格同用），经 props 下传避免双份漂移
    categoryLabels: Record<AdminNewsRow["category"], string>
    categoryBadgeClass: Record<AdminNewsRow["category"], string>
    onPageChange: (page: number, pageSize: number) => void
    onEdit: (row: AdminNewsRow) => void
    onDelete: (row: AdminNewsRow) => Promise<unknown>
}

// 公告移动卡片视图（<768px，Grid.useBreakpoint 断点切换）：卡片结构照搬账号页已验证的
// AccountsMobileView 模式（.admin-mobile-* 共享类 + icon+文字操作行）；启用/停用在此只是
// 状态徽章（切换仍走桌面表格 Switch 与编辑器）。数据/变更全部经 props 下传——queryKey、
// API、删除确认文案与桌面零差异，桌面表格一字不动。
export function NewsMobileView({
    rows,
    loading,
    page,
    pageSize,
    totalCount,
    categoryLabels,
    categoryBadgeClass,
    onPageChange,
    onEdit,
    onDelete,
}: NewsMobileViewProps) {
    return (
        <List
            loading={loading}
            dataSource={[...rows]}
            locale={{ emptyText: "暂无公告" }}
            pagination={{
                current: page,
                pageSize,
                total: totalCount,
                showSizeChanger: true,
                onChange: onPageChange,
            }}
            renderItem={row => (
                <List.Item className="admin-mobile-list-item">
                    <div className="admin-mobile-list-content">
                        <div className="admin-mobile-list-heading">
                            <span className="admin-mobile-heading-main">
                                <span className={categoryBadgeClass[row.category]}>
                                    {categoryLabels[row.category]}
                                </span>
                                <Typography.Text strong className="news-mobile-title">
                                    {row.title}
                                </Typography.Text>
                            </span>
                            <span className={row.enabled ? "admin-badge-ok" : "admin-badge-muted"}>
                                {row.enabled ? "启用" : "停用"}
                            </span>
                        </div>
                        <div className="news-mobile-meta">
                            <NewsThumb thumbnail={row.thumbnail} />
                            <Typography.Text type="secondary">
                                {new Date(row.publishedAtReal).toLocaleString("zh-CN")}
                            </Typography.Text>
                        </div>
                        <div className="admin-mobile-actions">
                            <Button icon={<Pencil size={15} />} aria-label="编辑公告" onClick={() => onEdit(row)}>
                                编辑
                            </Button>
                            <Popconfirm
                                title="删除这条公告？"
                                description="此操作会物理删除公告，且无法恢复。"
                                okText="删除"
                                cancelText="取消"
                                okButtonProps={{ danger: true }}
                                onConfirm={() => onDelete(row)}
                            >
                                <Button danger icon={<Trash2 size={15} />} aria-label="删除公告">
                                    删除
                                </Button>
                            </Popconfirm>
                        </div>
                    </div>
                </List.Item>
            )}
        />
    )
}
