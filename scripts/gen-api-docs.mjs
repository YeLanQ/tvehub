// SDK API 参考文档生成器：src/framework/scripting/tve.d.ts（类型契约唯一
// 事实源）→ public/docs/sdk/api.md（全量 API 参考，勿手改）。
//
// 用法：pnpm gen:api-docs
//
// tve.d.ts 变更后重跑本脚本即可同步文档；教程页（sdk/*.md 其余文件）仍为
// 手写内容，本脚本不触碰。

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractModel } from "./api-docs/extract.mjs";
import { renderModel } from "./api-docs/render.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "framework", "scripting", "tve.d.ts");
const target = path.join(root, "public", "docs", "sdk", "api.md");

const model = extractModel(source);
const declCount = model.sections.reduce((n, s) => n + s.decls.length, 0);
const body = renderModel(model);

const page = [
  "<!-- 由 scripts/gen-api-docs.mjs 自动生成，来源 src/framework/scripting/tve.d.ts，请勿手改。 -->",
  "",
  "# tve SDK API 参考",
  "",
  "<!-- 生成物说明：本页是类型契约的全量参考；入门与专题讲解见 SDK 总览等手写文档。 -->",
  "",
  body,
].join("\n");

writeFileSync(target, page);
console.log(`✓ public/docs/sdk/api.md 生成完成（${model.sections.length} 个分节 / ${declCount} 个声明）`);
