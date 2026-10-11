// Brain fences are meant to be one line of their own: ```dispatch {...}```.
// Real model output also: puts the closing ``` on the next line, glues the
// fence to the end of a sentence ("On it.```dispatch {...}```"), closes it with
// one backtick, or not at all. Each of those silently dropped the task.
// normalizeFences finds every ```kind { ... } structurally (balanced JSON,
// string-aware), eats whatever closing backticks follow, and rewrites it as a
// canonical fence on its own line. Ordinary code blocks are left alone.
export const FENCE_KINDS = ["dispatch", "followup", "speak", "jarvis"];
const KINDS = FENCE_KINDS.join("|");
const OPENER = new RegExp(`\`\`\`(${KINDS})[ \\t]+(?=\\{)`, "g");
// A fence line however it is closed (```, `, or not yet).
export const OPEN_FENCE_LINE = new RegExp(`^\\s*\`\`\`(?:${KINDS})\\s+\\{.*\\}\\s*\`{0,3}\\s*$`);
export const CLOSED_FENCE_LINE = new RegExp(`^\\s*\`\`\`(?:${KINDS})\\s+\\{.*\\}\\s*\`\`\`\\s*$`);
export const CLOSE_FENCE_LINE = /^\s*`{1,3}\s*$/;

// Index just past the JSON object starting at `start` ("{"), or -1 if it
// never balances (still streaming, or malformed).
function jsonEnd(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

// Fences that share backticks ("```jarvis {a}```jarvis {b}```"): a kind name
// right after a fence's closing backticks opens the next fence.
const CHAINED = new RegExp(`^(${KINDS})[ \\t]+(?=\\{)`);

export function normalizeFences(text) {
  const src = String(text ?? "");
  let out = "";
  let last = 0;
  OPENER.lastIndex = 0;
  let m = OPENER.exec(src);
  while (m) {
    let kind = m[1];
    let jsonStart = m.index + m[0].length;
    out += src.slice(last, m.index);
    let next = null;
    for (;;) {
      const end = jsonEnd(src, jsonStart);
      if (end < 0) { out += src.slice(m.index, jsonStart); last = jsonStart; break; }
      let after = end;
      const close = src.slice(after).match(/^[ \t]*(\r?\n[ \t]*)?`{1,3}/);
      if (close) after += close[0].length;
      if (out && !out.endsWith("\n")) out = out.replace(/[ \t]+$/, "") + "\n";
      out += `\`\`\`${kind} ${src.slice(jsonStart, end)}\`\`\``;
      last = after;
      const chained = close ? src.slice(after).match(CHAINED) : null;
      if (chained) { kind = chained[1]; jsonStart = after + chained[0].length; out += "\n"; continue; }
      if (src.slice(after) && !src.slice(after).startsWith("\n")) out += "\n";
      break;
    }
    OPENER.lastIndex = last;
    next = OPENER.exec(src);
    m = next;
  }
  return out + src.slice(last);
}

// Streaming: a line that carries text and then a fence -> [text, fence].
const LINE_WITH_FENCE = new RegExp(`^(.*?\\S)[ \\t]*(\`\`\`(?:${KINDS})[ \\t]+\\{.*)$`);
export function splitInlineFence(line) {
  const m = String(line).match(LINE_WITH_FENCE);
  return m ? [m[1], m[2]] : [line, null];
}
