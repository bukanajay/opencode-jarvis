// Parse-checks every main-process module, script and the deck's inline JS
// without running them, then checks named relative imports resolve.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
// Named relative imports must exist in their target module. main.js cannot be
// imported without the Electron binary, so check it statically this way.
let missing = 0;
for (const f of files.filter((f) => f.startsWith(path.join("apps", "main", "src")))) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.[^"]+)"/g)) {
    const mod = await import(pathToFileURL(path.resolve(path.dirname(f), m[2])).href);
    for (const name of m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      if (!(name in mod)) { console.error(`${f}: ${name} is not exported by ${m[2]}`); missing++; }
    }
  }
}
if (missing) process.exit(1);
console.log(`syntax ok: ${files.length} files + ${inline.length} deck script(s); imports resolve`);
process.exit(0);
