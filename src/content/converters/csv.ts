export type CsvErrorFactory = (reason: string) => never

function invalidCsv(reason: string): never {
    throw new Error(`invalid CSV content: ${reason}`)
}

export function parseCsvLine(
    text: string,
    subject: string,
    invalid: CsvErrorFactory = invalidCsv,
): string[] {
    const fields: string[] = []
    let field = ""
    let state: "start" | "unquoted" | "quoted" | "after-quote" = "start"

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]
        if (state === "start") {
            if (character === "\r" || character === "\n") {
                invalid(`${subject} must be a single CSV line outside quoted fields`)
            }
            if (character === ",") fields.push("")
            else if (character === '"') state = "quoted"
            else {
                field = character
                state = "unquoted"
            }
            continue
        }
        if (state === "unquoted") {
            if (character === "\r" || character === "\n") {
                invalid(`${subject} must be a single CSV line outside quoted fields`)
            }
            if (character === ",") {
                fields.push(field)
                field = ""
                state = "start"
            } else if (character === '"') {
                invalid(`${subject} has an illegal quote`)
            } else {
                field += character
            }
            continue
        }
        if (state === "quoted") {
            if (character !== '"') {
                field += character
            } else if (text[index + 1] === '"') {
                field += '"'
                index += 1
            } else {
                state = "after-quote"
            }
            continue
        }
        if (character === "\r" || character === "\n") {
            invalid(`${subject} must be a single CSV line outside quoted fields`)
        }
        if (character !== ",") {
            invalid(`${subject} has data after a closing quote`)
        }
        fields.push(field)
        field = ""
        state = "start"
    }

    if (state === "quoted") invalid(`${subject} has an unclosed quote`)
    fields.push(field)
    return fields
}
