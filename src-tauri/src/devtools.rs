//! 开发者服务：本地控制服务器（换行分隔 JSON over TCP）+ MCP streamable-http 端点。
//!
//! 启用后监听 `127.0.0.1:{port}`，外部工具（脚本 / 集成 / 自动化）用换行分隔的 JSON
//! 与编辑器交互：
//! - 请求：`{"id":<任意值>,"method":"<字符串>","params":{...}}`
//! - 响应：`{"id":<同上>,"result":<值>,"error":<字符串|null>}`
//! - 推送（无 id）：`{"event":"<名称>","data":<值>}`
//!
//! 同一端口自动探测 HTTP 请求（POST /mcp），内联提供 MCP streamable-http 端点。
//!
//! 方法分两类：
//! - **Rust 本地**：`ping` / `editor.health`，直接在服务端应答。
//! - **前端执行**：其余方法转发为 Tauri 事件 `devtools:cmd`，由编辑器窗口的
//!   前端执行器（src/app/lib/devtools）调用 store / engine / api，再经
//!   `devtools_reply` 回填。每笔待回复命令由服务端生成唯一 `replyToken`（UUID），
//!   避免多客户端 id 冲突。

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Tauri managed：当前开发者服务运行时（同一时刻至多一个）
#[derive(Default)]
pub struct DevToolsState {
    inner: Mutex<Option<Arc<DevToolsRuntime>>>,
}

/// 启动后返回给前端/用户的信息
#[derive(Serialize, Clone)]
pub struct DevToolsInfo {
    pub port: u16,
    /// 展示用端点（tcp://…）；协议为换行分隔 JSON
    pub url: String,
    /// MCP HTTP 端点（http://127.0.0.1:<port>/mcp，同一端口）
    pub mcp_url: String,
    /// MCP stdio 桥程序路径（mcp.exe，与主程序同目录；客户端配置 command 用）
    pub stdio_command: String,
    pub token: String,
    pub protocol: String,
}

struct PendingResp {
    tx: SyncSender<String>,
    req_id: serde_json::Value,
}

pub struct DevToolsRuntime {
    port: u16,
    token: String,
    /// 所有客户端连接（用于事件广播，仅 JSON-lines 客户端）
    clients: Mutex<Vec<SyncSender<String>>>,
    /// replyToken -> (连接发送端, 原请求 id)
    pending: Mutex<HashMap<String, PendingResp>>,
    /// replyToken -> MCP HTTP 请求的回复通道（前端回填后构造成 HTTP 响应）
    http_pending: Mutex<HashMap<String, SyncSender<serde_json::Value>>>,
    /// MCP 工具名（合法名，如 editor_state）-> 真实 devtools 方法（如 editor.state）
    name_to_method: Mutex<HashMap<String, String>>,
    stop: Arc<AtomicBool>,
}

impl DevToolsRuntime {
    fn info(&self) -> DevToolsInfo {
        DevToolsInfo {
            port: self.port,
            url: format!("tcp://127.0.0.1:{}", self.port),
            mcp_url: format!("http://127.0.0.1:{}/mcp", self.port),
            stdio_command: mcp_stdio_command(),
            token: self.token.clone(),
            protocol: "tcp-jsonlines + mcp-http".to_string(),
        }
    }
}

/// MCP stdio 桥程序路径：与主程序同目录的 mcp.exe（不存在时回退为裸文件名，供用户自行修正）。
fn mcp_stdio_command() -> String {
    const NAME: &str = if cfg!(windows) { "mcp.exe" } else { "mcp" };
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(NAME)))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| NAME.to_string())
}

fn send_reply(
    tx: &SyncSender<String>,
    id: serde_json::Value,
    result: serde_json::Value,
    error: Option<String>,
) {
    let resp = serde_json::json!({ "id": id, "result": result, "error": error });
    if let Ok(s) = serde_json::to_string(&resp) {
        let _ = tx.send(s);
    }
}

