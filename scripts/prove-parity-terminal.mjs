// Parity 6 — Terminal and PTY: shell run/poll/kill plus PTY open/resize/close.
const { termStart, termOutput, termGet, termKill, ptyOpen, ptyResize, ptyClose, ptyList } = await import("../apps/main/src/terminal.js");

const DIR = process.cwd();
const token = `yard-token-${Date.now().toString(36)}`;
const sh = await termStart(`echo ${token}`, DIR);
console.log(`start-ok: ${sh.id} status=${sh.status}`);
let out = "";
for (let i = 0; i < 20; i++) {
  const o = await termOutput(sh.id, DIR);
  if ((o.output ?? "").length > out.length) out = o.output;
  const cur = await termGet(sh.id, DIR);
  if (cur.status !== "running" && out.includes(token)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
if (!out.includes(token)) throw new Error(`output missing token (got ${JSON.stringify(out.slice(0, 120))})`);
console.log("output-ok: command output polled");
await termKill(sh.id, DIR);
console.log("kill-ok: shell removed");

const pty = await ptyOpen(DIR, "prove-yard");
if (!pty.ptyID && !pty.id) throw new Error("pty open returned no id");
const pid = pty.ptyID ?? pty.id;
console.log(`pty-ok: open ${String(pid).slice(0, 12)}`);
await ptyResize(pid, DIR, 24, 80);
console.log("pty-ok: resized 24x80");
await ptyClose(pid, DIR);
const rest = await ptyList(DIR);
if (JSON.stringify(rest).includes(String(pid))) throw new Error("pty still listed after close");
console.log("pty-ok: closed, gone from list");
console.log("terminal-ok");
process.exit(0);
