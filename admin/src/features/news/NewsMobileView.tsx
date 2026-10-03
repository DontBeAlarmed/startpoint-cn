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
    // 状态徽章即可点击启停（维护者指定）：恒位重标记按钮制，Popconfirm 确认后走
    // 与桌面 Switch 同一条 /api/news/:id/enabled 通道
    onToggle: (row: AdminNewsRow) => Promise<unknown>
    togglingId: number | null
}

// 公告移动卡片视图（<768px，Grid.useBreakpoint 断点切换）。四行结构（维护者指定）：
// 分类|状态(居右可点) / 标题 / 缩略图|时间 / 编辑,删除。
// 数据/变更全部经 props 下传——queryKey、API、确认文案与桌面零差异。
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
    onToggle,
    togglingId,
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
                        <div className="admin-mobile-list-heading news-mobile-topline">
                            <span className={categoryBadgeClass[row.category]}>
                                {categoryLabels[row.category]}
                            </span>
                            <Popconfirm
                                title={row.enabled ? "停用这条公告？" : "启用这条公告？"}
                                okText={row.enabled ? "停用" : "启用"}
                                cancelText="取消"
                                okButtonProps={{ danger: row.enabled }}
                                onConfirm={() => void onToggle(row)}
                            >
                                <button
                                    type="button"
                                    className={`news-status-toggle ${row.enabled ? "admin-badge-ok" : "admin-badge-muted"}`}
                                    disabled={togglingId === row.id}
                                    aria-label={row.enabled ? "停用公告" : "启用公告"}
                                >
                                    {row.enabled ? "启用" : "停用"}
                                </button>
                            </Popconfirm>
                        </div>
                        <Typography.Text strong className="news-mobile-title">
                            {row.title}
                        </Typography.Text>
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
                                onConfirm={() => void onDelete(row)}
                            >
                                <Button danger icon={<Trash2 size={15} />} aria-label="删除公告" />
                            </Popconfirm>
                        </div>
                    </div>
                </List.Item>
            )}
        />
    )
}
