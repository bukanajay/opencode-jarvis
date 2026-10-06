// Parse-checks every main-process module, script and the deck's inline JS
// without running them.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const roots = ["apps/main/src", "scripts", "tests"];
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(m?js|cjs)$/.test(e.name)) files.push(p);
  }
};
roots.filter((r) => fs.existsSync(r)).forEach(walk);
for (const f of files) execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
// Deck is one HTML file; parse its inline scripts the same way.
const html = fs.readFileSync("apps/deck/index.html", "utf8");
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
for (const src of inline) new Function(src);
console.log(`syntax ok: ${files.length} files + ${inline.length} deck script(s)`);
