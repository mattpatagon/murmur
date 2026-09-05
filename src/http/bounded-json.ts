const MAXIMUM_JSON_DEPTH: number = 32;
const MAXIMUM_JSON_STRUCTURAL_UNITS: number = 16_384;

export function parseBoundedJsonText(text: string): unknown {
  let depth: number = 0;
  let structuralUnits: number = 1;
  let inString: boolean = false;
  let escaped: boolean = false;
  for (let index: number = 0; index < text.length; index += 1) {
    const character: string | undefined = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[" || character === "{") {
      depth += 1;
      structuralUnits += 1;
    } else if (character === "]" || character === "}") depth -= 1;
    else if (character === "," || character === ":") structuralUnits += 1;
    if (
      depth < 0 ||
      depth > MAXIMUM_JSON_DEPTH ||
      structuralUnits > MAXIMUM_JSON_STRUCTURAL_UNITS
    ) {
      throw new Error("Request JSON exceeds its structural limits");
    }
  }
  // For valid JSON, punctuation units bound values plus object keys, including empty
  // containers. Keep grammar validation native, but never build an excessive tree first.
  return JSON.parse(text);
}
