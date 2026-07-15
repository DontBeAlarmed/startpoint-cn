// 统一 fetch 封装：所有请求走 /api（dev 由 Vite 代理到 8001）
export class ApiError extends Error {
    constructor(public status: number, message: string) {
        super(message)
    }
}

const unauthorizedListeners = new Set<() => void>()

export function subscribeUnauthorized(listener: () => void): () => void {
    unauthorizedListeners.add(listener)
    return () => unauthorizedListeners.delete(listener)
}

function request(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, { ...init, credentials: "same-origin" })
}

async function handle<T>(res: Response): Promise<T> {
    if (!res.ok) {
        if (res.status === 401) unauthorizedListeners.forEach(listener => listener())
        const text = await res.text().catch(() => "")
        let msg = text || res.statusText
        // 后端错误多为 { "error": "..." }，提取出来更友好
        try { const j = JSON.parse(text); if (j && typeof j.error === "string") msg = j.error } catch { /* not json */ }
        throw new ApiError(res.status, msg)
    }
    const ct = res.headers.get("content-type") ?? ""
    return ct.includes("application/json") ? res.json() : (res.text() as unknown as T)
}

export function apiGet<T>(url: string): Promise<T> {
    return request(url, { headers: { Accept: "application/json" } }).then(r => handle<T>(r))
}

export function apiPost<T>(url: string, body?: unknown): Promise<T> {
    return request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    }).then(r => handle<T>(r))
}

export function apiPatch<T>(url: string, body?: unknown): Promise<T> {
    return request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    }).then(r => handle<T>(r))
}

export function apiDelete<T>(url: string): Promise<T> {
    return request(url, { method: "DELETE", headers: { Accept: "application/json" } })
        .then(r => handle<T>(r))
}

// multipart 上传：不手动设 Content-Type，交给浏览器带 boundary
export function apiUpload<T>(url: string, file: File, fieldName = "file"): Promise<T> {
    const fd = new FormData()
    fd.append(fieldName, file)
    return request(url, { method: "POST", headers: { Accept: "application/json" }, body: fd })
        .then(r => handle<T>(r))
}

export const apiSession = () =>
    apiGet<{ authenticated: boolean }>("/api/admin-auth/session")

export const apiLogin = (token: string) =>
    apiPost<{ ok: true }>("/api/admin-auth/login", { token })

export const apiLogout = () =>
    apiPost<{ ok: true }>("/api/admin-auth/logout")
