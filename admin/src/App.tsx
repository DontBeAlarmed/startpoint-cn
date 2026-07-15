import { useCallback, useEffect, useState } from "react"
import { Layout, Menu, Grid, Button, Drawer, Space, Result, Spin } from "antd"
import { useQueryClient } from "@tanstack/react-query"
import {
    DashboardOutlined,
    TeamOutlined,
    MailOutlined,
    ExperimentOutlined,
    MenuOutlined,
    BulbOutlined,
    BulbFilled,
} from "@ant-design/icons"
import { Routes, Route, useNavigate, useLocation, Navigate } from "react-router-dom"
import Dashboard from "./pages/Dashboard"
import Accounts from "./pages/Accounts"
import PlayerDetail from "./pages/PlayerDetail"
import Mail from "./pages/Mail"
import Seeds from "./pages/Seeds"
import Login from "./pages/Login"
import { ApiError, apiLogin, apiLogout, apiSession, subscribeUnauthorized } from "./api/client"

const { Sider, Content, Header } = Layout
const { useBreakpoint } = Grid

const menuItems = [
    { key: "/", icon: <DashboardOutlined />, label: "首页" },
    { key: "/accounts", icon: <TeamOutlined />, label: "账号 / 存档" },
    { key: "/mail", icon: <MailOutlined />, label: "邮件群发" },
    { key: "/seeds", icon: <ExperimentOutlined />, label: "种子管理" }
]

interface AppProps {
    dark: boolean
    onToggleDark: () => void
}

export default function App({ dark, onToggleDark }: AppProps) {
    const navigate = useNavigate()
    const location = useLocation()
    const queryClient = useQueryClient()
    const screens = useBreakpoint()
    const isMobile = !screens.md
    const [drawerOpen, setDrawerOpen] = useState(false)
    const [authenticated, setAuthenticated] = useState<boolean | null>(null)
    const [sessionError, setSessionError] = useState<string | null>(null)

    const refreshSession = useCallback(async () => {
        setSessionError(null)
        try {
            const session = await apiSession()
            setAuthenticated(session.authenticated)
        } catch (caught) {
            setAuthenticated(null)
            setSessionError(caught instanceof Error ? caught.message : "无法连接管理服务")
        }
    }, [])

    useEffect(() => { void refreshSession() }, [refreshSession])
    useEffect(() => subscribeUnauthorized(() => {
        queryClient.clear()
        setAuthenticated(false)
    }), [queryClient])

    const login = async (token: string) => {
        try {
            await apiLogin(token)
        } catch (caught) {
            if (caught instanceof ApiError && caught.status === 401) {
                throw new Error("管理令牌无效")
            }
            if (caught instanceof ApiError && caught.status === 429) {
                throw new Error("尝试次数过多，请稍后再试")
            }
            throw caught
        }
        const session = await apiSession()
        if (!session.authenticated) throw new Error("会话建立失败")
        setAuthenticated(true)
    }

    const logout = async () => {
        try {
            await apiLogout()
        } catch {
            // Even if the service is unavailable, remove cached management data locally.
        } finally {
            queryClient.clear()
            setAuthenticated(false)
        }
    }

    if (sessionError) {
        return <Result status="error" title="无法连接管理服务" subTitle={sessionError} extra={<Button onClick={() => void refreshSession()}>重试</Button>} />
    }
    if (authenticated === null) {
        return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}><Spin size="large" /></div>
    }
    if (!authenticated) {
        return <Login dark={dark} onToggleDark={onToggleDark} onLogin={login} />
    }

    const selected = menuItems.find(m => m.key !== "/" && location.pathname.startsWith(m.key))?.key
        ?? "/"

    const brand = <div style={{ padding: 16, fontWeight: 700, fontSize: 18 }}>Starpoint</div>
    const menu = (
        <Menu
            mode="inline"
            selectedKeys={[selected]}
            items={menuItems}
            onClick={e => { navigate(e.key); setDrawerOpen(false) }}
            style={{ borderInlineEnd: "none" }}
        />
    )

    return (
        <Layout style={{ minHeight: "100vh" }}>
            {!isMobile && (
                <Sider theme={dark ? "dark" : "light"} breakpoint="lg" collapsedWidth={64}>
                    {brand}
                    {menu}
                </Sider>
            )}
            <Layout>
                <Header style={{ background: "transparent", padding: "0 16px", display: "flex", alignItems: "center", gap: 8 }}>
                    {isMobile && (
                        <Button type="text" icon={<MenuOutlined />} onClick={() => setDrawerOpen(true)} aria-label="菜单" />
                    )}
                    <span style={{ fontSize: 16, flex: 1 }}>管理后台</span>
                    <Space>
                        <Button type="text" onClick={() => void logout()}>退出</Button>
                        <Button
                            type="text"
                            icon={dark ? <BulbFilled style={{ color: "#faad14" }} /> : <BulbOutlined />}
                            onClick={onToggleDark}
                            aria-label="切换明暗模式"
                            title={dark ? "切换到浅色" : "切换到深色"}
                        />
                    </Space>
                </Header>
                <Content style={{ margin: isMobile ? 12 : 24 }}>
                    <Routes>
                        <Route path="/" element={<Dashboard />} />
                        <Route path="/accounts" element={<Accounts />} />
                        <Route path="/players/:playerId" element={<PlayerDetail />} />
                        <Route path="/mail" element={<Mail />} />
                        <Route path="/seeds" element={<Seeds />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </Content>
            </Layout>
            {isMobile && (
                <Drawer
                    open={drawerOpen}
                    onClose={() => setDrawerOpen(false)}
                    placement="left"
                    width={220}
                    title="Starpoint"
                    styles={{ body: { padding: 0 } }}
                >
                    {menu}
                </Drawer>
            )}
        </Layout>
    )
}
