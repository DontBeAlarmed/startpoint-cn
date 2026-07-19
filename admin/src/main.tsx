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

function Root() {
    const [dark, setDark] = useState(true)

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
                        colorPrimary: dark ? "#39d9e6" : "#48d6d2",
                        colorInfo: dark ? "#6ba9ff" : "#67a7ff",
                        colorSuccess: dark ? "#65eca7" : "#64e6a2",
                        colorWarning: dark ? "#ffc15d" : "#ffb84a",
                        colorError: dark ? "#ff6c9d" : "#ff6b91",
                        colorBgLayout: "transparent",
                        colorBgContainer: dark ? "#10182a" : "#172133",
                        colorBgElevated: dark ? "#16223a" : "#1d2a41",
                        colorBorder: dark ? "#263a5b" : "#2e4263",
                        colorText: dark ? "#f7fbff" : "#f5f8ff",
                        colorTextSecondary: dark ? "#aebbd2" : "#afbdd1",
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
                            borderColor: dark ? "#263a5b" : "#2e4263",
                            headerBg: dark ? "#16223a" : "#1d2a41",
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
