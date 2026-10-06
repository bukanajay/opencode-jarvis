// PTY live frames: open -> stream replay+meta -> write stdin -> read echo ->
// resize -> detach/close with no leaked sockets. Headless: terminal.js owns
// the websocket (global WebSocket), same exports the Electron main process uses.
import {
  ptyOpen, ptyAttach, ptyWrite, ptyResize, ptyClose, ptyDetach, ptyList, ptyAttached,
} from "../apps/main/src/terminal.js";

const DIR = process.cwd();
const token = `live-token-${Date.now().toString(36)}`;
let chunks = "";
let meta = null;
let streamCursor = null;
let closed = null;

const info = await ptyOpen(DIR, "prove-live");
const ptyID = info.id ?? info.ptyID;
if (!ptyID) throw new Error("pty open returned no id");
console.log(`open-ok: ${String(ptyID).slice(0, 12)}`);

await ptyAttach(ptyID, DIR, {
  onChunk: ({ chunk, cursor }) => { chunks += chunk; streamCursor = cursor; },
  onMeta: ({ cursor }) => { meta = cursor; },
  onClose: (e) => { closed = e; },
});
console.log("attach-ok: websocket open");
if (ptyAttached().length !== 1) throw new Error("expected exactly one attached socket");

await new Promise((r) => setTimeout(r, 1500));
if (meta == null || typeof meta !== "number") throw new Error(`no meta cursor frame (got ${meta})`);
console.log(`meta-ok: cursor=${meta}`);

await ptyWrite(ptyID, `echo ${token}\n`);
let found = false;
for (let i = 0; i < 20; i++) {
  if (chunks.includes(token)) { found = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!found) throw new Error(`live echo missing token (saw ${chunks.length} chars)`);
if (streamCursor == null || streamCursor <= meta) throw new Error("live output did not advance the cursor");
console.log("stream-ok: stdin in, live frame out");

await ptyResize(ptyID, DIR, 30, 100);
console.log("resize-ok: 30x100 mid-stream");

// Fresh ticket per connection: live output advances the cursor without replaying it.
await new Promise((r) => setTimeout(r, 500));
chunks = "";
const cursorAtReattach = streamCursor;
let reattachMeta = null;
await ptyAttach(ptyID, DIR, {
  onChunk: ({ chunk }) => { chunks += chunk; },
  onMeta: ({ cursor }) => { reattachMeta = cursor; },
  onClose: (e) => { closed = e; },
});
await new Promise((r) => setTimeout(r, 1000));
if (ptyAttached().length !== 1) throw new Error("reattach leaked a socket");
if (closed) throw new Error("reattach reported the replaced socket as a PTY exit");
if (chunks.includes(token)) throw new Error("reattach replayed output already seen before disconnect");
if (reattachMeta !== cursorAtReattach) throw new Error(`cursor mismatch: ${reattachMeta} != ${cursorAtReattach}`);
console.log("reattach-ok: fresh ticket, single socket");

await ptyClose(ptyID, DIR);
if (ptyAttached().length !== 0) throw new Error("close leaked a socket");
if (closed) throw new Error("intentional close reported a PTY exit");
const rest = await ptyList(DIR);
if (JSON.stringify(rest).includes(String(ptyID))) throw new Error("pty still listed after close");
console.log("close-ok: detached, removed, gone from list");
console.log("pty-live-ok");
process.exit(0);
