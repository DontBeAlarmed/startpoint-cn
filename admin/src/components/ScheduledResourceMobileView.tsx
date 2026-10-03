import { Button, List, Popconfirm, Typography } from "antd"
import dayjs from "dayjs"
import { CircleStop, Pencil, Play, Trash2 } from "lucide-react"

import type { ScheduledResourceRule } from "./ScheduledResourceRules"

interface ScheduledResourceMobileViewProps {
    rules: readonly ScheduledResourceRule[]
    loading: boolean
    toggling: boolean
    onToggle: (rule: ScheduledResourceRule) => void
    onEdit: (rule: ScheduledResourceRule) => void
    onDelete: (ruleId: number) => void
}

// 定时资源补充移动卡片视图（<768px，Grid.useBreakpoint 断点切换，ADD-3）：骨架照搬
// 账号页已验证的 AccountsMobileView 模式（.admin-mobile-* 共享类），每条规则一张卡：
// 首行 资源名 + 范围徽章（全局规则=info）；中间行 secondary 小字（发放数量/触发下限/
// 持有上限/启用区间/备注有则显）；尾部行 启停 Switch（逻辑与桌面一致）+ 编辑/删除。
// 数据/变更全部经 props 下传——queryKey、API、删除确认文案与桌面零差异；三个锚点类
// （scheduled-resource-modal/number-grid/date-grid）与桌面表格一字不动。
export function ScheduledResourceMobileView({
    rules,
    loading,
    toggling,
    onToggle,
    onEdit,
    onDelete,
}: ScheduledResourceMobileViewProps) {
    return (
        <List
            loading={loading}
            dataSource={[...rules]}
            locale={{ emptyText: "暂无定时补充规则" }}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            renderItem={rule => (
                <List.Item className="admin-mobile-list-item">
                    <div className="admin-mobile-list-content">
                        <div className="admin-mobile-list-heading">
                            <span className="admin-mobile-heading-main">
                                <Typography.Text strong>{rule.rewardName}</Typography.Text>
                                {rule.scope === "global"
                                    ? <span className="admin-badge-info">全局规则</span>
                                    : <span className="admin-badge-muted">指定存档 #{rule.playerId}</span>}
                                {rule.enabled
                                    ? <span className="admin-badge-ok">启用</span>
                                    : <span className="admin-badge-muted">停用</span>}
                            </span>
                        </div>
                        <div className="admin-mobile-detail-list scheduled-resource-mobile-detail">
                            <div><span>发放数量</span><strong>{rule.grantAmount}</strong></div>
                            <div><span>触发下限</span><strong>{rule.triggerThreshold}</strong></div>
                            <div><span>持有上限</span><strong>{rule.inventoryCap} / {rule.officialMaxCount}</strong></div>
                            <div>
                                <span>启用区间</span>
                                <strong>
                                    {rule.startsAtReal ? dayjs(rule.startsAtReal).format("YYYY-MM-DD HH:mm") : "不限"}
                                    {" 至 "}
                                    {rule.endsAtReal ? dayjs(rule.endsAtReal).format("YYYY-MM-DD HH:mm") : "不限"}
                                </strong>
                            </div>
                            {rule.description && <div><span>备注</span><strong>{rule.description}</strong></div>}
                        </div>
                        <div className="scheduled-resource-mobile-foot">
                            <div className="admin-mobile-actions">
                                <Button
                                    icon={rule.enabled ? <CircleStop size={15} /> : <Play size={15} />}
                                    loading={toggling}
                                    onClick={() => onToggle(rule)}
                                >
                                    {rule.enabled ? "停用" : "启用"}
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
                            </div>
                        </div>
                    </div>
                </List.Item>
            )}
        />
    )
}
