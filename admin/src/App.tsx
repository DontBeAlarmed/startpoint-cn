import { useState } from "react"
import { Layout, Menu, Grid, Button, Drawer, Space } from "antd"
import {
    Database,
    Gauge,
    Clock3,
    Mail as MailIcon,
    Menu as MenuIcon,
    Moon,
    Settings2,
    Sparkles,
    Sun,
    Users,
} from "lucide-react"
import { Routes, Route, useNavigate, useLocation, Navigate } from "react-router-dom"
import Dashboard from "./pages/Dashboard"
import Accounts from "./pages/Accounts"
import PlayerDetail from "./pages/PlayerDetail"
import Mail from "./pages/Mail"
import Seeds from "./pages/Seeds"
import TimeControl from "./pages/TimeControl"
import GameplaySettings from "./pages/GameplaySettings"
import logoUrl from "./assets/logo.png"

const { Sider, Content, Header } = Layout
const { useBreakpoint } = Grid

const menuItems = [
    { key: "/", icon: <Gauge size={18} />, label: "总览" },
    { key: "/time", icon: <Clock3 size={18} />, label: "时间 / 千里眼" },
    { key: "/accounts", icon: <Users size={18} />, label: "账号 / 存档" },
    { key: "/mail", icon: <MailIcon size={18} />, label: "邮件" },
    { key: "/seeds", icon: <Database size={18} />, label: "种子管理" },
    { key: "/settings", icon: <Settings2 size={18} />, label: "游戏设置" },
]

const pageTitles: Record<string, string> = {
    "/": "总览",
    "/time": "时间 / 千里眼",
    "/accounts": "账号 / 存档",
    "/mail": "邮件",
    "/seeds": "种子管理",
    "/settings": "游戏设置",
}

interface AppProps {
    dark: boolean
    onToggleDark: () => void
}

export default function App({ dark, onToggleDark }: AppProps) {
    const navigate = useNavigate()
    const location = useLocation()
    const screens = useBreakpoint()
    const isMobile = !screens.md
    const [drawerOpen, setDrawerOpen] = useState(false)

    const selected = menuItems.find(m => m.key !== "/" && location.pathname.startsWith(m.key))?.key
        ?? "/"
    const currentTitle = location.pathname.startsWith("/players/")
        ? "玩家详情"
        : pageTitles[selected] ?? "管理后台"

    const brand = (
        <div className="admin-brand">
            <span className="admin-brand-mark">
                <img src={logoUrl} alt="World Flipper 上游项目标识" />
            </span>
            <span className="admin-brand-copy">
                <span className="admin-brand-title">Starpoint CN</span>
                <span className="admin-brand-subtitle">World Flipper Server</span>
            </span>
        </div>
    )
    const menu = (
        <Menu
            className="admin-menu"
            mode="inline"
            selectedKeys={[selected]}
            items={menuItems}
            onClick={e => { navigate(e.key); setDrawerOpen(false) }}
        />
    )

    return (
        <Layout className="admin-app">
            {!isMobile && (
                <Sider className="admin-sider" theme="light" width={248} breakpoint="lg" collapsedWidth={72}>
                    {brand}
                    {menu}
                </Sider>
            )}
            <Layout>
                <Header className="admin-topbar">
                    {isMobile && (
                        <Button
                            type="text"
                            icon={<MenuIcon size={18} />}
                            onClick={() => setDrawerOpen(true)}
                            aria-label="打开导航"
                        />
                    )}
                    <span className="admin-topbar-title">{currentTitle}</span>
                    <Space>
                        <Button
                            type="text"
                            icon={dark ? <Sun size={18} /> : <Moon size={18} />}
                            onClick={onToggleDark}
                            aria-label="切换明暗模式"
                            title={dark ? "切换到浅色" : "切换到深色"}
                        />
                    </Space>
                </Header>
                <Content className="admin-content">
                    <Routes>
                        <Route path="/" element={<Dashboard />} />
                        <Route path="/time" element={<TimeControl />} />
                        <Route path="/accounts" element={<Accounts />} />
                        <Route path="/players/:playerId" element={<PlayerDetail />} />
                        <Route path="/mail" element={<Mail />} />
                        <Route path="/seeds" element={<Seeds />} />
                        <Route path="/settings" element={<GameplaySettings />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </Content>
            </Layout>
            {isMobile && (
                <Drawer
                    open={drawerOpen}
                    onClose={() => setDrawerOpen(false)}
                    placement="left"
                    width={260}
                    title={(
                        <Space size={8}>
                            <Sparkles size={18} />
                            <span>Starpoint CN</span>
                        </Space>
                    )}
                    styles={{ body: { padding: 0 }, header: { borderBottom: "1px solid var(--admin-border)" } }}
                >
                    {menu}
                </Drawer>
            )}
        </Layout>
    )
}
