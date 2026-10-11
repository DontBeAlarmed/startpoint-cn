import { useState } from "react"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Alert, Button, Card, Descriptions, Typography } from "antd"

import { AdminPage } from "../components/AdminPage"
import { apiGet, apiPost } from "../api/client"

interface PendingContentCheck {
    diskVersion: string
    reason: string
    upToDate: boolean
}

interface ContentState {
    targetVersion: string
    contentDigest: string
    appliedAt: string | null
    busy: boolean
    /** 磁盘待应用状态（check 不可用时为 null，按钮不置灰）。 */
    pending: PendingContentCheck | null
}

interface ApplyOutcome {
    applied: boolean
    stage?: "sync" | "reload"
    previousVersion?: string
    currentVersion: string
    releaseDigest?: string
    note?: string
    /** applied=false 且因磁盘无新内容跳过（前置 check 判定 up-to-date）。 */
    upToDate?: boolean
}

/** 内容管理：线上内容热更新（补丁包应用 → 运行时快照热重载，服务端不重启）。 */
export default function ContentManagement() {
    const [lastError, setLastError] = useState<string | null>(null)
    const queryClient = useQueryClient()

    // 与 Dashboard 同款页头刷新：手动拉取最新待应用状态
    //（全局关闭了 refetchOnWindowFocus，放补丁后靠此按钮或重进页面解灰）
    const refreshState = () => {
        queryClient.invalidateQueries({ queryKey: ["content-management"] })
    }

    const state = useQuery({
        queryKey: ["content-management", "state"],
        queryFn: () => apiGet<ContentState>("/api/content-management/state"),
    })

    const apply = useMutation({
        mutationFn: () => apiPost<{ data: ApplyOutcome }>("/api/content-management/apply"),
        onSuccess: result => {
            setLastError(null)
            if (!result.data.applied && !result.data.upToDate) {
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
    // 初始拉取期间同样视为 busy：状态未知时不给点应用（apply 的前置 check
    // 虽会兜底，但页面不应呈现"看似加载中、按钮却可点"的矛盾态）
    const busy = state.isPending || stateData?.busy === true || apply.isPending
    const upToDate = stateData?.pending?.upToDate === true

    return (
        <AdminPage
            eyebrow="OPERATIONS"
            title="内容热更新"
            description="查看当前内容快照与磁盘待应用状态，应用补丁包并热重载（进程不重启）。"
            onRefresh={refreshState}
            refreshing={state.isFetching}
        >
        <Card style={{ maxWidth: 720 }}>
            <Typography.Paragraph type="secondary">
                把补丁包放入 .cdn/patches/&lt;目标版本&gt;/ 后，点击「应用内容更新」：
                服务端同步并热重载内容快照（进程不重启）。应用期间线上服务会短暂卡顿，
                请避免在高峰时段操作。客户端将在下一次战斗结束/重新登录时自动拉取新内容。
                磁盘内容已是最新时按钮置灰，应用请求也会被前置检查直接跳过。
            </Typography.Paragraph>

            {stateData && (
                <Descriptions column={1} size="small" style={{ marginBottom: 16 }}>
                    <Descriptions.Item label="当前内容版本">{stateData.targetVersion}</Descriptions.Item>
                    <Descriptions.Item label="内容摘要">
                        <Typography.Text code style={{ fontSize: 12 }}>
                            {stateData.contentDigest}
                        </Typography.Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="待应用状态">
                        {stateData.pending === null ? (
                            <Typography.Text type="warning">状态未知（磁盘检查不可用）</Typography.Text>
                        ) : stateData.pending.upToDate ? (
                            <Typography.Text type="secondary">磁盘内容已是最新</Typography.Text>
                        ) : (
                            <Typography.Text type="success">
                                {`有待应用更新（${stateData.targetVersion} → ${stateData.pending.diskVersion}，${stateData.pending.reason}）`}
                            </Typography.Text>
                        )}
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

            {apply.data && apply.data.data.upToDate && (
                <Alert
                    type="info"
                    showIcon
                    message="磁盘内容已是最新"
                    description={apply.data.data.note}
                    style={{ marginBottom: 16 }}
                    closable
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
                disabled={busy || upToDate}
            >
                应用内容更新
            </Button>
        </Card>
        </AdminPage>
    )
}
