/**
 * Rewrites uint32 values for the CN client decoder.
 * Values below 2^31 become int32; larger uint32 values become exact float64.
 *
 * Two-phase rewrite: a structural scan records only the 0xce tag offsets, then
 * one exact-size output buffer is assembled with bulk Buffer.copy spans between
 * rewrite sites. Buffers without any uint32 tag are returned as-is.
 */
interface Uint32RewriteSite {
    tagOffset: number
    widenToFloat64: boolean
}

export function fixUint32Tags(buf: Buffer): Buffer {
    // Without any 0xce byte in the buffer the structural walk cannot find a
    // rewrite site, so the wire form is already client-compatible.
    if (buf.length === 0 || !buf.includes(0xce)) return buf

    const sites: Uint32RewriteSite[] = []

    function walk(offset: number): number {
        const tag = buf[offset]!
        let position = offset + 1

        if (tag <= 0x7f || tag >= 0xe0) return position

        switch (tag) {
            case 0xc0: case 0xc2: case 0xc3:
                return position
            case 0xcc: case 0xd0:
                return position + 1
            case 0xcd: case 0xd1:
                return position + 2
            case 0xce: {
                const value = buf.readUint32BE(position)
                sites.push({ tagOffset: offset, widenToFloat64: value >= 0x80000000 })
                return position + 4
            }
            case 0xd2:
                return position + 4
            case 0xcf: case 0xd3:
                return position + 8
            case 0xca:
                return position + 4
            case 0xcb:
                return position + 8
            case 0xd9: {
                const length = buf[position]!
                return position + 1 + length
            }
            case 0xda: {
                const length = buf.readUint16BE(position)
                return position + 2 + length
            }
            case 0xdb: {
                const length = buf.readUint32BE(position)
                return position + 4 + length
            }
            case 0xc4: {
                const length = buf[position]!
                return position + 1 + length
            }
            case 0xc5: {
                const length = buf.readUint16BE(position)
                return position + 2 + length
            }
            case 0xc6: {
                const length = buf.readUint32BE(position)
                return position + 4 + length
            }
            case 0xdc: {
                const count = buf.readUint16BE(position)
                position += 2
                for (let index = 0; index < count; index++) position = walk(position)
                return position
            }
            case 0xdd: {
                const count = buf.readUint32BE(position)
                position += 4
                for (let index = 0; index < count; index++) position = walk(position)
                return position
            }
            case 0xde: {
                const count = buf.readUint16BE(position)
                position += 2
                for (let index = 0; index < count; index++) {
                    position = walk(position)
                    position = walk(position)
                }
                return position
            }
            case 0xdf: {
                const count = buf.readUint32BE(position)
                position += 4
                for (let index = 0; index < count; index++) {
                    position = walk(position)
                    position = walk(position)
                }
                return position
            }
            case 0xc7: {
                const length = buf[position]!
                return position + 2 + length
            }
            case 0xc8: {
                const length = buf.readUint16BE(position)
                return position + 3 + length
            }
            case 0xc9: {
                const length = buf.readUint32BE(position)
                return position + 5 + length
            }
            // fixext includes a one-byte extension type before its fixed payload.
            case 0xd4: return position + 2
            case 0xd5: return position + 3
            case 0xd6: return position + 5
            case 0xd7: return position + 9
            case 0xd8: return position + 17
            default: {
                if (tag >= 0xa0 && tag <= 0xbf) return position + (tag & 0x1f)
                if (tag >= 0x90 && tag <= 0x9f) {
                    const count = tag & 0x0f
                    for (let index = 0; index < count; index++) position = walk(position)
                    return position
                }
                if (tag >= 0x80 && tag <= 0x8f) {
                    const count = tag & 0x0f
                    for (let index = 0; index < count; index++) {
                        position = walk(position)
                        position = walk(position)
                    }
                    return position
                }
                return position
            }
        }
    }

    let position = 0
    while (position < buf.length) position = walk(position)
    if (sites.length === 0) return buf

    const widenedCount = sites.reduce((sum, site) => sum + (site.widenToFloat64 ? 1 : 0), 0)
    if (widenedCount === 0) {
        // Every uint32 fits int32: the rewrite is a 1-byte tag flip per site with
        // the 4-byte payload kept verbatim, so one bulk copy plus in-place flips.
        const out = Buffer.from(buf)
        for (const site of sites) out[site.tagOffset] = 0xd2
        return out
    }

    const out = Buffer.allocUnsafe(buf.length + 4 * widenedCount)
    let writePosition = 0
    let cursor = 0
    for (const site of sites) {
        writePosition += buf.copy(out, writePosition, cursor, site.tagOffset)
        if (site.widenToFloat64) {
            out[writePosition++] = 0xcb
            out.writeDoubleBE(buf.readUint32BE(site.tagOffset + 1), writePosition)
            writePosition += 8
        } else {
            out[writePosition++] = 0xd2
            writePosition += buf.copy(out, writePosition, site.tagOffset + 1, site.tagOffset + 5)
        }
        cursor = site.tagOffset + 5
    }
    writePosition += buf.copy(out, writePosition, cursor, buf.length)
    return out
}
