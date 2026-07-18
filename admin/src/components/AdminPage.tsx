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
                <div>
                    <span className="admin-page-eyebrow">{eyebrow}</span>
                    <Typography.Title level={1} className="admin-page-title">
                        {title}
                    </Typography.Title>
                    {description && <div className="admin-page-description">{description}</div>}
                </div>
                {actions && <div className="admin-page-actions">{actions}</div>}
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
