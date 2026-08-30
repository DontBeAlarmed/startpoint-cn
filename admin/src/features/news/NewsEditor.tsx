import { useEffect, useState } from "react"
import { Form, Input, Modal, Select, Switch, message } from "antd"
import { useMutation } from "@tanstack/react-query"

import { apiPatch, apiPost } from "../../api/client"
import type { AdminNewsRow, NewsDraft } from "./types"

const { TextArea } = Input

const CATEGORY_OPTIONS = [
    { value: 1, label: "主题公告" },
    { value: 2, label: "活动公告" },
    { value: 3, label: "问题公告" },
]

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
            width={860}
            destroyOnClose
        >
            <Form layout="vertical" preserve={false}>
                <Form.Item label="标题" required>
                    <Input
                        value={draft.title}
                        maxLength={128}
                        onChange={event => update("title", event.target.value)}
                    />
                </Form.Item>
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
                <Form.Item label="分类" required>
                    <Select
                        options={CATEGORY_OPTIONS}
                        value={draft.category}
                        onChange={value => update("category", value)}
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
                <Form.Item label="启用状态">
                    <Switch
                        checked={draft.enabled}
                        checkedChildren="启用"
                        unCheckedChildren="停用"
                        onChange={value => update("enabled", value)}
                    />
                </Form.Item>
                <Form.Item label="公告内容" required extra="使用客户端 RichText 标签，不支持属性和外部链接。">
                    <TextArea
                        rows={10}
                        value={draft.bodyRichText}
                        onChange={event => update("bodyRichText", event.target.value)}
                    />
                </Form.Item>
            </Form>
            <div className="news-editor-preview">
                <iframe
                    title="公告预览"
                    sandbox=""
                    srcDoc={draft.bodyRichText}
                />
            </div>
        </Modal>
    )
}
