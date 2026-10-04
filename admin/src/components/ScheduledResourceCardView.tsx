import { useState } from "react"
import { Button, Pagination, Popconfirm, Spin, Typography } from "antd"
import dayjs from "dayjs"
import { Pencil, Trash2 } from "lucide-react"

import type { ScheduledResourceRule } from "./ScheduledResourceRules"

interface ScheduledResourceCardViewProps {
    rules: readonly ScheduledResourceRule[]
    loading: boolean
    onToggle: (rule: ScheduledResourceRule) => void
    onEdit: (rule: ScheduledResourceRule) => void
    onDelete: (ruleId: number) => void
}

// 定时资源补充卡片视图（2026-10-04 卡片化改造, 双视口统一, 结构照礼包/公告页
// acc-card 模式）：标题行 = 资源名 + 范围徽章 / 启用区间 + 状态钮(绿=生效中/
// 红=已停用, 显示当前状态) + 编辑 + 垃圾桶删除; meta 行 = 数量与限制 + 备注。
// 数据/变更全部经 props 下传——queryKey、API、确认文案与原表格/移动卡零差异。
export function ScheduledResourceCardView({
    rules,
    loading,
    onToggle,
    onEdit,
    onDelete,
}: ScheduledResourceCardViewProps) {
    // 规则量少, 沿用原 List 的本地分页(每页 10, 单页隐藏); 删除末页规则后钳回有效页
    const [page, setPage] = useState(1)
    const pageSize = 10
    const maxPage = Math.max(1, Math.ceil(rules.length / pageSize))
    const currentPage = Math.min(page, maxPage)
    const pageRules = rules.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    return (
        <Spin spinning={loading}>
            <div className="admin-acc-list">
                {rules.length === 0 && !loading && (
                    <span className="admin-card-empty">暂无定时补充规则</span>
                )}
                {pageRules.map(rule => (
                    <div key={rule.id} className="acc-card sched-card">
                        {/* 维护者 2026-10-04: 移动端范围徽章独占左上(标题上方), 桌面与名称同行;
                            三钮移动端独占最下一排, 桌面右侧一簇 —— grid 区块摆放 */}
                        <div className="sched-heading">
                            {/* 范围徽章在资源名前方, 间隔 8px(维护者 2026-10-05, 两端一致) */}
                            <div className="sched-headline">
                                {rule.scope === "global"
                                    ? <span className="admin-badge-info">全局规则</span>
                                    : <span className="admin-badge-muted">指定存档 #{rule.playerId}</span>}
                                <Typography.Text strong className="sched-title">{rule.rewardName}</Typography.Text>
                            </div>
                        </div>
                        <span className="acc-actions sched-actions">
                            <Button
                                className={rule.enabled ? "admin-state-active" : "admin-state-stopped"}
                                aria-label={rule.enabled ? "点击停用规则" : "点击启用规则"}
                                onClick={() => onToggle(rule)}
                            >
                                {rule.enabled ? "生效中" : "已停用"}
                            </Button>
                            <Button icon={<Pencil size={15} />} aria-label="编辑规则" onClick={() => onEdit(rule)}>
                                编辑
                            </Button>
                            <Popconfirm
                                title="删除这条定时补充规则？"
                                okText="删除"
                                cancelText="取消"
                                okButtonProps={{ danger: true }}
                                onConfirm={() => onDelete(rule.id)}
                            >
                                <Button danger icon={<Trash2 size={15} />} aria-label="删除规则" />
                            </Popconfirm>
                        </span>
                        {/* 维护者 2026-10-04: 启用区间并入信息行(桌面同排; 移动端随行换行) */}
                        <div className="sched-meta">
                            <span>
                                启用区间{" "}
                                {rule.startsAtReal ? dayjs(rule.startsAtReal).format("YYYY-MM-DD HH:mm") : "不限"}
                                {" 至 "}
                                {rule.endsAtReal ? dayjs(rule.endsAtReal).format("YYYY-MM-DD HH:mm") : "不限"}
                            </span>
                            <span>发放数量 <b className="admin-mono">{rule.grantAmount}</b></span>
                            <span>触发下限 <b className="admin-mono">{rule.triggerThreshold}</b></span>
                            <span>持有上限 <b className="admin-mono">{rule.inventoryCap} / {rule.officialMaxCount}</b></span>
                            {rule.description && <span>备注 {rule.description}</span>}
                        </div>
                    </div>
                ))}
                <Pagination
                    current={currentPage}
                    pageSize={pageSize}
                    total={rules.length}
                    hideOnSinglePage
                    onChange={setPage}
                />
            </div>
        </Spin>
    )
}
