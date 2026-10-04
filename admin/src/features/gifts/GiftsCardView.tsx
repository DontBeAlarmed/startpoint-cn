import { Button, Pagination, Popconfirm, Spin, message } from "antd"
import { Pencil, Trash2 } from "lucide-react"

import GiftRedemptions from "./GiftRedemptions"
import { giftRewardChipTexts, type GiftRewardLookups } from "./rewardDisplay"
import type { AdminGiftRow } from "./types"

interface GiftsCardViewProps {
    rows: readonly AdminGiftRow[]
    loading: boolean
    page: number
    pageSize: number
    totalCount: number
    rewardLookups: GiftRewardLookups
    expandedGiftId: number | null
    onToggleExpand: (giftId: number) => void
    onPageChange: (page: number, pageSize: number) => void
    onStart: (row: AdminGiftRow) => Promise<unknown>
    onStop: (row: AdminGiftRow) => Promise<unknown>
    onEdit: (row: AdminGiftRow) => void
    onDelete: (row: AdminGiftRow) => Promise<unknown>
}

// 礼包卡片视图（双视口同构, 结构照账号页 acc-card 模式）：
// 标题行 = code chip + 更新时间 + 状态钮(绿=生效中/红=已停用, 显示当前状态;
// active 无编辑入口, 先停再改 — 编辑/删除常驻但置灰锁定);
// 中部 = 奖励 chips 全量平铺单行(超出左右滚动, 视觉语义交给 shared-patterns 集中说明);
// info 行 = meta(奖励版本/版本) + 记录折叠 + 编辑/删除。空白点按切换记录展开
// (target 判定防点击穿透, 同账号卡)。数据/变更全部经 props 下传——queryKey、API 零差异。
export function GiftsCardView({
    rows,
    loading,
    page,
    pageSize,
    totalCount,
    rewardLookups,
    expandedGiftId,
    onToggleExpand,
    onPageChange,
    onStart,
    onStop,
    onEdit,
    onDelete,
}: GiftsCardViewProps) {
    return (
        <Spin spinning={loading}>
            <div className="admin-acc-list">
                    {rows.length === 0 && !loading && (
                        <span className="admin-card-empty">暂无礼包</span>
                    )}
                {rows.map(row => {
                    const chips = giftRewardChipTexts(row.rewards, rewardLookups)
                    const active = row.status === "active"
                    const expanded = expandedGiftId === row.id
                    return (
                        <div
                            key={row.id}
                            className="acc-card gift-card"
                            onClick={event => {
                                // 仅点卡片本体(空白)切换领取记录展开
                                if (event.target !== event.currentTarget) return
                                onToggleExpand(row.id)
                            }}
                        >
                            <div className="acc-titlebar">
                                {/* 维护者 2026-10-04: 标题两行 — 第一行 code, 第二行时间; 右侧启停 */}
                                <div className="gift-card-heading">
                                    <span className="acc-id-chip admin-mono gift-card-code">{row.code}</span>
                                    <span className="gift-card-time">更新时间 {new Date(row.updatedAt).toLocaleString("zh-CN")}</span>
                                </div>
                            <span className="acc-actions">
                                {/* 启停按钮恒在原位重标记 (与定时资源卡 停用/启用 同模式, 维护者 2026-09-30:
                                   点击后按钮消失的 UX 不统一); active 无编辑入口的现状语义保留(先停止再修改) */}
                                {/* 状态钮显示当前状态; 点击切换(视觉语义见 shared-patterns) */}
                                <Button
                                    className={active ? "admin-state-active" : "admin-state-stopped"}
                                    aria-label={active ? "点击停止礼包" : "点击启动礼包"}
                                    onClick={() => (active ? void onStop(row) : void onStart(row))}
                                >
                                    {active ? "生效中" : "已停用"}
                                </Button>
                            </span>
                        </div>
                        {chips.length > 0 && (
                            <div className="gift-reward-chips gift-card-chips">
                                {/* 全量平铺单行, 超出左右滚动(无滚动条, 触屏滑动/触控板横滚;
                                    维护者 2026-10-04: 双端都不再用 +N 折叠 —— 触屏无 tooltip
                                    打不开, 桌面同样改滚动) */}
                                {chips.map((text, index) => (
                                    <span key={index} className="gift-reward-chip">{text}</span>
                                ))}
                            </div>
                        )}
                        {/* meta + 记录/编辑/删除: 移动端上下两行, 桌面端并排一行(维护者指定:
                            桌面操作不单独占一行, 上移与 meta 同行) */}
                        <div className="gift-card-infoline">
                            <div className="gift-card-meta">
                                <span>奖励版本 <b className="admin-mono">{row.rewardRevision}</b></span>
                                <span>版本 <b className="admin-mono">{row.revision}</b></span>
                            </div>
                            <div className="acc-bottom-row gift-card-actions">
                                <Button
                                    className="acc-count-toggle"
                                    aria-expanded={expanded}
                                    onClick={() => onToggleExpand(row.id)}
                                >
                                    领取记录 {row.redemptionCount} {expanded ? "▴" : "▾"}
                                </Button>
                                {/* 编辑/删除常驻(布局不变); 生效中置灰锁定, 点击提示需先停用
                                    (维护者 2026-10-04: 不再隐藏按钮) */}
                                <Button
                                    className={active ? "gift-card-btn-locked" : undefined}
                                    aria-disabled={active}
                                    icon={<Pencil size={15} />}
                                    aria-label="编辑礼包"
                                    onClick={() => (active ? message.info("需停用后编辑礼包") : onEdit(row))}
                                />
                                <Popconfirm
                                    title="删除这个礼包？"
                                    description="此操作不可恢复，将清除全部领取记录，同 code 重建后可重新领取。"
                                    okText="删除"
                                    cancelText="取消"
                                    okButtonProps={{ danger: true }}
                                    disabled={active}
                                    onConfirm={() => void onDelete(row)}
                                >
                                    {/* 删除按钮全站统一 icon-only(维护者 2026-10-04) */}
                                    <Button
                                        danger
                                        className={active ? "gift-card-btn-locked" : undefined}
                                        aria-disabled={active}
                                        icon={<Trash2 size={15} />}
                                        aria-label="删除礼包"
                                        onClick={() => { if (active) message.info("需停用后删除礼包") }}
                                    />
                                </Popconfirm>
                            </div>
                        </div>
                        {expanded && (
                            <div className="gift-card-records">
                                <GiftRedemptions gift={row} />
                            </div>
                        )}
                    </div>
                )
            })}
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
