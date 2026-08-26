import { useMemo, useState } from "react"
import {
    Button,
    Card,
    DatePicker,
    Form,
    Input,
    InputNumber,
    Modal,
    Popconfirm,
    Radio,
    Select,
    Space,
    Switch,
    Table,
    Tag,
    Typography,
    message,
} from "antd"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import dayjs, { type Dayjs } from "dayjs"

import { apiDelete, apiGet, apiPatch, apiPost } from "../api/client"

interface PlayerBrief {
    id: number
    name: string
}

interface ScheduledResourceRule {
    id: number
    scope: "global" | "player"
    playerId: number | null
    rewardType: "item" | "free_vmoney"
    rewardId: number | null
    rewardName: string
    grantAmount: number
    triggerThreshold: number
    inventoryCap: number
    officialMaxCount: number
    enabled: boolean
    startsAtReal: string | null
    endsAtReal: string | null
    description: string | null
}

interface RuleFormValues {
    scope: "global" | "player"
    playerId?: number
    rewardType: "item" | "free_vmoney"
    rewardId?: number
    grantAmount: number
    triggerThreshold: number
    inventoryCap: number
    enabled: boolean
    startsAtReal?: Dayjs | null
    endsAtReal?: Dayjs | null
    description?: string
}

interface ScheduledResourceRulesProps {
    players: readonly PlayerBrief[]
}

function toRequest(values: RuleFormValues) {
    return {
        scope: values.scope,
        playerId: values.scope === "player" ? values.playerId : null,
        rewardType: values.rewardType,
        rewardId: values.rewardType === "item" ? values.rewardId : null,
        grantAmount: values.grantAmount,
        triggerThreshold: values.triggerThreshold,
        inventoryCap: values.inventoryCap,
        enabled: values.enabled,
        startsAtReal: values.startsAtReal?.toISOString() ?? null,
        endsAtReal: values.endsAtReal?.toISOString() ?? null,
        description: values.description?.trim() || null,
    }
}

