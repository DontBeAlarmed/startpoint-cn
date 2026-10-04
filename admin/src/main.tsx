import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import App from "./App"
import { ThemeProvider } from "./theme"
import "./styles.css"

// 真实触摸检测: 部分触屏浏览器(含维护者的 iQOO)会把 (hover: hover) 媒体查询判为真,
// 纯 CSS 门控挡不住点按粘滞 :hover 整卡变色 — 首次 touchstart 后给 <html> 挂
// has-touch 类, accounts.css 的卡片 hover 规则以此为最终闸门
window.addEventListener(
    "touchstart",
    () => { document.documentElement.classList.add("has-touch") },
    { once: true, passive: true },
)

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: 1, refetchOnWindowFocus: false }
    }
})

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <ThemeProvider>
                <BrowserRouter basename="/admin">
                    <App />
                </BrowserRouter>
            </ThemeProvider>
        </QueryClientProvider>
    </React.StrictMode>
)
