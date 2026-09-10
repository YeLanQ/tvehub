//! 网页预览（内嵌 iframe 用）：
//! - `export_web_preview`：把前端上传的网页运行产物（index.html / player / three /
//!   scene.json / config.json）写入 `<root>/.tmp/web-preview`，并在本机 127.0.0.1 上
//!   起（或复用）一个极简静态文件服务器，返回可内嵌的 base URL；
//! - `stop_web_preview`：停止该服务器并释放端口。
//!
//! 服务器只做最小静态文件服务（GET，无目录列表/无 Keep-Alive/无压缩），
//! 全部用 std 实现，不引入第三方依赖；路径守卫防止越界读取。

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Tauri managed：当前网页预览服务器（同一时刻只服务一个项目）
#[derive(Default)]
pub struct PreviewServerState {
    inner: Mutex<Option<PreviewServer>>,
}

struct PreviewServer {
    root: PathBuf,
    base_url: String,
    shutdown: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

/// 预览服务器固定端口：避免每次重启端口漂移导致外部引用（书签/控制端抓取）失效。
/// 被占用（其他进程或旧实例未退净）时回退随机端口，保证功能可用。
const PREVIEW_FIXED_PORT: u16 = 39110;

/// 清空并重建导出目录，写入文本与二进制产物（路径守卫：拒绝绝对路径/越界段）
fn write_export(
    root: &str,
    files: HashMap<String, String>,
    binaries: &HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    let out = PathBuf::from(root).join(".tmp").join("web-preview");
    write_export_dir(&out, files, binaries)
}

/// 清空并重建 `out` 导出目录，写入文本与二进制产物（预览/构建导出共用）
pub(crate) fn write_export_dir(
    out: &Path,
    files: HashMap<String, String>,
    binaries: &HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    if out.exists() {
        fs::remove_dir_all(out).map_err(|e| format!("清理旧导出产物失败: {}", e))?;
    }
    fs::create_dir_all(out).map_err(|e| format!("创建导出目录失败: {}", e))?;

    for (rel, content) in &files {
        write_export_file(out, rel, content.as_bytes())?;
    }
    for (rel, bytes) in binaries {
        write_export_file(out, rel, bytes)?;
    }
    Ok(())
}

/// 写入单个导出文件（路径守卫：拒绝绝对路径/反斜杠/越界段）
pub(crate) fn write_export_file(out: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    if rel.is_empty()
        || Path::new(rel).is_absolute()
        || rel.contains('\\')
        || rel.split('/').any(|s| s == "..")
    {
        return Err(format!("非法预览文件相对路径: {rel}"));
    }
    let target = out.join(rel);
    if let Some(parent_dir) = target.parent() {
        fs::create_dir_all(parent_dir).map_err(|e| e.to_string())?;
    }
    fs::write(&target, bytes).map_err(|e| format!("写入预览文件失败 '{}': {}", rel, e))
}

/// 读取资产二进制（internal/… → 内置目录；其余 → 项目根沙箱内）
pub(crate) fn read_asset_bytes(root: &Path, rel: &str) -> Result<Vec<u8>, String> {
    if rel == "internal" || rel.starts_with("internal/") {
        let sub = rel.strip_prefix("internal/").unwrap_or("");
        if sub.is_empty()
            || sub.contains('\\')
            || sub.split('/').any(|s| s == ".." || s.is_empty())
        {
            return Err(format!("非法内置资源相对路径: {rel}"));
        }
        let path = crate::internal_root().join(sub);
        return fs::read(&path).map_err(|e| format!("读取内置资源失败 '{rel}': {e}"));
    }
    let path = crate::project::resolve_in_root(root, rel)?;
    fs::read(&path).map_err(|e| format!("读取文件失败 '{rel}': {e}"))
}

/// 材质文档引用的贴图字段（.mat JSON 内为相对路径字符串）
pub(crate) const TEXTURE_FIELDS: [&str; 5] =
    ["map", "metalnessMap", "roughnessMap", "normalMap", "emissiveMap"];

/// 收集单个场景引用的全部资产（材质/贴图/模型），写入 files（文本）与 binaries
/// （二进制）；跨场景共用同一 map 以去重。返回缺失（读取失败被跳过）的资产相对路径。
/// - .mat 材质文本随导出（缺失跳过，player 回退默认参数）；
/// - 材质引用的贴图二进制（缺失跳过，player 回退无贴图）；
/// - 模型资产（glb/gltf/fbx/obj）二进制随导出——player 按同相对路径 fetch 后解析回放
///   （含内嵌动画）；缺失项跳过（player 渲染空组并告警）；
/// - .gltf（JSON 文本）外部引用的 buffers[].uri / images[].uri 指向模型同目录
///   文件（.bin/贴图），一并随拷，保持与编辑器“同目录资源”解析规则一致。
pub(crate) fn collect_scene_assets(
    root_path: &Path,
    scene_text: &str,
    files: &mut HashMap<String, String>,
    binaries: &mut HashMap<String, Vec<u8>>,
) -> Vec<String> {
    let mut missing = Vec::new();
    let scene_json: serde_json::Value =
        serde_json::from_str(scene_text).unwrap_or(serde_json::Value::Null);

    let mut mat_refs = Vec::new();
    crate::scene::migrate::collect_material_refs(&scene_json, &mut mat_refs);
    for rel in &mat_refs {
        let Ok(text) = crate::scene::material::read_material_text(root_path, rel) else {
            missing.push(rel.clone());
            continue;
        };
        files.insert(rel.clone(), text.clone());
        // 材质引用的贴图二进制（缺失跳过，player 回退无贴图）
        if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) {
            // 材质引用的着色器资产（.shader 文本随导出；缺失跳过，player 回退 PBR）
            let mut shader_text: Option<String> = None;
            if let Some(shader_rel) = doc.get("shader").and_then(|v| v.as_str()) {
                if shader_rel.ends_with(".shader") && !files.contains_key(shader_rel) {
                    match crate::scene::material::read_material_text(root_path, shader_rel) {
                        Ok(text) => {
                            files.insert(shader_rel.to_string(), text.clone());
                            shader_text = Some(text);
                        }
                        Err(_) => missing.push(shader_rel.to_string()),
                    }
                }
            }
            for field in TEXTURE_FIELDS {
                if let Some(tex) = doc.get(field).and_then(|v| v.as_str()) {
                    if !tex.is_empty() && !binaries.contains_key(tex) {
                        match read_asset_bytes(root_path, tex) {
                            Ok(bytes) => {
                                binaries.insert(tex.to_string(), bytes);
                            }
                            Err(_) => missing.push(tex.to_string()),
                        }
                    }
                }
            }
            // 自定义着色器贴图属性（.mat props 中按属性名存的贴图引用）：
            // 属性类型来自着色器源码（2D → sampler2D），据此把 props 里的引用一并打包
            if let Some(shader_rel) = doc.get("shader").and_then(|v| v.as_str()) {
                let shader_src = shader_text.or_else(|| {
                    crate::scene::material::read_material_text(root_path, shader_rel).ok()
                });
                if let Some(shader_src) = shader_src {
                    let parsed = crate::scene::shader::parse_custom_shader(&shader_src, shader_rel);
                    let props = doc.get("props").and_then(|v| v.as_object());
                    for prop in parsed
                        .properties
                        .iter()
                        .filter(|p| p.kind == crate::scene::shader::PROP_TEXTURE)
                    {
                        let Some(tex) = props
                            .and_then(|m| m.get(&prop.key))
                            .and_then(|v| v.as_str())
                        else {
                            continue;
                        };
                        if tex.is_empty() || binaries.contains_key(tex) {
                            continue;
                        }
                        match read_asset_bytes(root_path, tex) {
                            Ok(bytes) => {
                                binaries.insert(tex.to_string(), bytes);
                            }
                            Err(_) => missing.push(tex.to_string()),
                        }
                    }
                }
            }
        }
    }

