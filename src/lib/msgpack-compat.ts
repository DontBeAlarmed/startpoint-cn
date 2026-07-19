/**
 * Rewrites uint32 values for the CN client decoder.
 * Values below 2^31 become int32; larger uint32 values become exact float64.
 */
export function fixUint32Tags(buf: Buffer): Buffer {
    const out = Buffer.allocUnsafe(buf.length * 2)
    let writePosition = 0

    const put = (byte: number) => { out[writePosition++] = byte }
    const copy = (offset: number, length: number) => {
        for (let index = 0; index < length; index++) out[writePosition++] = buf[offset + index]!
    }

    function walk(offset: number): number {
        const tag = buf[offset]!
        let position = offset + 1

        if (tag <= 0x7f || tag >= 0xe0) {
            put(tag)
            return position
        }

        switch (tag) {
            case 0xc0: case 0xc2: case 0xc3:
                put(tag)
                return position
            case 0xcc: case 0xd0:
                copy(offset, 2)
                return position + 1
            case 0xcd: case 0xd1:
                copy(offset, 3)
                return position + 2
            case 0xce: {
                const value = buf.readUint32BE(position)
                if (value < 0x80000000) {
                    put(0xd2)
                    copy(position, 4)
                } else {
                    put(0xcb)
                    const float = Buffer.allocUnsafe(8)
                    float.writeDoubleBE(value)
                    for (let index = 0; index < 8; index++) put(float[index]!)
                }
                return position + 4
            }
            case 0xd2:
                copy(offset, 5)
                return position + 4
            case 0xcf: case 0xd3:
                copy(offset, 9)
                return position + 8
            case 0xca:
                copy(offset, 5)
                return position + 4
            case 0xcb:
                copy(offset, 9)
                return position + 8
            case 0xd9: {
                const length = buf[position]!
                copy(offset, 2 + length)
                return position + 1 + length
            }
            case 0xda: {
                const length = buf.readUint16BE(position)
                copy(offset, 3 + length)
                return position + 2 + length
            }
            case 0xdb: {
                const length = buf.readUint32BE(position)
                copy(offset, 5 + length)
                return position + 4 + length
            }
            case 0xc4: {
                const length = buf[position]!
                copy(offset, 2 + length)
                return position + 1 + length
            }
            case 0xc5: {
                const length = buf.readUint16BE(position)
                copy(offset, 3 + length)
                return position + 2 + length
            }
            case 0xc6: {
                const length = buf.readUint32BE(position)
                copy(offset, 5 + length)
                return position + 4 + length
            }
            case 0xdc: {
                const count = buf.readUint16BE(position)
                put(tag)
                put(buf[offset + 1]!)
                put(buf[offset + 2]!)
                position += 2
                for (let index = 0; index < count; index++) position = walk(position)
                return position
            }
            case 0xdd: {
                const count = buf.readUint32BE(position)
                put(tag)
                copy(offset + 1, 4)
                position += 4
                for (let index = 0; index < count; index++) position = walk(position)
                return position
            }
            case 0xde: {
                const count = buf.readUint16BE(position)
                put(tag)
                put(buf[offset + 1]!)
                put(buf[offset + 2]!)
                position += 2
                for (let index = 0; index < count; index++) {
                    position = walk(position)
                    position = walk(position)
                }
                return position
            }
            case 0xdf: {
                const count = buf.readUint32BE(position)
                put(tag)
                copy(offset + 1, 4)
                position += 4
                for (let index = 0; index < count; index++) {
                    position = walk(position)
                    position = walk(position)
                }
                return position
            }
            case 0xc7: {
                const length = buf[position]!
                copy(offset, 3 + length)
                return position + 2 + length
            }
            case 0xc8: {
                const length = buf.readUint16BE(position)
                copy(offset, 4 + length)
                return position + 3 + length
            }
            case 0xc9: {
                const length = buf.readUint32BE(position)
                copy(offset, 6 + length)
                return position + 5 + length
            }
            case 0xd4: copy(offset, 2); return position + 1
            case 0xd5: copy(offset, 3); return position + 2
            case 0xd6: copy(offset, 5); return position + 4
            case 0xd7: copy(offset, 9); return position + 8
            case 0xd8: copy(offset, 17); return position + 16
            default: {
                if (tag >= 0xa0 && tag <= 0xbf) {
                    const length = tag & 0x1f
                    copy(offset, 1 + length)
                    return position + length
                }
                if (tag >= 0x90 && tag <= 0x9f) {
                    put(tag)
                    const count = tag & 0x0f
                    for (let index = 0; index < count; index++) position = walk(position)
                    return position
                }
                if (tag >= 0x80 && tag <= 0x8f) {
                    put(tag)
                    const count = tag & 0x0f
                    for (let index = 0; index < count; index++) {
                        position = walk(position)
                        position = walk(position)
                    }
                    return position
                }
                put(tag)
                return position
            }
        }
    }

    let position = 0
    while (position < buf.length) position = walk(position)
    return out.subarray(0, writePosition)
}
