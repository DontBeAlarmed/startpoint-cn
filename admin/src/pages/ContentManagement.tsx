import { useState } from "react"

import { useMutation, useQuery } from "@tanstack/react-query"
import { Alert, Button, Card, Descriptions, Typography } from "antd"

import { apiGet, apiPost } from "../api/client"

interface ContentState {
    targetVersion: string
    contentDigest: string
    appliedAt: string | null
    busy: boolean
}

interface ApplyOutcome {
    applied: boolean
    stage?: "sync" | "reload"
    previousVersion?: string
    currentVersion: string
    releaseDigest?: string
    note?: string
}

/** 内容管理：线上内容热更新（补丁包应用 → 运行时快照热重载，服务端不重启）。 */
export default function ContentManagement() {
    const [lastError, setLastError] = useState<string | null>(null)

    const state = useQuery({
        queryKey: ["content-management", "state"],
        queryFn: () => apiGet<ContentState>("/api/content-management/state"),
    })

    const apply = useMutation({
        mutationFn: () => apiPost<{ data: ApplyOutcome }>("/api/content-management/apply"),
        onSuccess: result => {
            setLastError(null)
            if (!result.data.applied) {
                setLastError(result.data.note ?? "应用失败")
            }
            state.refetch()
        },
        onError: error => {
            setLastError(error instanceof Error ? error.message : String(error))
            state.refetch()
        },
    })

    const stateData = state.data
    const busy = stateData?.busy === true || apply.isPending

    return (
        <Card title="内容热更新" style={{ maxWidth: 720 }}>
            <Typography.Paragraph type="secondary">
                把补丁包放入 .cdn/patches/&lt;目标版本&gt;/ 后，点击「应用内容更新」：
                服务端同步并热重载内容快照（进程不重启）。应用期间线上服务会短暂卡顿，
                请避免在高峰时段操作。客户端将在下一次战斗结束/重新登录时自动拉取新内容。
            </Typography.Paragraph>

            {stateData && (
                <Descriptions column={1} size="small" style={{ marginBottom: 16 }}>
                    <Descriptions.Item label="当前内容版本">{stateData.targetVersion}</Descriptions.Item>
                    <Descriptions.Item label="内容摘要">
                        <Typography.Text code style={{ fontSize: 12 }}>
                            {stateData.contentDigest}
                        </Typography.Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="上次应用">
                        {stateData.appliedAt ?? "本次进程内尚未应用（重启后清空）"}
                    </Descriptions.Item>
                </Descriptions>
            )}

            {lastError && (
                <Alert
                    type="warning"
                    showIcon
                    message="应用未完成"
                    description={lastError}
                    style={{ marginBottom: 16 }}
                    closable
                    onClose={() => setLastError(null)}
                />
            )}

            {apply.data && apply.data.data.applied && (
                <Alert
                    type="success"
                    showIcon
                    message={`已应用：${apply.data.data.previousVersion} → ${apply.data.data.currentVersion}`}
                    description="新内容将在客户端下一次校验（战斗结束/重新登录）时生效。"
                    style={{ marginBottom: 16 }}
                    closable
                />
            )}

            <Button
                type="primary"
                loading={busy}
                onClick={() => apply.mutate()}
                disabled={busy}
            >
                应用内容更新
            </Button>
        </Card>
    )
}