    let mut model_refs = Vec::new();
    crate::scene::migrate::collect_model_refs(&scene_json, &mut model_refs);
    for rel in &model_refs {
        let Ok(bytes) = read_asset_bytes(root_path, rel) else {
            missing.push(rel.clone());
            continue;
        };
        if rel.to_ascii_lowercase().ends_with(".gltf") {
            if let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                for key in ["buffers", "images"] {
                    let Some(items) = doc.get(key).and_then(|v| v.as_array()) else {
                        continue;
                    };
                    for item in items {
                        let Some(uri) = item.get("uri").and_then(|v| v.as_str()) else {
                            continue;
                        };
                        if let Some(sibling) = gltf_sibling_rel(rel, uri) {
                            if sibling != *rel && !binaries.contains_key(&sibling) {
                                match read_asset_bytes(root_path, &sibling) {
                                    Ok(b) => {
                                        binaries.insert(sibling, b);
                                    }
                                    Err(_) => missing.push(sibling),
                                }
                            }
                        }
                    }
                }
            }
        }
        binaries.insert(rel.clone(), bytes);
    }

    // 天空盒 TextureCube 引用：.texcube 文本随导出（缺失跳过，player 回退色带天空），
    // 其引用的全景图/六面贴图二进制一并随拷（缺失项跳过）
    let mut texcube_refs = Vec::new();
    crate::scene::migrate::collect_texcube_refs(&scene_json, &mut texcube_refs);
    for rel in &texcube_refs {
        let Ok(text) = crate::scene::texcube::read_texcube_text(root_path, rel) else {
            missing.push(rel.clone());
            continue;
        };
        files.insert(rel.clone(), text.clone());
        // 解析失败视作无引用（player 读取该文件同样解析失败 → 回退色带天空）
        let Some((_, _, map, faces)) = crate::scene::texcube::parse_texcube_doc(&text) else {
            continue;
        };
        let mut tex_refs: Vec<String> = Vec::new();
        if !map.is_empty() {
            tex_refs.push(map);
        }
        if let Some(faces) = faces {
            for f in [faces.px, faces.nx, faces.py, faces.ny, faces.pz, faces.nz] {
                if !f.is_empty() {
                    tex_refs.push(f);
                }
            }
        }
        for tex in tex_refs {
            if binaries.contains_key(&tex) || files.contains_key(&tex) {
                continue;
            }
            match read_asset_bytes(root_path, &tex) {
                Ok(bytes) => {
                    binaries.insert(tex, bytes);
                }
                Err(_) => missing.push(tex),
            }
        }
    }

    // 音源节点音频引用：二进制随导出（缺失跳过，player 侧该音源静音）
    let mut audio_refs = Vec::new();
    crate::scene::migrate::collect_audio_refs(&scene_json, &mut audio_refs);
    for rel in &audio_refs {
        if binaries.contains_key(rel) {
            continue;
        }
        match read_asset_bytes(root_path, rel) {
            Ok(bytes) => {
                binaries.insert(rel.clone(), bytes);
            }
            Err(_) => missing.push(rel.clone()),
        }
    }
    // 关键帧动画剪辑引用：.anim 文本随导出（缺失跳过，player 侧该组件空转）
    let mut anim_refs = Vec::new();
    crate::scene::migrate::collect_anim_refs(&scene_json, &mut anim_refs);
    for rel in &anim_refs {
        if files.contains_key(rel) {
            continue;
        }
        match crate::scene::material::read_material_text(root_path, rel) {
            Ok(text) => {
                files.insert(rel.clone(), text);
            }
            Err(_) => missing.push(rel.clone()),
        }
    }
    missing
}

