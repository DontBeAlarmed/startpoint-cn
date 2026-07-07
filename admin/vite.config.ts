import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

// dev: 5173, /api 代理到 CN 服务（默认 localhost:8001）
// 若 CN_LISTEN_HOST 绑定了 LAN IP，在 admin/.env 里设 VITE_API_TARGET 覆盖
// build: 产物输出到 ../web/dist，由 cn-server 挂载在 /admin
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "")
    const apiTarget = env.VITE_API_TARGET || "http://localhost:8001"
    return {
        plugins: [react()],
        base: "/admin/",
        server: {
            port: 5173,
            proxy: {
                "/api": {
                    target: apiTarget,
                    changeOrigin: true
                }
            }
        },
        build: {
            outDir: "../web/dist",
            emptyOutDir: true
        }
    }
})
