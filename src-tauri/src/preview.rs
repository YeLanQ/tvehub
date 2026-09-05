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
    base_url: String,
    shutdown: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

/// 把文件写入 `<root>/.tmp/web-preview`（先清空旧产物）。只负责写产物，
/// 不启停服务器 —— 启动/停止分别由 start_web_preview_server / stop_web_preview 负责，
/// 避免导出与停止并发时产生“导出完成后又拉起服务器”的竞态。
/// files：相对路径 → 内容（含 index.html / player.mjs / three.*.min.js / scene.json / config.json）。
#[tauri::command]
pub async fn export_web_preview(
    root: String,
    files: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("项目目录不存在: '{}'", root_path.display()));
    }
    let out = root_path.join(".tmp").join("web-preview");
    if out.exists() {
        fs::remove_dir_all(&out).map_err(|e| format!("清理旧预览产物失败: {}", e))?;
    }
    fs::create_dir_all(&out).map_err(|e| format!("创建预览目录失败: {}", e))?;

    let files = files.unwrap_or_default();
    for (rel, content) in &files {
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
        fs::write(&target, content.as_bytes())
            .map_err(|e| format!("写入预览文件失败 '{}': {}", rel, e))?;
    }
    Ok(())
}

/// 启动网页预览服务器（服务 `<root>/.tmp/web-preview`），返回可内嵌的 base URL。
/// 已存在服务器时先停止旧服务器（端口与目录都会切换）。
#[tauri::command]
pub async fn start_web_preview_server(
    state: tauri::State<'_, PreviewServerState>,
    root: String,
) -> Result<String, String> {
    let root_path = PathBuf::from(&root);
    let out = root_path.join(".tmp").join("web-preview");
    if !out.is_dir() {
        return Err(format!("预览产物目录不存在，请先导出: '{}'", out.display()));
    }
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
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
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("绑定预览服务器端口失败: {}", e))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("读取预览服务器地址失败: {}", e))?;
    let shutdown = Arc::new(AtomicBool::new(false));
    let flag = shutdown.clone();
    let handle = thread::spawn(move || accept_loop(listener, root, flag));
    Ok(PreviewServer {
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
