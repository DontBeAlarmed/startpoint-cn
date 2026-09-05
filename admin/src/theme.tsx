import { ConfigProvider, theme as antdTheme } from "antd"
import zhCN from "antd/locale/zh_CN"
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

const STORAGE_KEY = "starpoint-admin-theme"
export type ThemeMode = "light" | "dark"

function resolveInitialMode(): ThemeMode {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === "light" || saved === "dark") return saved
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

const ThemeContext = createContext<{ mode: ThemeMode; toggle: () => void }>({
    mode: "light",
    toggle: () => {},
})

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [mode, setMode] = useState<ThemeMode>(resolveInitialMode)
    useEffect(() => {
        document.documentElement.dataset.theme = mode
        localStorage.setItem(STORAGE_KEY, mode)
    }, [mode])
    const toggle = () => setMode(m => (m === "light" ? "dark" : "light"))
    return (
        <ThemeContext.Provider value={{ mode, toggle }}>
            <ConfigProvider
                locale={zhCN}
                theme={{
                    algorithm: mode === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
                    token: {
                        colorPrimary: "#FFD335",
                        colorTextLightSolid: "#1F2D4D",
                        borderRadius: 8,
                        ...(mode === "dark" ? {
                            colorBgContainer: "#161B22",      // 卡/表/输入框容器底 → 石墨
                            colorBgElevated: "#21262D",       // 弹层/下拉/模态浮层底
                            colorBgLayout: "#0D1117",         // 布局底
                            colorBorderSecondary: "#30363D",  // 内部描边
                        } : {}),
                    },
                    components: {
                        // Tooltip 内部用全局 colorTextLightSolid（深色，服务黄色主按钮文字）渲染浮层文字，
                        // 会变成深底深字。仅对 Tooltip 固定深色半透明底 + 浅色文字，两种主题下都可读。
                        Tooltip: {
                            colorBgSpotlight: "rgba(11, 15, 20, 0.96)",
                            colorTextLightSolid: "#E6EDF3",
                        },
                    },
                }}
            >
                {children}
            </ConfigProvider>
        </ThemeContext.Provider>
    )
}

export function useThemeMode() {
    return useContext(ThemeContext)
}

export function ThemeToggle() {
    const { mode, toggle } = useThemeMode()
    return (
        <button type="button" className="admin-theme-toggle" onClick={toggle}>
            {mode === "light" ? "◐ 黑夜" : "◐ 白昼"}
        </button>
    )
}
