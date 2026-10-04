import { Button, Pagination, Popconfirm, Spin } from "antd"
import { Pencil, Trash2 } from "lucide-react"

import { NewsThumb } from "./newsPreview"
import type { AdminNewsRow } from "./types"

interface NewsCardViewProps {
    rows: readonly AdminNewsRow[]
    loading: boolean
    page: number
    pageSize: number
    totalCount: number
    // 分类文案与语义色徽章映射仍是页面级事实源, 经 props 下传避免双份漂移
    categoryLabels: Record<AdminNewsRow["category"], string>
    categoryBadgeClass: Record<AdminNewsRow["category"], string>
    onPageChange: (page: number, pageSize: number) => void
    onEdit: (row: AdminNewsRow) => void
    onDelete: (row: AdminNewsRow) => Promise<unknown>
    onToggle: (row: AdminNewsRow) => Promise<unknown>
}

// 公告卡片视图（2026-10-04 卡片化改造, 双视口统一, 结构照礼包/账号页 acc-card 模式）：
// 标题行 = 两行标题块(第一行分类徽章+标题, 第二行发布时间[+标签]) + 启停按钮; 配图为右半渐隐背景层
// (恒位重标记, 启用标识收敛到按钮文字 — 维护者指定, 不再有徽章/Switch 两套表达)。
// 底行 = 编辑 + 垃圾桶删除。数据/变更全部经 props 下传——queryKey、API、确认文案与
// 原表格/移动卡零差异。
export function NewsCardView({
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
}: NewsCardViewProps) {
    return (
        <Spin spinning={loading}>
            <div className="admin-acc-list">
                {rows.length === 0 && !loading && (
                    <span className="admin-card-empty">暂无公告</span>
                )}
                {rows.map(row => (
                    <div key={row.id} className="acc-card news-card">
                        {/* 配图作卡片背景: 只占右半边, 左缘渐隐融入卡底(维护者指定);
                            NewsThumb 自带加载失败回退渐变块, 背景层同样适用 */}
                        <div className="news-card-bg" aria-hidden="true">
                            <NewsThumb thumbnail={row.thumbnail} className="news-card-bg-img" />
                        </div>
                        <div className="acc-titlebar">
                            <div className="news-card-heading">
                                <div className="news-card-headline">
                                    <span className={categoryBadgeClass[row.category]}>
                                        {categoryLabels[row.category]}
                                    </span>
                                    <span className="news-card-title">{row.title}</span>
                                </div>
                                <span className="news-card-time">
                                    发布时间 {new Date(row.publishedAtReal).toLocaleString("zh-CN")}
                                    {row.label > 0 && <span> · 标签 {row.label}</span>}
                                </span>
                            </div>
                            <span className="acc-actions news-card-actions">
                                {/* 启停按钮恒在原位重标记(维护者 2026-10-04: 启动标识收敛,
                                   徽章/Switch 两套表达移除), 直呼 toggle 与原桌面 Switch 同通道。
                                   三钮位置: 桌面右侧一簇 / 移动端最下一排(CSS 分流, 维护者指定) */}
                                {/* 状态钮显示当前状态(绿=生效中/红=已停用, 维护者 2026-10-04),
                                    点击切换; 无图标 */}
                                <Button
                                    className={row.enabled ? "admin-state-active" : "admin-state-stopped"}
                                    aria-label={row.enabled ? "点击停用公告" : "点击启用公告"}
                                    onClick={() => void onToggle(row)}
                                >
                                    {row.enabled ? "生效中" : "已停用"}
                                </Button>
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
                            </span>
                        </div>
                    </div>
                ))}
                <Pagination
                    current={page}
                    pageSize={pageSize}
                    total={totalCount}
                    showSizeChanger
                    onChange={onPageChange}
                />
            </div>
        </Spin>
    )
}
