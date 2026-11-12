/** VS Code / Cursor `.code-workspace` files are JSON with comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        out.push(char);
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      out.push(char);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out.push(char);
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }

    if (char === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) {
        j++;
      }
      const afterComma = text[j];
      if (afterComma === "}" || afterComma === "]") {
        continue;
      }
    }

    out.push(char);
  }

  return JSON.parse(out.join(""));
}
