// ---------------------------------------------------------------------------
// 技能文档漂移校验（自演化系统的检测网）：
// 校验 .agents/skills/** 的结构与文档里引用的仓库路径是否仍然成立——
//   1. SKILL.md frontmatter：name 必须与目录同名、description 非空；
//   2. 行数预算：>200 行告警、>260 行失败（项目"避免大文件"口径）；
//   3. 路径引用：文档中的 src/ scripts/ tests/ 路径必须存在（缺失 = 失败，
//      但 *.spec.ts 视为"推荐补测的示范文件"只告警）；
//   4. 行号引用：path:line 的 line 超出文件总行数 = 引用失效（失败）。
// 用法：node scripts/check-skills.mjs [--strict]（--strict 把告警也当失败）
// 门禁：pnpm skills:check；本地 CI（scripts/ci-local.mjs）第一步。
// 设计原则：宁可漏报不可误报——裸文件名（无 src/ 等前缀）与 public/engine
// 构建产物不校验；public/docs|repos|web-preview 为入库子树/文件，缺失降级告警。
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(ROOT, ".agents", "skills");
const strict = process.argv.includes("--strict");

const failures = [];
const warnings = [];
let filesChecked = 0;
let citationsChecked = 0;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".md")) out.push(p);
  }
  return out;
}

function fail(file, msg) { failures.push(`${relative(ROOT, file)} — ${msg}`); }
function warn(file, msg) { warnings.push(`${relative(ROOT, file)} — ${msg}`); }

/** 校验一条 path[:line] 引用；返回是否为可校验的仓库路径 */
function checkCitation(file, raw, lineStr) {
  const line = lineStr ? Number(lineStr) : null;
  const abs = join(ROOT, raw);
  const inRepo = existsSync(abs);
  const isSpec = raw.endsWith(".spec.ts");
  const publicOk =
    raw.startsWith("public/docs/") ||
    raw.startsWith("public/repos/") ||
    raw.startsWith("public/web-preview/");
  const skip = raw.startsWith("public/engine/") || raw.startsWith("public/exports/");

  if (skip) return false;
  citationsChecked += 1;

  if (!inRepo) {
    if (isSpec || publicOk || raw.startsWith("public/")) {
      warn(file, `引用路径当前不存在（可接受）：${raw}`);
    } else {
      fail(file, `引用路径不存在：${raw}`);
    }
    return true;
  }
  if (line != null) {
    const total = readFileSync(abs, "utf8").split("\n").length;
    if (line > total) fail(file, `行号引用失效：${raw}:${line}（文件仅 ${total} 行）`);
  }
  return true;
}

const PATH_RE =
  /(?:^|[\s(`'"，。（])((?:src|scripts|tests|public)\/[A-Za-z0-9_\-./]+\.(?:ts|tsx|vue|mjs|js|json|md|scss))(?::(\d+))?/g;

const mdFiles = existsSync(SKILLS_DIR) ? walk(SKILLS_DIR) : [];
if (mdFiles.length === 0) fail(SKILLS_DIR, "未找到任何技能文档（.agents/skills 为空？）");

for (const file of mdFiles) {
  filesChecked += 1;
  const rel = relative(ROOT, file);
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n").length;
  const dirName = basenameOf(dirname(file));

  // 行数预算（软上限 200 硬上限 260，见文件头注释）
  if (lines > 260) fail(file, `行数 ${lines} 超过硬上限 260（拆分单元）`);
  else if (lines > 200) warn(file, `行数 ${lines} 超过软上限 200（考虑拆分）`);

  if (basenameOf(file) === "SKILL.md") {
    const fm = /^---\n([\s\S]*?)\n---/.exec(content);
    if (!fm) { fail(file, "缺少 frontmatter（--- name/description ---）"); continue; }
    const name = /^name:\s*(\S+)/m.exec(fm[1])?.[1];
    if (!name) fail(file, "frontmatter 缺少 name");
    else if (name !== dirName) fail(file, `name "${name}" 与目录名 "${dirName}" 不一致`);
    const desc = /^description:\s*(.+)$/m.exec(fm[1])?.[1];
    if (!desc || desc.trim().length < 10) fail(file, "description 缺失或过短（触发信号要写清楚）");
  }

  // 代码围栏内的路径是示例代码，不作存在性校验：先摘除非围栏正文
  const body = content.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
  for (const m of body.matchAll(PATH_RE)) checkCitation(file, m[1], m[2]);
}

function basenameOf(p) { return p.split(/[\\/]/).pop() ?? p; }

if (warnings.length) {
  console.log(`\n⚠ 告警 ${warnings.length} 条：`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}
if (failures.length) {
  console.error(`\n✗ 失败 ${failures.length} 条：`);
  for (const f of failures) console.error(`  ✗ ${f}`);
}
const verdict = failures.length === 0 && !(strict && warnings.length) ? "通过" : "未通过";
console.log(
  `\n结果：技能校验${verdict} — 文档 ${filesChecked} 份，路径引用 ${citationsChecked} 条，` +
  `失败 ${failures.length}，告警 ${warnings.length}${strict ? "（strict：告警计入失败）" : ""}`,
);
process.exit(failures.length === 0 && !(strict && warnings.length) ? 0 : 1);
