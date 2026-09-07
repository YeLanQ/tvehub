// ---------------------------------------------------------------------------
// asset:// 自定义协议：模型/贴图等二进制资产改由 WebView 直接向 Rust 请求，
// 取代「invoke 读 base64 → JS atob 解码」的热路径——大模型与其外部贴图不再
// 膨胀为巨型字符串穿过 IPC 桥，消除 WebView 堆压力（GC 卡顿/内存过载）。
// URL 形态（前端 convertFileSrc 生成，跨平台差异由其抹平）：
//   Windows/Android: http://asset.localhost/<p|i>/<rel>
//   macOS/Linux:     asset://localhost/<p|i>/<rel>
//   - p → 当前项目根内资产（resolve_in_root 沙箱校验防越界）
//   - i → 编辑器内置资源（public/internal；排除 templates/）
// ---------------------------------------------------------------------------

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::http::{header, Request, Response, StatusCode};

/// asset:// 协议共享状态：当前项目根目录（前端打开项目时经
/// set_current_project_root 注入；无项目时 p 范围一律 404）
pub struct AssetProtocolState {
    project_root: Mutex<Option<PathBuf>>,
}

impl AssetProtocolState {
    pub fn set_project_root(&self, root: Option<PathBuf>) {
        *self.project_root.lock().unwrap() = root;
    }

    fn project_root(&self) -> Option<PathBuf> {
        self.project_root.lock().unwrap().clone()
    }
}

impl Default for AssetProtocolState {
    fn default() -> Self {
        Self {
            project_root: Mutex::new(None),
        }
    }
}

/// 前端打开/关闭项目时更新 asset:// 协议的项目根（root = null 表示无项目）
#[tauri::command]
pub async fn set_current_project_root(
    state: tauri::State<'_, AssetProtocolState>,
    root: Option<String>,
) -> Result<(), String> {
    state.set_project_root(root.map(PathBuf::from));
    Ok(())
}

/// 扩展名 → MIME（模型/贴图/文本；未知一律 octet-stream，three 加载器按内容解析）
fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "obj" | "txt" => "text/plain",
        "json" | "mat" | "texcube" => "application/json",
        _ => "application/octet-stream",
    }
}

/// URL 百分号解码（convertFileSrc 对路径整体 encodeURIComponent 过一次；
/// 文件名含空格/中文时必须解码后再落盘查找。仅解码一次，无双重解码歧义）
fn percent_decode(s: &str) -> String {
    fn hex(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn asset_response(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    // 跨源（dev 页面与协议域不同源）由 CORS 头放行；three 的 fetch/Image 加载均需要
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        // 编辑器在 JS 层缓存解析产物；HTTP 层不复存，保证资产改动立即可见
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(body))
        .expect("静态响应头构建不会失败")
}

fn asset_not_found(path: &str) -> Response<Cow<'static, [u8]>> {
    asset_response(
        StatusCode::NOT_FOUND,
        "text/plain; charset=utf-8",
        format!("asset not found: {path}").into_bytes(),
    )
}

/// asset:// 协议处理器：解析 <scope>/<rel> → 沙箱校验 → 读文件字节。
/// 仅 GET；任何路径/读取失败统一 404（不给越界探测留区分信号）。
pub fn handle_asset_protocol(
    state: &AssetProtocolState,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    if request.method() != "GET" {
        return asset_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "text/plain; charset=utf-8",
            b"method not allowed".to_vec(),
        );
    }
    let decoded = percent_decode(request.uri().path());
    let scoped = decoded.trim_start_matches('/');
    let (scope, rel) = match scoped.split_once('/') {
        Some(pair) => pair,
        None => return asset_not_found(&decoded),
    };

    let file: PathBuf = match scope {
        "p" => {
            let Some(root) = state.project_root() else {
                return asset_not_found(scoped);
            };
            match crate::project::resolve_in_root(&root, rel) {
                Ok(p) => p,
                Err(_) => return asset_not_found(scoped),
            }
        }
        "i" => {
            // 内置资源段校验与 internal.rs 的 safe_internal_rel 同规则；templates 不暴露
            if rel.is_empty()
                || rel.contains('\\')
                || rel.split('/').any(|s| s == ".." || s.is_empty())
                || rel == "templates"
                || rel.starts_with("templates/")
            {
                return asset_not_found(scoped);
            }
            crate::internal_root().join(rel)
        }
        _ => return asset_not_found(&decoded),
    };

    if !file.is_file() {
        return asset_not_found(scoped);
    }
    let bytes = match std::fs::read(&file) {
        Ok(b) => b,
        Err(_) => return asset_not_found(scoped),
    };
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    asset_response(StatusCode::OK, mime_for_ext(&ext), bytes)
}
