import { useEffect } from "react"
import { Button, Form, Input, InputNumber, Modal, Select, Space, message } from "antd"
import { Plus, Trash2 } from "lucide-react"
import { useMutation, useQuery } from "@tanstack/react-query"

import { apiGet, apiPatch, apiPost } from "../../api/client"
import {
    GIFT_REWARD_TYPES,
    type AdminGiftRow,
    type GiftDraftRequest,
    type GiftProtocolType,
} from "./types"

interface CharacterLookupRow {
    readonly name: string
    readonly title: string
}

interface EquipmentLookupRow {
    readonly name: string
}

type CharacterLookup = Record<string, CharacterLookupRow>
type EquipmentLookup = Record<string, EquipmentLookupRow>

interface GiftFormValues {
    code: string
    note?: string
    rewards?: ReadonlyArray<{
        type: GiftProtocolType
        typeId?: number | null
        number: number
    }>
}

interface GiftEditorProps {
    gift: AdminGiftRow | null
    open: boolean
    onClose: () => void
    onSaved: (row: AdminGiftRow) => void
}

function requiresTypeId(type: GiftProtocolType | undefined): boolean {
    return type === 1 || type === 5 || type === 6
}

export default function GiftEditor({ gift, open, onClose, onSaved }: GiftEditorProps) {
    const [form] = Form.useForm<GiftFormValues>()
    const code = Form.useWatch("code", form)
    const rewards = Form.useWatch("rewards", form)
    const isActive = gift?.status === "active"

    const { data: itemLookup = {} } = useQuery({
        queryKey: ["giftItemLookup"],
        queryFn: () => apiGet<Record<string, string>>("/api/lookup/items"),
        staleTime: Infinity,
    })
    const { data: characterLookup = {} } = useQuery({
        queryKey: ["giftCharacterLookup"],
        queryFn: () => apiGet<CharacterLookup>("/api/lookup/characters"),
        staleTime: Infinity,
    })
    const { data: equipmentLookup = {} } = useQuery({
        queryKey: ["giftEquipmentLookup"],
        queryFn: () => apiGet<EquipmentLookup>("/api/lookup/equipment"),
        staleTime: Infinity,
    })

    useEffect(() => {
        if (!open) return
        form.setFieldsValue({
            code: gift?.code ?? "",
            note: gift?.note ?? "",
            rewards: gift?.rewards.map(reward => ({
                type: reward.type,
                typeId: reward.typeId,
                number: reward.number,
            })) ?? [{
                type: 8,
                typeId: null,
                number: 100,
            }],
        })
    }, [form, gift, open])

    const save = useMutation({
        mutationFn: (values: GiftFormValues) => {
            const draft: GiftDraftRequest = {
                code: values.code,
                note: values.note ?? null,
                rewards: (values.rewards ?? []).map((reward, position) => ({
                    position,
                    type: reward.type,
                    typeId: reward.typeId ?? null,
                    number: reward.number,
                })),
            }
            const payload = gift ? { ...draft, revision: gift.revision } : draft
            return gift
                ? apiPatch<AdminGiftRow>(`/api/gifts/${gift.id}`, payload)
                : apiPost<AdminGiftRow>("/api/gifts", payload)
        },
        onSuccess: row => {
            message.success(gift ? "礼包已保存" : "礼包已创建")
            onSaved(row)
            onClose()
        },
        onError: (error: Error) => message.error(error.message),
    })

    const changeRewardType = (index: number, type: GiftProtocolType) => {
        const current = form.getFieldValue("rewards") ?? []
        const next = [...current]
        next[index] = {
            ...next[index],
            type,
            typeId: requiresTypeId(type) ? next[index]?.typeId : null,
            number: type === 5 || type === 6 ? 1 : next[index]?.number ?? 100,
        }
        form.setFieldsValue({ rewards: next })
    }

    return (
        <Modal
            open={open}
            title={gift ? "编辑礼包" : "新建礼包"}
            okText="保存"
            cancelText="取消"
            confirmLoading={save.isPending}
            okButtonProps={{ disabled: isActive }}
            onCancel={onClose}
            onOk={() => form.submit()}
            width={880}
            destroyOnClose
        >
            <Form form={form} layout="vertical" disabled={isActive} onFinish={values => save.mutate(values)}>
                <Form.Item
                    name="code"
                    label="礼包 code"
                    required
                    rules={[{ required: true, message: "请输入礼包 code" }]}
                >
                    <Input maxLength={20} value={code} autoComplete="off" />
                </Form.Item>
                <Form.Item name="note" label="备注">
                    <Input.TextArea rows={3} maxLength={512} />
                </Form.Item>

                <Form.List name="rewards"
                    rules={[{
                        validator: (_, value) => {
                            if (!value || value.length < 1) {
                                return Promise.reject(new Error("至少需要 1 条奖励"))
                            }
                            if (value.length > 20) {
                                return Promise.reject(new Error("最多只能添加 20 条奖励"))
                            }
                            return Promise.resolve()
                        },
                    }]}
                >
                    {(fields, { add, remove }, { errors }) => (
                        <>
                            {fields.map(field => {
                                const reward = rewards?.[field.name]
                                const type = reward?.type
                                const showTypeId = requiresTypeId(type)
                                return (
                                    <Space key={field.key} align="baseline" className="gift-reward-row">
                                        <Form.Item
                                            name={[field.name, "type"]}
                                            label="奖励类型"
                                            rules={[{ required: true, message: "请选择奖励类型" }]}
                                        >
                                            <Select
                                                options={GIFT_REWARD_TYPES.map(({ value, label }) => ({ value, label }))}
                                                onChange={next => changeRewardType(field.name, next)}
                                                style={{ width: 150 }}
                                            />
                                        </Form.Item>
                                        {showTypeId && (
                                            <Form.Item
                                                name={[field.name, "typeId"]}
                                                label="奖励对象"
                                                rules={[{ required: true, message: "请选择奖励对象" }]}
                                            >
                                                <Select
                                                    showSearch
                                                    optionFilterProp="label"
                                                    options={type === 1
                                                        ? Object.entries(itemLookup).map(([id, name]) => ({
                                                            value: Number(id),
                                                            label: `${name} #${id}`,
                                                        }))
                                                        : type === 5
                                                            ? Object.entries(characterLookup).map(([id, row]) => ({
                                                                value: Number(id),
                                                                label: `${row.name} ${row.title} #${id}`,
                                                            }))
                                                            : Object.entries(equipmentLookup).map(([id, row]) => ({
                                                                value: Number(id),
                                                                label: `${row.name} #${id}`,
                                                            }))}
                                                    placeholder="请选择"
                                                    style={{ width: 240 }}
                                                />
                                            </Form.Item>
                                        )}
                                        <Form.Item
                                            name={[field.name, "number"]}
                                            label="数量"
                                            rules={[{ required: true, message: "请输入数量" }]}
                                        >
                                            <InputNumber
                                                min={1}
                                                max={type === 5 || type === 6 ? 1 : 2147483647}
                                                precision={0}
                                                style={{ width: 110 }}
                                            />
                                        </Form.Item>
                                        <Button
                                            type="text"
                                            danger
                                            icon={<Trash2 size={15} />}
                                            disabled={fields.length <= 1}
                                            onClick={() => remove(field.name)}
                                            aria-label="移除奖励"
                                        />
                                    </Space>
                                )
                            })}
                            <Form.ErrorList errors={errors} />
                            <Button
                                icon={<Plus size={15} />}
                                disabled={fields.length >= 20}
                                onClick={() => add({ type: 8, typeId: null, number: 100 })}
                            >
                                添加奖励
                            </Button>
                        </>
                    )}
                </Form.List>
            </Form>
        </Modal>
    )
}
