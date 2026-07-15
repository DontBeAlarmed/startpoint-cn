import { useState } from "react"
import { BulbFilled, BulbOutlined, LockOutlined } from "@ant-design/icons"
import { Alert, Button, Card, Input, Space, Typography } from "antd"


interface LoginProps {
    dark: boolean
    onToggleDark: () => void
    onLogin: (token: string) => Promise<void>
}


export default function Login({ dark, onToggleDark, onLogin }: LoginProps) {
    const [token, setToken] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const submit = async () => {
        if (!token || submitting) return
        setSubmitting(true)
        setError(null)
        try {
            await onLogin(token)
            setToken("")
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "登录失败")
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
            <Card style={{ width: "min(420px, 100%)" }}>
                <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                        <div style={{ flex: 1 }}>
                            <Typography.Title level={3} style={{ margin: 0 }}>Starpoint 管理后台</Typography.Title>
                            <Typography.Text type="secondary">输入本机配置的管理令牌</Typography.Text>
                        </div>
                        <Button
                            type="text"
                            icon={dark ? <BulbFilled style={{ color: "#faad14" }} /> : <BulbOutlined />}
                            onClick={onToggleDark}
                            aria-label="切换明暗模式"
                        />
                    </div>
                    {error && <Alert type="error" showIcon message={error} />}
                    <Input.Password
                        autoFocus
                        autoComplete="off"
                        name="admin-token"
                        prefix={<LockOutlined />}
                        placeholder="CN_ADMIN_TOKEN"
                        value={token}
                        onChange={event => setToken(event.target.value)}
                        onPressEnter={submit}
                        disabled={submitting}
                    />
                    <Button
                        type="primary"
                        block
                        loading={submitting}
                        disabled={!token}
                        onClick={submit}
                    >
                        登录
                    </Button>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        令牌只用于建立 HttpOnly 会话，不会写入浏览器存储。
                    </Typography.Text>
                </Space>
            </Card>
        </main>
    )
}