/// 处理一条客户端命令：Rust 本地方法直接应答；其余转发编辑器窗口前端执行器。
fn dispatch_command(line: &str, rt: &DevToolsRuntime, app: &AppHandle, tx: &SyncSender<String>) {
    let msg: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    let id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let method = msg
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let params = msg.get("params").cloned().unwrap_or(serde_json::Value::Null);

    match method.as_str() {
        "ping" => {
            send_reply(tx, id, serde_json::json!("pong"), None);
            return;
        }
        "editor.health" => {
            send_reply(
                tx,
                id,
                serde_json::json!({
                    "ok": true,
                    "port": rt.port,
                    "protocol": "tcp-jsonlines",
                }),
                None,
            );
            return;
        }
        _ => {}
    }

    // 前端执行：登记待回复渠道，再发事件给前端执行器（编辑器窗口与首页窗口共用事件总线，
    // 但只有编辑器窗口安装了监听器）。
    let token = uuid::Uuid::new_v4().to_string();
    rt.pending.lock().unwrap().insert(
        token.clone(),
        PendingResp {
            tx: tx.clone(),
            req_id: id.clone(),
        },
    );
    let payload =
        serde_json::json!({ "id": id, "method": method, "params": params, "replyToken": token });
    let _ = app.emit("devtools:cmd", payload);
}

fn writer_loop(mut stream: TcpStream, rx: Receiver<String>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(msg) => {
                if stream.write_all(msg.as_bytes()).is_err() {
                    break;
                }
                if stream.write_all(b"\n").is_err() {
                    break;
                }
                let _ = stream.flush();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        }
    }
}

fn reader_loop(
    reader: &mut BufReader<TcpStream>,
    rt: &DevToolsRuntime,
    app: &AppHandle,
    tx: &SyncSender<String>,
) {
    loop {
        if rt.stop.load(Ordering::SeqCst) {
            break;
        }
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break, // 客户端断开
            Ok(_) => {
                let s = line.trim();
                if !s.is_empty() {
                    dispatch_command(s, rt, app, tx);
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(_) => break,
        }
    }
}

fn spawn_client(stream: TcpStream, rt: Arc<DevToolsRuntime>, app: AppHandle) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(200)));
    let write_half = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);
    // 探测协议：读第一行；以 HTTP 方法开头（POST / GET / PUT / DELETE）则按 HTTP（MCP）处理，
    // 否则按 JSON-lines 处理。一条连接只会是其中一种。
    let mut first = String::new();
    let is_http = match reader.read_line(&mut first) {
        Ok(_) => {
            let t = first.trim();
            t.starts_with("POST ")
                || t.starts_with("GET ")
                || t.starts_with("PUT ")
                || t.starts_with("DELETE ")
        }
        Err(_) => false,
    };

    if is_http {
        let rt_r = rt.clone();
        let app_r = app.clone();
        std::thread::spawn(move || {
            let _ = handle_http_conn(&mut reader, write_half, &rt_r, &app_r, first);
        });
        return;
    }

    // JSON-lines 客户端：注册广播目标（不参与 HTTP MCP）
    let (tx, rx) = sync_channel::<String>(256);
    rt.clients.lock().unwrap().push(tx.clone());
    let stop = rt.stop.clone();
    std::thread::spawn(move || writer_loop(write_half, rx, stop));
    let rt_r = rt.clone();
    let app_r = app.clone();
    std::thread::spawn(move || {
        let s = first.trim();
        if !s.is_empty() {
            dispatch_command(s, &rt_r, &app_r, &tx);
        }
        reader_loop(&mut reader, &rt_r, &app_r, &tx);
    });
}

fn accept_loop(listener: TcpListener, rt: Arc<DevToolsRuntime>, app: AppHandle) {
    let _ = listener.set_nonblocking(true);
    while !rt.stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _peer)) => spawn_client(stream, rt.clone(), app.clone()),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }
}

/// 处理一条 MCP HTTP 连接：读取 POST /mcp 请求，构造 HTTP 响应写回。
fn handle_http_conn(
    reader: &mut BufReader<TcpStream>,
    mut write_half: TcpStream,
    rt: &DevToolsRuntime,
    app: &AppHandle,
    _request_line: String,
) {
    // 读请求头直到空行，统计 Content-Length
    let mut content_len = 0usize;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return,
            Ok(_) => {
                let l = line.trim_end();
                if l.is_empty() {
                    break;
                }
                let lower = l.to_ascii_lowercase();
                if let Some(v) = lower.strip_prefix("content-length:") {
                    content_len = v.trim().parse().unwrap_or(0);
                }
            }
            Err(_) => return,
        }
    }
    // 读 body（JSON-RPC）
    let mut body = vec![0u8; content_len];
    let mut read = 0usize;
    while read < content_len {
        match reader.read(&mut body[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(_) => break,
        }
    }
    let body = String::from_utf8_lossy(&body).to_string();
    let resp = mcp_http_response(body.trim(), rt, app);
    let _ = write_half.write_all(&resp);
    let _ = write_half.flush();
}

