import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import App from "./App"
import { ThemeProvider, useThemeMode } from "./theme"
import "./styles.css"

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: 1, refetchOnWindowFocus: false }
    }
})

function ThemedApp() {
    const { mode, toggle } = useThemeMode()
    return (
        <BrowserRouter basename="/admin">
            <App dark={mode === "dark"} onToggleDark={toggle} />
        </BrowserRouter>
    )
}

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <ThemeProvider>
                <ThemedApp />
            </ThemeProvider>
        </QueryClientProvider>
    </React.StrictMode>
)
