// Parse-checks every main-process module and script without running them.
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
console.log(`syntax ok: ${files.length} files`);
