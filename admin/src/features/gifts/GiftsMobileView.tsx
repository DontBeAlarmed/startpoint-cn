import { Button, List, Popconfirm, Typography } from "antd"
import { CircleStop, Eye, Pencil, Play, Trash2 } from "lucide-react"

import { giftRewardChipTexts, type GiftRewardLookups } from "./rewardDisplay"
import type { AdminGiftRow } from "./types"

interface GiftsMobileViewProps {
    rows: readonly AdminGiftRow[]
    loading: boolean
    page: number
    pageSize: number
    totalCount: number
    rewardLookups: GiftRewardLookups
    onPageChange: (page: number, pageSize: number) => void
    onStart: (row: AdminGiftRow) => Promise<unknown>
    onStop: (row: AdminGiftRow) => Promise<unknown>
    onEdit: (row: AdminGiftRow) => void
    onDelete: (row: AdminGiftRow) => Promise<unknown>
    onOpenRedemptions: (row: AdminGiftRow) => void
}

// 礼包移动卡片视图（<768px，Grid.useBreakpoint 断点切换）：骨架照搬账号页已验证的
// AccountsMobileView 模式（.admin-mobile-* 共享类 + icon+文字操作行），奖励 chips 复用
// rewardDisplay（≤2 全显 + +N）。操作行按状态分流：active 无编辑入口的现状语义保留
// （先停止再修改，见页面维护须知）；删除确认文案与桌面逐字一致。数据/变更全部经 props
// 下传——queryKey、API 零改动，桌面表格一字不动；领取记录面板两种视口共用页面级渲染。
export function GiftsMobileView({
    rows,
    loading,
    page,
    pageSize,
    totalCount,
    rewardLookups,
    onPageChange,
    onStart,
    onStop,
    onEdit,
    onDelete,
    onOpenRedemptions,
}: GiftsMobileViewProps) {
    return (
        <List
            loading={loading}
            dataSource={[...rows]}
            locale={{ emptyText: "暂无礼包" }}
            pagination={{
                current: page,
                pageSize,
                total: totalCount,
                showSizeChanger: true,
                onChange: onPageChange,
            }}
            renderItem={row => {
                const chips = giftRewardChipTexts(row.rewards, rewardLookups)
                const active = row.status === "active"
                return (
                    <List.Item className="admin-mobile-list-item">
                        <div className="admin-mobile-list-content">
                            <div className="admin-mobile-list-heading">
                                <span className="admin-mobile-heading-main">
                                    <Typography.Text strong className="gift-mobile-code">
                                        {row.code}
                                    </Typography.Text>
                                </span>
                                <span className={active ? "admin-badge-ok" : "admin-badge-muted"}>
                                    {active ? "启用" : "停止"}
                                </span>
                            </div>
                            {chips.length > 0 && (
                                <span className="gift-reward-chips gift-mobile-chips">
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
                            )}
                            <Typography.Text type="secondary" className="gift-mobile-meta">
                                已领取 {row.redemptionCount} · 更新时间 {new Date(row.updatedAt).toLocaleString("zh-CN")}
                            </Typography.Text>
                            <div className="admin-mobile-actions">
                                {/* 启停按钮恒在原位重标记 (与定时资源卡 停用/启用 同模式, 维护者 2026-09-30:
                                   点击后按钮消失的 UX 不统一); 编辑仅 stopped 提供, 恒排末位不挤动其他按钮 */}
                                <Button
                                    icon={active ? <CircleStop size={15} /> : <Play size={15} />}
                                    aria-label={active ? "停止礼包" : "启动礼包"}
                                    onClick={() => (active ? onStop(row) : onStart(row))}
                                >
                                    {active ? "停止" : "启动"}
                                </Button>
                                <Button icon={<Eye size={15} />} aria-label="领取记录" onClick={() => onOpenRedemptions(row)}>
                                    记录
                                </Button>
                                <Popconfirm
                                    title="删除这个礼包？"
                                    description="此操作不可恢复，将清除全部领取记录，同 code 重建后可重新领取。"
                                    okText="删除"
                                    cancelText="取消"
                                    okButtonProps={{ danger: true }}
                                    onConfirm={() => onDelete(row)}
                                >
                                    <Button danger icon={<Trash2 size={15} />} aria-label="删除礼包">
                                        删除
                                    </Button>
                                </Popconfirm>
                                {!active && (
                                    <Button icon={<Pencil size={15} />} aria-label="编辑礼包" onClick={() => onEdit(row)}>
                                        编辑
                                    </Button>
                                )}
                                <Popconfirm
                                    title="删除这个礼包？"
                                    description="此操作不可恢复，将清除全部领取记录，同 code 重建后可重新领取。"
                                    okText="删除"
                                    cancelText="取消"
                                    okButtonProps={{ danger: true }}
                                    onConfirm={() => onDelete(row)}
                                >
                                    <Button danger icon={<Trash2 size={15} />} aria-label="删除礼包">
                                        删除
                                    </Button>
                                </Popconfirm>
                            </div>
                        </div>
                    </List.Item>
                )
            }}
        />
    )
}
