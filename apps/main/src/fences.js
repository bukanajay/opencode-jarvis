// Brain fences are meant to be one line: ```dispatch {...}```. Models often
// put the closing ``` on the next line instead, which silently dropped the
// task. Normalize that shape to one line before anything parses or strips it.
export const FENCE_KINDS = ["dispatch", "followup", "speak", "jarvis"];
const KINDS = FENCE_KINDS.join("|");
const SPLIT_FENCE = new RegExp(`^([ \\t]*\`\`\`(?:${KINDS})[ \\t]+\\{.*\\})[ \\t]*\\r?\\n[ \\t]*\`\`\`[ \\t]*$`, "gm");
export const OPEN_FENCE_LINE = new RegExp(`^\\s*\`\`\`(?:${KINDS})\\s+\\{.*\\}\\s*$`);
export const CLOSE_FENCE_LINE = /^\s*```\s*$/;

export function normalizeFences(text) {
  return String(text ?? "").replace(SPLIT_FENCE, "$1```");
}