/// 构造 MCP HTTP 响应（PUT/POST /mcp）。通知（无 id）返回空 body。
fn mcp_http_response(body: &str, rt: &DevToolsRuntime, app: &AppHandle) -> Vec<u8> {
    let msg: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => {
            let js = serde_json::json!({
                "jsonrpc": "2.0", "id": serde_json::Value::Null,
                "error": { "code": -32700, "message": "Parse error" }
            });
            return http_json(&js);
        }
    };
    // 通知（无 id）：不返回 JSON-RPC 响应
    if msg.get("id").is_none() {
        return "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_string()
            .into_bytes();
    }
    let resp = resolve_mcp(msg, rt, app);
    http_json(&resp)
}

fn http_json(value: &serde_json::Value) -> Vec<u8> {
    let js = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        js.len(),
        js
    )
    .into_bytes()
}

/// 解析 MCP JSON-RPC 消息并返回响应。
fn resolve_mcp(msg: serde_json::Value, rt: &DevToolsRuntime, app: &AppHandle) -> serde_json::Value {
    let id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let method = msg
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let params = msg
        .get("params")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    match method.as_str() {
        "initialize" => serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "tve-devtools", "version": "0.1.0" },
            }
        }),
        "ping" => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => {
            let list = mcp_frontend_call(rt, app, "mcp.listTools", serde_json::json!({}));
            let tools = list
                .get("result")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]));
            // 缓存 name -> method，供 tools/call 反查；同时把 method 字段从返回的工具里去掉
            let mut name_map = rt.name_to_method.lock().unwrap();
            let mut out = Vec::new();
            if let Some(arr) = tools.as_array() {
                for t in arr {
                    let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    let method = t
                        .get("method")
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .to_string();
                    if !name.is_empty() && !method.is_empty() {
                        name_map.insert(name.clone(), method.clone());
                    }
                    let mut clean = t.clone();
                    if let Some(obj) = clean.as_object_mut() {
                        obj.remove("method");
                    }
                    out.push(clean);
                }
            }
            drop(name_map);
            serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": out } })
        }
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            if name.is_empty() {
                return serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": { "content": [{ "type": "text", "text": "缺少工具名 name" }], "isError": true }
                });
            }
            let method = rt.name_to_method.lock().unwrap().get(&name).cloned();
            let method = match method {
                Some(m) => m,
                None => {
                    return serde_json::json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": { "content": [{ "type": "text", "text": format!("未知工具: {}", name) }], "isError": true }
                    });
                }
            };
            let result = mcp_frontend_call(rt, app, &method, args);
            if let Some(err) = result.get("error").and_then(|e| e.as_str()) {
                serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": { "content": [{ "type": "text", "text": err.to_string() }], "isError": true }
                })
            } else {
                let r = result.get("result").cloned().unwrap_or_else(|| serde_json::json!(null));
                let text = serde_json::to_string_pretty(&r).unwrap_or_else(|_| String::new());
                serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": { "content": [{ "type": "text", "text": text }], "isError": false }
                })
            }
        }
        _ => serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": format!("未知方法: {}", method) }
        }),
    }
}

/// 经前端执行器执行一个 devtools 方法（MCP tools/list / tools/call 用），等待前端回填。
fn mcp_frontend_call(
    rt: &DevToolsRuntime,
    app: &AppHandle,
    method: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    let token = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = sync_channel::<serde_json::Value>(1);
    rt.http_pending.lock().unwrap().insert(token.clone(), tx);
    let payload = serde_json::json!({ "id": 1, "method": method, "params": params, "replyToken": token });
    let _ = app.emit("devtools:cmd", payload);
    let resp = rx
        .recv_timeout(std::time::Duration::from_secs(12))
        .unwrap_or_else(|_| serde_json::json!({ "error": "前端未响应（超时）" }));
    rt.http_pending.lock().unwrap().remove(&token);
    resp
}

/// 控制服务器默认端口（应用启动时自动绑定；被占用时回退随机端口）
pub const DEFAULT_PORT: u16 = 39100;

