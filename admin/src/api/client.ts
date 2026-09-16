// 统一 fetch 封装：所有请求走 /api（dev 由 Vite 代理到 8001）
export class ApiError extends Error {
    constructor(public status: number, message: string) {
        super(message)
    }
}

async function handle<T>(res: Response): Promise<T> {
    if (!res.ok) {
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
    return fetch(url, { headers: { Accept: "application/json" } }).then(r => handle<T>(r))
}

export function apiPost<T>(url: string, body?: unknown): Promise<T> {
    return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    }).then(r => handle<T>(r))
}

export function apiPatch<T>(url: string, body?: unknown): Promise<T> {
    return fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    }).then(r => handle<T>(r))
}

export function apiDelete<T>(url: string): Promise<T> {
    return fetch(url, { method: "DELETE", headers: { Accept: "application/json" } })
        .then(r => handle<T>(r))
}

// multipart 上传：不手动设 Content-Type，交给浏览器带 boundary
export function apiUpload<T>(url: string, file: File, fieldName = "file"): Promise<T> {
    const fd = new FormData()
    fd.append(fieldName, file)
    return fetch(url, { method: "POST", headers: { Accept: "application/json" }, body: fd })
        .then(r => handle<T>(r))
}

// 附件下载：走与其它 /api 相同的 fetch 通道（携带部署层后台认证/凭据），
// 错误就地抛 ApiError 供页面显示，成功后按 content-disposition 文件名触发保存。
export async function apiDownloadFile(url: string, fallbackFilename: string): Promise<void> {
    const res = await fetch(url, { headers: { Accept: "application/json" } })
    if (!res.ok) {
        const text = await res.text().catch(() => "")
        let msg = text || res.statusText
        try { const j = JSON.parse(text); if (j && typeof j.error === "string") msg = j.error } catch { /* not json */ }
        throw new ApiError(res.status, msg)
    }
    const blob = await res.blob()
    const disposition = res.headers.get("content-disposition") ?? ""
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackFilename
    const objectUrl = URL.createObjectURL(blob)
    try {
        const a = document.createElement("a")
        a.href = objectUrl
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
    } finally {
        URL.revokeObjectURL(objectUrl)
    }
}