/// 从当前场景导出网页预览产物：
/// - files 由前端提供网页运行时（index.html / player.mjs / engine/** 模块与 three 运行时 / config.json，
///   属 WebView 打包资源，前端 fetch 一次传入）；
/// - scene.json 与场景引用的 .mat 材质、材质引用的贴图二进制、模型网格引用的
///   模型资产（glb/gltf/fbx/obj 及 .gltf 外部 .bin/贴图）全部由 Rust 直接
///   从磁盘读取写入导出目录——大文件不再以 base64 形式穿过 IPC（旧导出的主要负载）。
#[tauri::command]
pub async fn export_web_preview_from_scene(
    root: String,
    scene_rel: String,
    files: HashMap<String, String>,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);

    // 场景文本（调用方预览前已保存，读盘保证与导出一致）
    let scene_text = crate::project::resolve_in_root(&root_path, &scene_rel)
        .and_then(|p| fs::read_to_string(&p).map_err(|e| e.to_string()))
        .map_err(|e| format!("读取场景失败 '{scene_rel}': {e}"))?;
    let mut files = files;
    files.insert("scene.json".to_string(), scene_text.clone());

    let mut binaries: HashMap<String, Vec<u8>> = HashMap::new();
    collect_scene_assets(&root_path, &scene_text, &mut files, &mut binaries);

    write_export(&root, files, &binaries)
}

