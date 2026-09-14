import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src", "runtime");
const ENGINE = path.join(ROOT, "public", "engine");

const compiled = new Set();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs);
    else if (e.name.endsWith(".ts")) {
      const rel = path.relative(SRC, abs).replace(/\.ts$/, ".mjs").split(path.sep).join("/");
      compiled.add(rel);
    }
  }
})(SRC);

const issues = [];
for (const rel of compiled) {
  const file = path.join(ENGINE, rel);
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("// AUTO-GENERATED")) issues.push(`${rel}: missing banner`);
  if (/from\s+["']three(?:\/webgpu)?["']/.test(text)) issues.push(`${rel}: bare three`);
  if (text.includes("import.meta.url")) issues.push(`${rel}: import.meta.url`);
  for (const line of text.split("\n")) {
    const m = line.match(/from\s+["']([^"']+)["']/);
    if (m && !m[1].startsWith(".") && !m[1].startsWith("http") && m[1] !== "three" && m[1] !== "three/webgpu") {
      issues.push(`${rel}: bare specifier ${m[1]}`);
    }
  }
}

console.log(`Compiled products: ${compiled.size}`);
if (issues.length === 0) console.log("All checks passed");
else {
  console.log(`Issues (${issues.length}):`);
  for (const i of issues) console.log(`  ${i}`);
}