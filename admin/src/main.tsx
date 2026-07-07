import React, { useState, useEffect } from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ConfigProvider, theme as antdTheme } from "antd"
import zhCN from "antd/locale/zh_CN"
import App from "./App"

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
        document.documentElement.style.colorScheme = dark ? "dark" : "light"
        document.body.style.background = dark ? "#141414" : "#f5f5f5"
        document.body.style.margin = "0"
    }, [dark])

    return (
        <QueryClientProvider client={queryClient}>
            <ConfigProvider
                locale={zhCN}
                theme={{ algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}
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
