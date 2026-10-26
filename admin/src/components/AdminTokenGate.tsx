import { useEffect, useState } from "react"
import { Button, Input, Popover, Space, Typography } from "antd"
import { KeyRound } from "lucide-react"
import { getStoredAdminToken } from "../api/client"

// 轻量 token 入口：401 广播（admin-api-unauthorized）自动弹开；
// 保存到 localStorage 后整页刷新重试。未启用 token 的部署永远收不到 401，按钮仅作手动入口。
export function AdminTokenGate() {
    const [open, setOpen] = useState(false)
    const [value, setValue] = useState("")
    useEffect(() => {
        const onUnauthorized = () => setOpen(true)
        window.addEventListener("admin-api-unauthorized", onUnauthorized)
        return () => window.removeEventListener("admin-api-unauthorized", onUnauthorized)
    }, [])
    const save = () => {
        const token = value.trim()
        if (token) localStorage.setItem("adminApiToken", token)
        setOpen(false)
        window.location.reload()
    }
    const hasToken = getStoredAdminToken() !== ""
    return (
        <Popover
            open={open}
            trigger="click"
            onOpenChange={setOpen}
            content={(
                <Space direction="vertical" style={{ width: 260 }}>
                    <Typography.Text type="secondary">
                        服务端已启用 ADMIN_API_TOKEN；输入后保存在本浏览器。
                    </Typography.Text>
                    <Input.Password
                        value={value}
                        onChange={e => setValue(e.target.value)}
                        onPressEnter={save}
                        placeholder="Bearer token"
                    />
                    <Button type="primary" size="small" onClick={save}>保存并刷新</Button>
                </Space>
            )}
        >
            <Button type="text" size="small" icon={<KeyRound size={16} />} aria-label="Admin API Token">
                {hasToken ? "Token 已设" : "Token"}
            </Button>
        </Popover>
    )
}
