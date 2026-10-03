import type { ReactNode } from "react"
import { Button, Typography } from "antd"
import { ReloadOutlined } from "@ant-design/icons"

interface AdminPageProps {
    eyebrow: string
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
    /** 紧跟标题的刷新 icon 按钮; 传入即显示（维护者指定: 刷新从右上角移到标题后） */
    onRefresh?: () => void
    refreshing?: boolean
    children: ReactNode
}

export function AdminPage({ eyebrow, title, description, actions, onRefresh, refreshing, children }: AdminPageProps) {
    return (
        <section className="admin-page">
            <header className="admin-page-header">
                <div className="admin-page-heading">
                    <span className="admin-page-eyebrow">{eyebrow}</span>
                    <div className="admin-page-title-row">
                        <Typography.Title level={1} className="admin-page-title">
                            {title}
                        </Typography.Title>
                        {onRefresh && (
                            <Button
                                type="text"
                                className="admin-page-refresh"
                                title="刷新"
                                aria-label="刷新"
                                icon={<ReloadOutlined />}
                                loading={refreshing}
                                onClick={onRefresh}
                            />
                        )}
                        {actions && <div className="admin-page-actions">{actions}</div>}
                    </div>
                </div>
                {description && <div className="admin-page-description">{description}</div>}
            </header>
            {children}
        </section>
    )
}

interface StateCardProps {
    children: ReactNode
}

export function StateCard({ children }: StateCardProps) {
    return <div style={{ minHeight: 240, display: "grid", placeItems: "center" }}>{children}</div>
}