/// .gltf 内外部引用（buffers[].uri / images[].uri）→ 模型同目录的资产相对路径。
/// data:/绝对地址、反斜杠与越出资产根（..）的引用返回 None（跳过不拷贝）。
pub(crate) fn gltf_sibling_rel(model_rel: &str, uri: &str) -> Option<String> {
    if uri.is_empty() || uri.contains('\\') || uri.contains("://") || uri.starts_with("data:") {
        return None;
    }
    let decoded = percent_decode(uri);
    let dir = match model_rel.rfind('/') {
        Some(i) => &model_rel[..i],
        None => "",
    };
    let joined = if dir.is_empty() { decoded } else { format!("{dir}/{decoded}") };
    let mut parts: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return None; // 越出资产根
                }
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// 启动网页预览服务器（服务项目内指定目录），返回可内嵌的 base URL。
/// dir 缺省服务 `<root>/.tmp/web-preview`（编辑器内嵌预览）；构建面板传
/// "build/web" 预览构建产物。同目录已有服务器时直接复用（URL 稳定不漂移）；
/// 切换目录（如网页预览 ↔ 构建预览）才停旧起新。
#[tauri::command]
pub async fn start_web_preview_server(
    state: tauri::State<'_, PreviewServerState>,
    root: String,
    dir: Option<String>,
) -> Result<String, String> {
    let root_path = PathBuf::from(&root);
    let rel = dir.unwrap_or_else(|| ".tmp/web-preview".to_string());
    if rel.contains('\\') || rel.split('/').any(|s| s == ".." || s.is_empty()) {
        return Err(format!("非法的服务目录: '{rel}'"));
    }
    let out = root_path.join(rel);
    if !out.is_dir() {
        return Err(format!("预览产物目录不存在，请先导出: '{}'", out.display()));
    }
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    // 幂等：同目录重复启动直接复用现有服务器（外部引用的 URL 保持有效）
    if let Some(old) = guard.as_ref() {
        if old.root == out {
            return Ok(old.base_url.clone());
        }
    }
    if let Some(old) = guard.take() {
        stop_server(old);
    }
    let server = start_server(out)?;
    let url = server.base_url.clone();
    guard.replace(server);
    Ok(url)
}

/// 停止网页预览服务器（释放端口；不影响编辑器视口）
#[tauri::command]
pub async fn stop_web_preview(state: tauri::State<'_, PreviewServerState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(server) = guard.take() {
        stop_server(server);
    }
    Ok(())
}

fn start_server(root: PathBuf) -> Result<PreviewServer, String> {
    // 先绑固定端口（URL 稳定）；被占用时回退随机端口保证可用
    let listener = match TcpListener::bind(("127.0.0.1", PREVIEW_FIXED_PORT)) {
        Ok(l) => l,
        Err(_) => TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("绑定预览服务器端口失败: {}", e))?,
    };
    let addr = listener
        .local_addr()
        .map_err(|e| format!("读取预览服务器地址失败: {}", e))?;
    let shutdown = Arc::new(AtomicBool::new(false));
    let flag = shutdown.clone();
    let loop_root = root.clone();
    let handle = thread::spawn(move || accept_loop(listener, loop_root, flag));
    Ok(PreviewServer {
        root,
        base_url: format!("http://{addr}"),
        shutdown,
        handle: Some(handle),
    })
}

fn stop_server(server: PreviewServer) {
    server.shutdown.store(true, Ordering::Relaxed);
    if let Some(h) = server.handle {
        // accept 循环以 ~8ms 间隔轮询关闭标记，join 很快返回
        let _ = h.join();
    }
}

