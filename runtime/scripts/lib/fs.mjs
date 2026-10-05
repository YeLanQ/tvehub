// 构建脚本公共文件写入（唯一定义处）：内容一致跳过——dev watcher 防抖的
// 基元（重复构建不更新 mtime，不触发 chokidar add/change 与产物清单重扫）。
import fs from "node:fs";
import path from "node:path";

/** 变更检测写入：内容一致跳过（幂等）；返回是否写入 */
export function writeIfChanged(dest, content) {
  const next = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (fs.existsSync(dest) && fs.readFileSync(dest).equals(next)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, next);
  return true;
}
