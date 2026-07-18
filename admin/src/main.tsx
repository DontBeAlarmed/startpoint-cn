import React, { useState, useEffect } from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ConfigProvider, theme as antdTheme } from "antd"
import zhCN from "antd/locale/zh_CN"
import App from "./App"
import "./styles.css"

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: 1, refetchOnWindowFocus: false }
    }
})

const prefersDark = () =>
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches

function Root() {
    // 自动跟随系统深浅色；用户可在顶栏手动覆盖（覆盖后系统再变化仍会跟随）
    const [dark, setDark] = useState(prefersDark)

    useEffect(() => {
        const mq = window.matchMedia("(prefers-color-scheme: dark)")
        const handler = (e: MediaQueryListEvent) => setDark(e.matches)
        mq.addEventListener("change", handler)
        return () => mq.removeEventListener("change", handler)
    }, [])

    useEffect(() => {
        document.documentElement.dataset.adminTheme = dark ? "dark" : "light"
        document.documentElement.style.colorScheme = dark ? "dark" : "light"
    }, [dark])

    return (
        <QueryClientProvider client={queryClient}>
            <ConfigProvider
                locale={zhCN}
                theme={{
                    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
                    token: {
                        colorPrimary: dark ? "#62b397" : "#2f7a67",
                        colorInfo: dark ? "#72afd0" : "#2d6f99",
                        colorSuccess: dark ? "#81bb92" : "#43805d",
                        colorWarning: dark ? "#dfb15c" : "#b27822",
                        colorError: dark ? "#df776c" : "#b84a42",
                        colorBgLayout: "transparent",
                        colorBgContainer: dark ? "#20231d" : "#fffdf7",
                        colorBorder: dark ? "#3b4035" : "#d8d0bf",
                        colorText: dark ? "#f0eadb" : "#292621",
                        colorTextSecondary: dark ? "#b6ad98" : "#6f6658",
                        borderRadius: 6,
                        borderRadiusLG: 8,
                        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
                    },
                    components: {
                        Button: {
                            borderRadius: 6,
                            controlHeight: 34,
                        },
                        Card: {
                            borderRadiusLG: 8,
                            headerFontSize: 15,
                        },
                        Table: {
                            borderColor: dark ? "#3b4035" : "#d8d0bf",
                            headerBg: dark ? "#262a22" : "#f7f1e4",
                        },
                    },
                }}
            >
                <BrowserRouter basename="/admin">
                    <App dark={dark} onToggleDark={() => setDark(d => !d)} />
                </BrowserRouter>
            </ConfigProvider>
        </QueryClientProvider>
    )
}

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <Root />
    </React.StrictMode>
)