/// 启动控制服务器核心（幂等：已在运行则直接返回现有信息）。
/// `devtools_start` 命令与 lib.rs 的 setup 自动启动共用此入口。
pub fn start_runtime(app: &AppHandle, port: Option<u16>) -> Result<DevToolsInfo, String> {
    let state = app.state::<DevToolsState>();
    {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        if let Some(rt) = guard.as_ref() {
            return Ok(rt.info());
        }
    }
    // 固定端口：指定的正整数绑定到 127.0.0.1:port（端口被占用则报错）；否则随机端口。
    let addr = match port {
        Some(p) if p > 0 => format!("127.0.0.1:{}", p),
        _ => "127.0.0.1:0".to_string(),
    };
    let listener = TcpListener::bind(&addr).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = uuid::Uuid::new_v4().to_string();
    let stop = Arc::new(AtomicBool::new(false));
    let rt = Arc::new(DevToolsRuntime {
        port,
        token: token.clone(),
        clients: Mutex::new(Vec::new()),
        pending: Mutex::new(HashMap::new()),
        http_pending: Mutex::new(HashMap::new()),
        name_to_method: Mutex::new(HashMap::new()),
        stop: stop.clone(),
    });
    let rt_bg = rt.clone();
    let app_bg = app.clone();
    std::thread::spawn(move || accept_loop(listener, rt_bg, app_bg));
    *state.inner.lock().map_err(|e| e.to_string())? = Some(rt.clone());
    Ok(rt.info())
}

/// 应用启动时自动开启控制服务器（后台线程；默认端口被占用则回退随机端口）。
/// 失败仅打日志，不阻断应用启动。
pub fn autostart(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(bind_err) = start_runtime(&handle, Some(DEFAULT_PORT)) {
            match start_runtime(&handle, None) {
                Ok(info) => eprintln!(
                    "[devtools] 默认端口 {} 被占用（{}），已改用随机端口 {}",
                    DEFAULT_PORT, bind_err, info.port
                ),
                Err(e) => eprintln!("[devtools] 控制服务器自动启动失败: {e}"),
            }
        }
    });
}

/// 启动开发者服务控制服务器（幂等：已在运行则直接返回现有信息）
#[tauri::command]
pub async fn devtools_start(app: AppHandle, port: Option<u16>) -> Result<DevToolsInfo, String> {
    start_runtime(&app, port)
}

/// 停止开发者服务控制服务器
#[tauri::command]
pub async fn devtools_stop(state: State<'_, DevToolsState>) -> Result<(), String> {
    if let Some(rt) = state.inner.lock().map_err(|e| e.to_string())?.take() {
        rt.stop.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// 是否已启用（以及连接信息）
#[tauri::command]
pub async fn devtools_status(
    state: State<'_, DevToolsState>,
) -> Result<Option<DevToolsInfo>, String> {
    Ok(state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|rt| rt.info()))
}

/// 前端执行器回填命令结果（按 replyToken 路由回对应客户端）
#[tauri::command]
pub async fn devtools_reply(
    state: State<'_, DevToolsState>,
    token: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    let Some(rt) = guard.as_ref() else {
        return Ok(());
    };
    if let Some(p) = rt.pending.lock().unwrap().remove(&token) {
        let resp = serde_json::json!({
            "id": p.req_id,
            "result": result.unwrap_or(serde_json::Value::Null),
            "error": error,
        });
        if let Ok(s) = serde_json::to_string(&resp) {
            let _ = p.tx.send(s);
        }
    } else if let Some(h) = rt.http_pending.lock().unwrap().remove(&token) {
        // MCP HTTP 请求：把 {result, error} 送回 HTTP 处理器构造成 JSON-RPC 响应
        let resp = serde_json::json!({
            "result": result.unwrap_or(serde_json::Value::Null),
            "error": error,
        });
        let _ = h.send(resp);
    }
    Ok(())
}

/// 前端推送事件（console / 日志 / 状态变化）广播给所有客户端
#[tauri::command]
pub async fn devtools_push(
    state: State<'_, DevToolsState>,
    event: String,
    data: serde_json::Value,
) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    let Some(rt) = guard.as_ref() else {
        return Ok(());
    };
    let msg = serde_json::json!({ "event": event, "data": data });
    let Ok(s) = serde_json::to_string(&msg) else {
        return Ok(());
    };
    let clients = rt.clients.lock().unwrap();
    for tx in clients.iter() {
        let _ = tx.send(s.clone());
    }
    Ok(())
}
