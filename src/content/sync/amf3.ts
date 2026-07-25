import { inflateSync } from "node:zlib"

class Amf3Reader {
    private offset = 0
    private readonly strings: unknown[] = []
    private readonly objects: unknown[] = []
    private readonly traits: {
        readonly dynamic: boolean
        readonly properties: readonly string[]
    }[] = []

    constructor(private readonly bytes: Buffer) {}

    private byte(): number {
        if (this.offset >= this.bytes.length) throw new Error("AMF3 input ended unexpectedly")
        return this.bytes[this.offset++]
    }

    private u29(): number {
        let value = 0
        for (let index = 0; index < 3; index += 1) {
            const byte = this.byte()
            value = value * 128 + (byte & 0x7f)
            if ((byte & 0x80) === 0) return value
        }
        return value * 256 + this.byte()
    }

    private string(): string {
        const header = this.u29()
        if ((header & 1) === 0) {
            const value = this.strings[header >> 1]
            if (typeof value !== "string") throw new Error("invalid AMF3 string reference")
            return value
        }
        const length = header >> 1
        if (this.offset + length > this.bytes.length) throw new Error("invalid AMF3 string length")
        const value = this.bytes.toString("utf8", this.offset, this.offset + length)
        this.offset += length
        if (length > 0) this.strings.push(value)
        return value
    }

    private array(): unknown {
        const header = this.u29()
        if ((header & 1) === 0) {
            const value = this.objects[header >> 1]
            if (!Array.isArray(value)) throw new Error("invalid AMF3 array reference")
            return value
        }
        const length = header >> 1
        const associative: Record<string, unknown> = {}
        while (true) {
            const key = this.string()
            if (key === "") break
            associative[key] = this.value()
        }
        const dense = Array.from({ length }, () => this.value())
        const result = Object.keys(associative).length === 0 ? dense : { ...associative, dense }
        this.objects.push(result)
        return result
    }

    private object(): unknown {
        const header = this.u29()
        if ((header & 1) === 0) return this.objects[header >> 1]
        const traitHeader = header >> 1
        let dynamic: boolean
        let properties: readonly string[]
        if ((traitHeader & 1) === 0) {
            const trait = this.traits[traitHeader >> 1]
            if (!trait) throw new Error("invalid AMF3 trait reference")
            dynamic = trait.dynamic
            properties = trait.properties
        } else {
            const externalizable = (traitHeader & 2) !== 0
            dynamic = (traitHeader & 4) !== 0
            const propertyCount = traitHeader >> 3
            this.string() // class name
            properties = Array.from({ length: propertyCount }, () => this.string())
            if (externalizable) throw new Error("externalizable AMF3 objects are unsupported")
            this.traits.push({ dynamic, properties })
        }
        const result: Record<string, unknown> = {}
        this.objects.push(result)
        for (const property of properties) result[property] = this.value()
        if (dynamic) {
            while (true) {
                const key = this.string()
                if (key === "") break
                result[key] = this.value()
            }
        }
        return result
    }

    value(): unknown {
        switch (this.byte()) {
            case 0x00: return undefined
            case 0x01: return null
            case 0x02: return false
            case 0x03: return true
            case 0x04: return this.u29()
            case 0x05: {
                if (this.offset + 8 > this.bytes.length) throw new Error("invalid AMF3 double")
                const value = this.bytes.readDoubleBE(this.offset)
                this.offset += 8
                return value
            }
            case 0x06: return this.string()
            case 0x09: return this.array()
            case 0x0a: return this.object()
            default: throw new Error("unsupported AMF3 marker")
        }
    }

    finish(): unknown {
        const value = this.value()
        if (this.offset !== this.bytes.length) throw new Error("AMF3 input has trailing bytes")
        return value
    }
}

export function decodeAmf3(bytes: Buffer): unknown {
    return new Amf3Reader(bytes).finish()
}

export function decodeAmf3Deflate(bytes: Buffer): unknown {
    return decodeAmf3(inflateSync(bytes))
}
