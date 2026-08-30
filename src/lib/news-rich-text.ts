const CONTAINER_TAGS = new Set([
    "p", "div", "h1", "h2", "h3", "ul", "ol", "li",
    "table", "tr", "th", "td",
])
const VOID_TAGS = new Set(["br", "hr"])
const FORBIDDEN_MARKERS = [
    "http://",
    "https://",
    "www.",
    "scene/",
    "dialog/",
    "::associate_token::",
] as const

function parseTag(source: string, opening: number): { end: number; raw: string } {
    for (let index = opening + 1; index < source.length; index++) {
        if (source[index] === ">") {
            return { end: index + 1, raw: source.slice(opening + 1, index) }
        }
    }
    throw new TypeError("News RichText contains an unclosed tag")
}

function tagName(raw: string, selfClosing: boolean): string {
    const name = selfClosing ? raw.slice(0, -1) : raw
    if (!/^[a-z]+$/.test(name)) {
        throw new TypeError("News RichText contains an invalid tag or attribute")
    }
    return name
}

export function validateNewsRichText(source: string): string {
    if (typeof source !== "string" || source.length < 1 || source.length > 20000) {
        throw new TypeError("News RichText must be a string of 1 through 20000 UTF-16 units")
    }
    if (FORBIDDEN_MARKERS.some(marker => source.includes(marker))) {
        throw new TypeError("News RichText contains forbidden content")
    }

    const openTags: string[] = []
    let cursor = 0
    while (cursor < source.length) {
        const opening = source.indexOf("<", cursor)
        if (opening < 0) break

        const tag = parseTag(source, opening)
        const raw = tag.raw
        if (raw.startsWith("/")) {
            if (!/^[a-z]+$/.test(raw.slice(1))) {
                throw new TypeError("News RichText contains an invalid closing tag")
            }
            const name = raw.slice(1)
            if (!CONTAINER_TAGS.has(name) || openTags.pop() !== name) {
                throw new TypeError("News RichText has invalid tag nesting")
            }
        } else {
            const selfClosing = raw.endsWith("/")
            const name = tagName(raw, selfClosing)
            if (CONTAINER_TAGS.has(name)) {
                if (selfClosing) {
                    throw new TypeError("News RichText container tags must not self-close")
                }
                openTags.push(name)
            } else if (VOID_TAGS.has(name)) {
                if (!selfClosing && raw !== name) {
                    throw new TypeError("News RichText void tags must not have attributes")
                }
            } else {
                throw new TypeError("News RichText contains an unknown tag")
            }
        }
        cursor = tag.end
    }

    if (openTags.length > 0) {
        throw new TypeError("News RichText has an unclosed tag")
    }
    return source
}
