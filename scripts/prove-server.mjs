import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

const WANTED = process.env.JARVIS_MODEL ?? "opencode-go/gpt-6-luna";
const FALLBACK = "opencode/fledge-alpha-free";
const PROMPT = process.argv[2] ?? "Reply with exactly: loop-ok";

function ref(s) {
  const i = s.indexOf("/");
  return { providerID: s.slice(0, i), id: s.slice(i + 1) };
}

const endpoint = await Service.ensure();
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const info = await client.server.info();
console.log(`server=${info.version ?? "ok"} url=${endpoint.url}`);

async function runOnce(modelRef) {
  const session = await client.session.create({
    agent: "build",
    model: ref(modelRef),
    location: { directory: process.cwd() },
  });
  let full = "";
  const sub = client.event.subscribe();
  const outcome = await new Promise(async (resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 60000);
    (async () => {
      for await (const ev of sub) {
        const d = ev.data ?? {};
        if (d.sessionID !== session.id) continue;
        if (ev.type === "session.text.delta" && d.delta) {
          full += typeof d.delta === "string" ? d.delta : d.delta.text ?? "";
        }
        if (ev.type === "session.execution.succeeded") {
          clearTimeout(timer);
          resolve("ok");
          break;
        }
        if (ev.type === "session.execution.failed") {
          clearTimeout(timer);
          resolve(`failed:${JSON.stringify(d.error).slice(0, 300)}`);
          break;
        }
      }
    })();
    await client.session.prompt({ sessionID: session.id, text: PROMPT });
  });
  if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
  return { sessionID: session.id, outcome, full };
}

let r = await runOnce(WANTED);
let used = WANTED;
if (r.outcome.startsWith("failed") && WANTED !== FALLBACK) {
  console.log(`wanted ${WANTED} ${r.outcome}, retrying on ${FALLBACK}`);
  r = await runOnce(FALLBACK);
  used = FALLBACK;
}
console.log(`session=${r.sessionID} model=${used} status=${r.outcome}`);
console.log("--- reply ---");
console.log(r.full || "(no text deltas)");
console.log(r.outcome === "ok" ? "loop-ok" : "loop-failed");
process.exit(r.outcome === "ok" ? 0 : 1);
