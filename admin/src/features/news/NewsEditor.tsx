import { useEffect, useRef, useState } from "react"
import { Form, Input, Modal, Select, Switch, message } from "antd"
import { useMutation } from "@tanstack/react-query"

import { apiPatch, apiPost } from "../../api/client"
import { NewsThumb, renderNewsRichText } from "./newsPreview"
import { NEWS_COLOR_PALETTE, NEWS_TOOLBAR_ACTIONS, colorFragment, insertAround } from "./richTextToolbar"
import type { AdminNewsRow, NewsDraft } from "./types"
import type { RichTextFragment } from "./richTextToolbar"

const { TextArea } = Input

const CATEGORY_OPTIONS = [
    { value: 1, label: "主题公告" },
    { value: 2, label: "活动公告" },
    { value: 3, label: "问题公告" },
]

// 分类语义色（审查稿 #p-news：主题=水蓝 / 活动=风绿 / 问题=雷黄），列表与编辑器同源。
const CATEGORY_BADGE_CLASS: Record<number, string> = {
    1: "admin-badge-info",
    2: "admin-badge-ok",
    3: "admin-badge-warn",
}

const LABEL_OPTIONS = Array.from({ length: 8 }, (_, index) => ({
    value: index + 1,
    label: `标签 ${index + 1}`,
}))

const THUMBNAIL_OPTIONS = Array.from({ length: 13 }, (_, index) => ({
    value: index + 1,
    label: `缩略图 ${index + 1}`,
}))

interface NewsEditorProps {
    news: AdminNewsRow | null
    open: boolean
    onClose: () => void
    onSaved: (row: AdminNewsRow) => void
}

function toLocalInputValue(value: string): string {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return ""
    const offset = parsed.getTimezoneOffset() * 60_000
    return new Date(parsed.getTime() - offset).toISOString().slice(0, 16)
}

function toDraft(news: AdminNewsRow | null): NewsDraft {
    return {
        category: news?.category ?? 1,
        title: news?.title ?? "",
        publishedAtReal: news?.publishedAtReal ?? new Date().toISOString(),
        bodyRichText: news?.bodyRichText ?? "<p></p>",
        label: news?.label ?? 1,
        thumbnail: news?.thumbnail ?? 1,
        enabled: news?.enabled ?? false,
    }
}

