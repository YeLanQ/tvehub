//! 多文件产物组装：config.json 落盘（player 入口）、附带零依赖静态服务器与
//! README（引导走 HTTP 而非 file://）；gzip 模式打 assets.gzip 归档；Three CDN
//! 模式把运行时脚本里解析到同源 three 的相对 import 重写为 CDN 绝对 URL。

use std::collections::HashMap;

use super::archive::build_archive_bytes;
use super::classify::{is_entry_page, is_runtime_code};
use super::specifiers::rewrite_specifier_text;
use super::urls::three_cdn_remap;

/// 多文件产物附带的零依赖静态服务器脚本（node server.mjs [端口]）。
/// 引导用户走 HTTP 而非 file://（fetch/Worker 在 file:// 下受限）。
const SERVER_MJS: &str = r#"import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2]) || 8080;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const MIME = {
  ".html":"text/html;charset=utf-8",".js":"text/javascript",".mjs":"text/javascript",
  ".css":"text/css",".json":"application/json",".png":"image/png",".jpg":"image/jpeg",
  ".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif",".svg":"image/svg+xml",
  ".glb":"model/gltf-binary",".gltf":"model/gltf+json",".wasm":"application/wasm",
  ".bin":"application/octet-stream",".mp3":"audio/mpeg",".wav":"audio/wav",
  ".ogg":"audio/ogg",".shader":"text/plain",".mat":"application/json",".anim":"application/json",
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let p = decodeURIComponent(url.pathname);
    if (p === "/") p = "/index.html";
    const safe = normalize(join(ROOT, p));
    if (!safe.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
    const s = await stat(safe).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404); res.end("Not Found"); return; }
    const data = await readFile(safe);
    const mime = MIME[extname(safe).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Content-Length": data.length });
    res.end(data);
  } catch (e) { res.writeHead(500); res.end(String(e?.message ?? e)); }
});
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`静态服务器已启动: ${url}\n按 Ctrl+C 停止`);
  import("node:child_process").then(({ exec }) => {
    const cmd = process.platform === "win32" ? `start ${url}` : process.platform === "darwin" ? `open ${url}` : `xdg-open ${url}`;
    exec(cmd);
  });
});
"#;

/// 运行时脚本里指向 three 的相对 import 重写为 CDN 绝对 URL（import map 拦截不了
/// 相对说明符，必须改写模块文本）。覆盖 player.mjs 与 engine/ 下全部 .js/.mjs
/// （loaders 的 ../../three、runtime 模块的 ../core/three、player 的 ../engine/core/three 统一经
/// 目录相对解析命中映射）；入口页与非脚本文件不动
fn rewrite_runtime_three_imports(files: &mut HashMap<String, String>, remap: &HashMap<String, String>) {
    let rels: Vec<String> = files
        .keys()
        .filter(|rel| {
            is_runtime_code(rel)
                && !is_entry_page(rel)
                && (rel.ends_with(".js") || rel.ends_with(".mjs"))
        })
        .cloned()
        .collect();
    for rel in rels {
        let dir = match rel.rfind('/') {
            Some(i) => &rel[..=i],
            None => "",
        };
        let text = files.get_mut(&rel).unwrap();
        *text = rewrite_specifier_text(text, dir, remap);
    }
}

/// 多文件组装：config.json 落盘、附带零依赖静态服务器与说明；gzip 模式把
/// 场景/资产打进 assets.gzip（运行时经 fetch 拦截读取）；Three CDN 模式改写
/// 运行时 three import 为 CDN 绝对 URL（import map 拦截不了相对说明符）。
pub(super) fn assemble_multi_file(
    files: &mut HashMap<String, String>,
    binaries: &mut HashMap<String, Vec<u8>>,
    entries: &[(String, Vec<u8>)],
    cfg: serde_json::Map<String, serde_json::Value>,
    three_base: &str,
    cdn_active: bool,
    gzip: bool,
) -> Result<(), String> {
    files.insert(
        "config.json".to_string(),
        serde_json::Value::Object(cfg).to_string(),
    );
    files.insert("server.mjs".to_string(), SERVER_MJS.to_string());
    files.insert(
        "README.txt".to_string(),
        "网页预览产物\n\n运行方式（推荐）：\n  node server.mjs        # 启动本地 HTTP 服务器（默认 8080 端口）\n  node server.mjs 3000   # 指定端口\n\n然后浏览器访问 http://localhost:8080\n\n注意：请勿直接双击 index.html 打开（file:// 协议下\nfetch/Worker 受限，物理和动画将回退主线程，性能下降）。\n".to_string(),
    );
    if gzip {
        // 多文件 gzip：场景/资产在 assets.gzip 归档中，运行时经 fetch 拦截读取
        let pak = build_archive_bytes(entries)?;
        binaries.insert("assets.gzip".to_string(), pak);
    }
    if cdn_active {
        rewrite_runtime_three_imports(files, &three_cdn_remap(three_base));
    }
    Ok(())
}
