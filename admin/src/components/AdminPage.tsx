import type { ReactNode } from "react"
import { Typography } from "antd"

interface AdminPageProps {
    eyebrow: string
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
    children: ReactNode
}

export function AdminPage({ eyebrow, title, description, actions, children }: AdminPageProps) {
    return (
        <section className="admin-page">
            <header className="admin-page-header">
                <div className="admin-page-header-top">
                    <div className="admin-page-heading">
                        <span className="admin-page-eyebrow">{eyebrow}</span>
                        <div className="admin-page-title-row">
                            <Typography.Title level={1} className="admin-page-title">
                                {title}
                            </Typography.Title>
                            {actions && <div className="admin-page-actions">{actions}</div>}
                        </div>
                    </div>
                    {description && <div className="admin-page-description">{description}</div>}
                </div>
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
