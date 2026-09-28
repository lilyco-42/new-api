export type EmbeddedTextAttachment = {
  name: string
  text: string
}

/** Extract the exact locally-read text payload stored in a user message. */
export function parseEmbeddedTextAttachment(
  value: string
): EmbeddedTextAttachment | null {
  const header = value.match(/^\[Attached (PDF|file): ([^\]\r\n]+)\]\r?\n/)
  if (!header) return null

  const endMarker = `\n[End attached ${header[1]}]`
  const endIndex = value.lastIndexOf(endMarker)
  if (endIndex < header[0].length) {
    if (header[1] !== 'PDF') return null
    return {
      name: header[2],
      text: value.slice(header[0].length),
    }
  }

  return {
    name: header[2],
    text: value.slice(header[0].length, endIndex),
  }
}