export default function NewsEditor({ news, open, onClose, onSaved }: NewsEditorProps) {
    const [draft, setDraft] = useState<NewsDraft>(() => toDraft(news))
    // 工具栏插入点依赖原生 textarea 的 selectionStart/End（antd TextAreaRef 转手交出原生节点）
    const bodyAreaRef = useRef<HTMLTextAreaElement | null>(null)
    const [colorPaletteOpen, setColorPaletteOpen] = useState(false)

    useEffect(() => {
        if (open) setDraft(toDraft(news))
    }, [news, open])

    const save = useMutation({
        mutationFn: () => news
            ? apiPatch<AdminNewsRow>(`/api/news/${news.id}`, {
                ...draft,
                revision: news.revision,
            })
            : apiPost<AdminNewsRow>("/api/news", draft),
        onSuccess: row => {
            message.success(news ? "公告已保存" : "公告已创建")
            onSaved(row)
            onClose()
        },
        onError: (error: Error) => message.error(error.message),
    })

    const update = <K extends keyof NewsDraft>(key: K, value: NewsDraft[K]) => {
        setDraft(current => ({ ...current, [key]: value }))
    }

    // 工具栏插入：读取原生 textarea 选区 → 纯函数计算新文本 → 走既有 onChange 通道写回。
    // 受控重渲染会把光标甩到末尾，等 React 提交后再恢复焦点与选区（placeholder 保持选中）。
    const insertFragment = (fragment: RichTextFragment) => {
        const area = bodyAreaRef.current
        if (!area) return
        const result = insertAround(
            area.value,
            area.selectionStart ?? area.value.length,
            area.selectionEnd ?? area.value.length,
            fragment.open,
            fragment.close,
            fragment.placeholder,
        )
        update("bodyRichText", result.text)
        requestAnimationFrame(() => {
            area.focus()
            area.setSelectionRange(result.selStart, result.selEnd)
        })
    }

    const previewDate = new Date(draft.publishedAtReal)
    const previewDateText = Number.isNaN(previewDate.getTime())
        ? ""
        : `${previewDate.getFullYear()}-${String(previewDate.getMonth() + 1).padStart(2, "0")}-${String(previewDate.getDate()).padStart(2, "0")}`

    return (
        <Modal
            open={open}
            title={news ? "编辑公告" : "新建公告"}
            okText="保存"
            cancelText="取消"
            confirmLoading={save.isPending}
            onCancel={onClose}
            onOk={() => {
                if (!draft.title.trim()) {
                    message.error("请输入公告标题")
                    return
                }
                save.mutate()
            }}
            width="min(94vw, 1080px)"
            destroyOnClose
        >
            <div className="news-editor-grid">
                <div className="news-editor-form-col">
                    <Form layout="vertical" preserve={false}>
                        <div className="admin-form-section">
                            <div className="admin-form-section-title">基础信息</div>
                            <Form.Item label="标题" required>
                                <Input
                                    value={draft.title}
                                    maxLength={128}
                                    onChange={event => update("title", event.target.value)}
                                />
                            </Form.Item>
                            <Form.Item label="分类" required>
                                <Select
                                    options={CATEGORY_OPTIONS}
                                    value={draft.category}
                                    onChange={value => update("category", value)}
                                    labelRender={({ label }) => (
                                        <span className={CATEGORY_BADGE_CLASS[draft.category]}>{label}</span>
                                    )}
                                    optionRender={option => (
                                        <span className={CATEGORY_BADGE_CLASS[option.value as number]}>{option.label}</span>
                                    )}
                                />
                            </Form.Item>
                            <Form.Item label="标签" required>
                                <Select
                                    options={LABEL_OPTIONS}
                                    value={draft.label}
                                    onChange={value => update("label", value)}
                                />
                            </Form.Item>
                            <Form.Item label="缩略图" required>
                                <Select
                                    options={THUMBNAIL_OPTIONS}
                                    value={draft.thumbnail}
                                    onChange={value => update("thumbnail", value)}
                                />
                            </Form.Item>
                        </div>
                        <div className="admin-form-section">
                            <div className="admin-form-section-title">排期与状态</div>
                            <Form.Item label="发布时间" required>
                                <Input
                                    type="datetime-local"
                                    value={toLocalInputValue(draft.publishedAtReal)}
                                    onChange={event => {
                                        const parsed = new Date(event.target.value)
                                        if (!Number.isNaN(parsed.getTime())) {
                                            update("publishedAtReal", parsed.toISOString())
                                        }
                                    }}
                                />
                            </Form.Item>
                            <Form.Item label="启用状态">
                                <Switch
                                    checked={draft.enabled}
                                    checkedChildren="启用"
                                    unCheckedChildren="停用"
                                    onChange={value => update("enabled", value)}
                                />
                            </Form.Item>
                        </div>
                        <div className="admin-form-section">
                            <div className="admin-form-section-title">正文</div>
                            <Form.Item label="公告内容" required extra="使用客户端 RichText 标签，不支持属性和外部链接。">
                                <div className="news-toolbar" role="toolbar" aria-label="公告 RichText 插入">
                                    {NEWS_TOOLBAR_ACTIONS.map(action => (
                                        <button type="button" key={action.key}
                                            className="news-toolbar-btn"
                                            title={action.title}
                                            onMouseDown={event => event.preventDefault()}
                                            onClick={() => insertFragment(action)}
                                        >
                                            {action.label}
                                        </button>
                                    ))}
                                    <span className="news-toolbar-color-wrap">
                                        <button type="button"
                                            className={colorPaletteOpen ? "news-toolbar-btn news-toolbar-btn-active" : "news-toolbar-btn"}
                                            title="颜色 [color=xxxxxx]…[/color]"
                                            aria-expanded={colorPaletteOpen}
                                            onMouseDown={event => event.preventDefault()}
                                            onClick={() => setColorPaletteOpen(current => !current)}
                                        >
                                            A
                                        </button>
                                        {colorPaletteOpen && (
                                            <span className="news-toolbar-palette">
                                                {NEWS_COLOR_PALETTE.map(color => (
                                                    <button type="button" key={color.hex}
                                                        className="news-toolbar-swatch"
                                                        style={{ background: `#${color.hex}` }}
                                                        title={`${color.label} #${color.hex}`}
                                                        aria-label={`插入 ${color.label}（#${color.hex}）`}
                                                        onMouseDown={event => event.preventDefault()}
                                                        onClick={() => {
                                                            insertFragment(colorFragment(color.hex))
                                                            setColorPaletteOpen(false)
                                                        }}
                                                    />
                                                ))}
                                            </span>
                                        )}
                                    </span>
                                </div>
                                <TextArea
                                    rows={10}
                                    value={draft.bodyRichText}
                                    onChange={event => update("bodyRichText", event.target.value)}
                                    ref={instance => {
                                        bodyAreaRef.current = instance?.resizableTextArea?.textArea ?? null
                                    }}
                                />
                            </Form.Item>
                        </div>
                    </Form>
                </div>
                <div className="news-editor-preview-col">
                    <div className="news-phone">
                        <div className="news-phone-title">{draft.title.trim() !== "" ? draft.title : "（无标题）"}</div>
                        <NewsThumb thumbnail={draft.thumbnail} className="news-phone-thumb" />
                        <div className="news-phone-body">
                            {renderNewsRichText(draft.bodyRichText)}
                        </div>
                        <div className="news-phone-sep" />
                        <div className="news-phone-foot">
                            {previewDateText} · 官方公告{draft.enabled ? "" : " · 未启用"}
                        </div>
                    </div>
                    {/* 原始内容无障碍回退：手机拟真预览用纯前端字符串渲染 RichText，
                        这份 sandbox iframe 保留原始正文的等价文本镜像（屏幕阅读器可用）。 */}
                    <div className="news-editor-raw-frame">
                        <iframe
                            title="公告预览"
                            sandbox=""
                            srcDoc={draft.bodyRichText}
                        />
                    </div>
                </div>
            </div>
        </Modal>
    )
}