fn accept_loop(listener: TcpListener, root: PathBuf, shutdown: Arc<AtomicBool>) {
    let _ = listener.set_nonblocking(true);
    while !shutdown.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let root = root.clone();
                thread::spawn(move || handle_connection(stream, root));
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(8));
            }
            Err(_) => {
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

fn handle_connection(mut stream: TcpStream, root: PathBuf) {
    // 读请求头（最多 64KB，遇到空行即止）
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    let mut header_end = None;
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = find_sub(&buf, b"\r\n\r\n") {
                    header_end = Some(pos);
                    break;
                }
                if buf.len() > 65536 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let head_len = header_end.unwrap_or(buf.len());
    let head = String::from_utf8_lossy(&buf[..head_len]);
    let request_line = head.lines().next().unwrap_or("").trim();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method != "GET" {
        respond(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain; charset=utf-8",
            b"405 Method Not Allowed",
        );
        return;
    }

    let rel = match sanitize_target(target) {
        Some(rel) => rel,
        None => {
            respond(&mut stream, "404 Not Found", "text/plain; charset=utf-8", b"404 Not Found");
            return;
        }
    };
    let file = root.join(&rel);
    if !file.starts_with(&root) {
        respond(&mut stream, "404 Not Found", "text/plain; charset=utf-8", b"404 Not Found");
        return;
    }
    match fs::read(&file) {
        Ok(body) => {
            let mime = mime_for(&file);
            respond(&mut stream, "200 OK", mime, &body);
        }
        Err(_) => {
            respond(&mut stream, "404 Not Found", "text/plain; charset=utf-8", b"404 Not Found");
        }
    }
}

/// 把请求目标解析为安全相对路径；非法返回 None。
/// 默认 "/" → "index.html"，忽略查询串与片段，拒绝 ".." 与反斜杠。
fn sanitize_target(raw: &str) -> Option<String> {
    let target = raw.split(['?', '#']).next().unwrap_or("/");
    let decoded = percent_decode(target);
    let rel = decoded.trim_start_matches('/');
    if rel.is_empty() {
        return Some("index.html".to_string());
    }
    if rel.contains('\\') || rel.split('/').any(|s| s == "..") || rel.contains('\0') {
        return None;
    }
    Some(rel.to_string())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = hex_val(bytes[i + 1]);
            let l = hex_val(bytes[i + 2]);
            if let (Some(h), Some(l)) = (h, l) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("mat") => "application/json; charset=utf-8",
        Some("glb") => "model/gltf-binary",
        Some("gltf") => "model/gltf+json",
        Some("bin") => "application/octet-stream",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("wasm") => "application/wasm",
        Some("map") => "application/json; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use std::fs;
    use super::{gltf_sibling_rel, start_server, stop_server, PREVIEW_FIXED_PORT};

    #[test]
    fn preview_server_reuses_fixed_port() {
        // 固定端口：连续启动/停止，端口不漂移（外部引用的 URL 保持有效）
        let root = std::env::temp_dir().join("tve-preview-port-test");
        fs::create_dir_all(&root).unwrap();
        let a = start_server(root.clone()).unwrap();
        let url_a = a.base_url.clone();
        assert!(url_a.ends_with(&PREVIEW_FIXED_PORT.to_string()));
        // 真实生命周期：停旧 → 起新，端口不漂移
        stop_server(a);
        let b = start_server(root).unwrap();
        assert_eq!(url_a, b.base_url);
        stop_server(b);
    }


    #[test]
    fn gltf_sibling_resolves_against_model_dir() {
        assert_eq!(
            gltf_sibling_rel("assets/models/a.glb".into(), "scene.bin").as_deref(),
            Some("assets/models/scene.bin")
        );
        // 子目录与 ../ 回溯按相对路径归一化
        assert_eq!(
            gltf_sibling_rel("assets/models/a.gltf".into(), "tex/diffuse.png").as_deref(),
            Some("assets/models/tex/diffuse.png")
        );
        assert_eq!(
            gltf_sibling_rel("assets/models/sub/a.gltf".into(), "../shared.buf").as_deref(),
            Some("assets/models/shared.buf")
        );
        // 根目录模型（无目录段）直接归一化
        assert_eq!(gltf_sibling_rel("a.gltf".into(), "./b.bin").as_deref(), Some("b.bin"));
    }

    #[test]
    fn gltf_sibling_rejects_absolute_and_escape() {
        assert_eq!(gltf_sibling_rel("assets/models/a.gltf".into(), ""), None);
        assert_eq!(gltf_sibling_rel("assets/models/a.gltf".into(), "data:application/octet;base64,AAA"), None);
        assert_eq!(gltf_sibling_rel("assets/models/a.gltf".into(), "https://cdn.example.com/x.png"), None);
        assert_eq!(gltf_sibling_rel("assets/models/a.gltf".into(), "C:\\x.png"), None);
        // .. 越出资产根 → 空地址（守卫拒绝）
        assert_eq!(gltf_sibling_rel("assets/models/a.gltf".into(), "../../../../etc/passwd"), None);
    }
}