export function ScheduledResourceRules({ players }: ScheduledResourceRulesProps) {
    const queryClient = useQueryClient()
    const [form] = Form.useForm<RuleFormValues>()
    const [editingRule, setEditingRule] = useState<ScheduledResourceRule | null>(null)
    const [modalOpen, setModalOpen] = useState(false)
    const scope = Form.useWatch("scope", form)
    const rewardType = Form.useWatch("rewardType", form)
    const rewardId = Form.useWatch("rewardId", form)

    const rules = useQuery({
        queryKey: ["scheduledResourceRules"],
        queryFn: () => apiGet<ScheduledResourceRule[]>("/api/scheduled-resource"),
    })
    const { data: itemLookup = {} } = useQuery({
        queryKey: ["mailAttachmentLookup", 1],
        queryFn: () => apiGet<Record<string, string>>("/api/lookup/items"),
        staleTime: Infinity,
    })
    const { data: itemMaxCounts = {} } = useQuery({
        queryKey: ["itemMaxCounts"],
        queryFn: () => apiGet<Record<string, number>>("/api/lookup/item-max-counts"),
        staleTime: Infinity,
    })
    const { data: authority } = useQuery({
        queryKey: ["scheduledResourceAuthority"],
        queryFn: () => apiGet<{ maxFreeVmoney: number }>("/api/scheduled-resource/authority"),
        staleTime: Infinity,
    })

    const officialMax = rewardType === "free_vmoney"
        ? authority?.maxFreeVmoney
        : rewardId == null ? undefined : itemMaxCounts[String(rewardId)]
    const itemOptions = useMemo(() => Object.entries(itemLookup)
        .map(([id, name]) => ({
            value: Number(id),
            label: `${name}（#${id}，上限 ${itemMaxCounts[id] ?? "?"}）`,
        }))
        .sort((left, right) => left.value - right.value), [itemLookup, itemMaxCounts])

    const save = useMutation({
        mutationFn: ({ rule, values }: {
            rule: ScheduledResourceRule | null
            values: RuleFormValues
        }) => rule
            ? apiPatch<ScheduledResourceRule>(`/api/scheduled-resource/${rule.id}`, toRequest(values))
            : apiPost<ScheduledResourceRule>("/api/scheduled-resource", toRequest(values)),
        onSuccess: () => {
            message.success(editingRule ? "规则已保存" : "规则已创建")
            setModalOpen(false)
            setEditingRule(null)
            queryClient.invalidateQueries({ queryKey: ["scheduledResourceRules"] })
        },
        onError: (error: Error) => message.error(error.message),
    })
    const toggle = useMutation({
        mutationFn: (rule: ScheduledResourceRule) => apiPatch<ScheduledResourceRule>(
            `/api/scheduled-resource/${rule.id}/enabled`,
            { enabled: !rule.enabled },
        ),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["scheduledResourceRules"] }),
        onError: (error: Error) => message.error(error.message),
    })
    const remove = useMutation({
        mutationFn: (ruleId: number) => apiDelete<{ ok: boolean }>(`/api/scheduled-resource/${ruleId}`),
        onSuccess: () => {
            message.success("规则已删除")
            queryClient.invalidateQueries({ queryKey: ["scheduledResourceRules"] })
        },
        onError: (error: Error) => message.error(error.message),
    })

    const openCreate = () => {
        setEditingRule(null)
        form.setFieldsValue({
            scope: "global",
            playerId: undefined,
            rewardType: "item",
            rewardId: undefined,
            grantAmount: 1,
            triggerThreshold: 0,
            inventoryCap: undefined,
            enabled: true,
            startsAtReal: null,
            endsAtReal: null,
            description: "",
        })
        setModalOpen(true)
    }
    const openEdit = (rule: ScheduledResourceRule) => {
        setEditingRule(rule)
        form.setFieldsValue({
            scope: rule.scope,
            playerId: rule.playerId ?? undefined,
            rewardType: rule.rewardType,
            rewardId: rule.rewardId ?? undefined,
            grantAmount: rule.grantAmount,
            triggerThreshold: rule.triggerThreshold,
            inventoryCap: rule.inventoryCap,
            enabled: rule.enabled,
            startsAtReal: rule.startsAtReal ? dayjs(rule.startsAtReal) : null,
            endsAtReal: rule.endsAtReal ? dayjs(rule.endsAtReal) : null,
            description: rule.description ?? "",
        })
        setModalOpen(true)
    }

    return (
        <>
            <Card
                title="定时资源补充"
                extra={(
                    <Button type="primary" icon={<Plus size={16} />} onClick={openCreate}>
                        新建规则
                    </Button>
                )}
                className="admin-table-card"
            >
                <Table<ScheduledResourceRule>
                    rowKey="id"
                    loading={rules.isLoading}
                    dataSource={rules.data ?? []}
                    pagination={{ pageSize: 10, hideOnSinglePage: true }}
                    scroll={{ x: "max-content" }}
                    locale={{ emptyText: "暂无定时补充规则" }}
                    columns={[
                        { title: "范围", render: (_, rule) => rule.scope === "global" ? "全局规则" : `指定存档 #${rule.playerId}` },
                        { title: "资源", dataIndex: "rewardName" },
                        { title: "发放数量", dataIndex: "grantAmount" },
                        { title: "触发下限", dataIndex: "triggerThreshold" },
                        { title: "持有上限", render: (_, rule) => `${rule.inventoryCap} / ${rule.officialMaxCount}` },
                        {
                            title: "状态",
                            render: (_, rule) => (
                                <Switch
                                    checked={rule.enabled}
                                    checkedChildren="启用"
                                    unCheckedChildren="停用"
                                    loading={toggle.isPending}
                                    onChange={() => toggle.mutate(rule)}
                                />
                            ),
                        },
                        {
                            title: "启用区间",
                            render: (_, rule) => (
                                <Typography.Text>
                                    {rule.startsAtReal ? dayjs(rule.startsAtReal).format("YYYY-MM-DD HH:mm") : "不限"}
                                    {" 至 "}
                                    {rule.endsAtReal ? dayjs(rule.endsAtReal).format("YYYY-MM-DD HH:mm") : "不限"}
                                </Typography.Text>
                            ),
                        },
                        { title: "备注", dataIndex: "description", render: value => value || "-" },
                        {
                            title: "操作",
                            fixed: "right",
                            render: (_, rule) => (
                                <Space>
                                    <Button icon={<Pencil size={15} />} onClick={() => openEdit(rule)}>编辑</Button>
                                    <Popconfirm
                                        title="删除这条定时补充规则？"
                                        okText="删除"
                                        cancelText="取消"
                                        okButtonProps={{ danger: true }}
                                        onConfirm={() => remove.mutate(rule.id)}
                                    >
                                        <Button danger icon={<Trash2 size={15} />}>删除</Button>
                                    </Popconfirm>
                                </Space>
                            ),
                        },
                    ]}
                />
            </Card>

            <Modal
                open={modalOpen}
                title={editingRule ? "编辑定时资源补充" : "新建定时资源补充"}
                okText="保存"
                cancelText="取消"
                confirmLoading={save.isPending}
                onCancel={() => setModalOpen(false)}
                onOk={() => form.validateFields().then(values => save.mutate({ rule: editingRule, values }))}
                destroyOnClose
                width={720}
            >
                <Form form={form} layout="vertical" preserve={false}>
                    <Form.Item name="scope" label="规则范围" rules={[{ required: true }]}>
                        <Radio.Group optionType="button" buttonStyle="solid">
                            <Radio.Button value="global">全局规则</Radio.Button>
                            <Radio.Button value="player">指定存档</Radio.Button>
                        </Radio.Group>
                    </Form.Item>
                    {scope === "player" && (
                        <Form.Item name="playerId" label="指定存档" rules={[{ required: true, message: "请选择存档" }]}>
                            <Select
                                showSearch
                                optionFilterProp="label"
                                options={players.map(player => ({ value: player.id, label: `${player.name}（#${player.id}）` }))}
                            />
                        </Form.Item>
                    )}
                    <Form.Item name="rewardType" label="资源类型" rules={[{ required: true }]}>
                        <Radio.Group
                            optionType="button"
                            buttonStyle="solid"
                            onChange={event => form.setFieldsValue({
                                rewardId: undefined,
                                inventoryCap: event.target.value === "free_vmoney" ? authority?.maxFreeVmoney : undefined,
                            })}
                        >
                            <Radio.Button value="item">道具</Radio.Button>
                            <Radio.Button value="free_vmoney">免费星导石</Radio.Button>
                        </Radio.Group>
                    </Form.Item>
                    {rewardType === "item" && (
                        <Form.Item name="rewardId" label="道具" rules={[{ required: true, message: "请选择道具" }]}>
                            <Select
                                showSearch
                                optionFilterProp="label"
                                options={itemOptions}
                                onChange={id => form.setFieldValue("inventoryCap", itemMaxCounts[String(id)])}
                            />
                        </Form.Item>
                    )}
                    <Space wrap size="large" align="start">
                        <Form.Item name="grantAmount" label="发放数量" rules={[{ required: true }]}>
                            <InputNumber min={1} precision={0} />
                        </Form.Item>
                        <Form.Item name="triggerThreshold" label="触发下限" rules={[{ required: true }]}>
                            <InputNumber min={0} precision={0} />
                        </Form.Item>
                        <Form.Item
                            name="inventoryCap"
                            label="持有上限"
                            extra={officialMax === undefined ? "选择资源后显示官方上限" : `官方上限 ${officialMax}`}
                            rules={[{ required: true }]}
                        >
                            <InputNumber min={1} max={officialMax} precision={0} />
                        </Form.Item>
                    </Space>
                    <Form.Item name="enabled" label="启用" valuePropName="checked">
                        <Switch />
                    </Form.Item>
                    <Space wrap size="large" align="start">
                        <Form.Item name="startsAtReal" label="开始时间">
                            <DatePicker showTime />
                        </Form.Item>
                        <Form.Item name="endsAtReal" label="结束时间">
                            <DatePicker showTime />
                        </Form.Item>
                    </Space>
                    <Form.Item name="description" label="备注">
                        <Input maxLength={200} showCount />
                    </Form.Item>
                    <Tag color="blue">每日边界使用服务端 DAILY_RESET_HOUR</Tag>
                </Form>
            </Modal>
        </>
    )
}
