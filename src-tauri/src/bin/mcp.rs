//! 开发者服务 MCP 协议桥（stdio 传输）。
//!
//! MCP 客户端（Claude Desktop / Cursor 等）以 stdio 方式启动本进程：
//!   { "command": "<path>/mcp.exe", "args": ["--port", "30000"] }
//! 本进程读取标准输入上的 JSON-RPC（换行分隔），把 `tools/list` / `tools/call` 转发到
//! 运行中的 devtools TCP 服务器（127.0.0.1:<port>），并把结果回传给 MCP 客户端。
//!
//! 端口来源：环境变量 `TVE_DEVTOOLS_PORT`，或 `--port <N>` 参数。
//! tools/list 由 devtools 前端按「工具权限」启用状态返回（enabledMcpTools）。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;

fn devtools_port() -> u16 {
    std::env::var("TVE_DEVTOOLS_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .or_else(|| {
            let args: Vec<String> = std::env::args().collect();
            args.windows(2)
                .find(|w| w[0] == "--port")
                .and_then(|w| w[1].parse::<u16>().ok())
        })
        .unwrap_or(0)
}

fn devtools_addr(port: u16) -> String {
    format!("127.0.0.1:{}", port)
}

/// 连接 devtools TCP，发送一条命令，读取一行 JSON 回复。
fn call_devtools(port: u16, cmd: &str, params: Value) -> Value {
    if port == 0 {
        return json!({ "error": "未指定开发者服务端口（设 TVE_DEVTOOLS_PORT 或 --port）" });
    }
    let mut stream = match TcpStream::connect(devtools_addr(port)) {
        Ok(s) => s,
        Err(e) => {
            return json!({ "error": format!("无法连接开发者服务 {}: {}", devtools_addr(port), e) })
        }
    };
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
    let req = json!({ "id": 1, "method": cmd, "params": params });
    let mut buf = Vec::new();
    if let Ok(s) = serde_json::to_vec(&req) {
        buf.extend_from_slice(&s);
        buf.push(b'\n');
    }
    if stream.write_all(&buf).is_err() {
        return json!({ "error": "发送命令失败" });
    }
    let _ = stream.flush();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(_) => serde_json::from_str::<Value>(line.trim())
            .unwrap_or_else(|_| json!({ "error": "非法响应" })),
        Err(_) => json!({ "error": "读取响应失败" }),
    }
}

/// 处理一条 MCP JSON-RPC 消息，返回应写入 stdout 的响应（None = 通知，无需响应）。
fn handle_message(line: &str, port: u16) -> Option<Value> {
    let msg: Value = serde_json::from_str(line).ok()?;
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
    let id = msg.get("id").cloned();
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

    match method.as_str() {
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "tve-devtools", "version": "0.1.0" },
            }
        })),
        "notifications/initialized" => None,
        "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        "tools/list" => {
            let resp = call_devtools(port, "mcp.listTools", json!({}));
            let tools = resp.get("result").cloned().unwrap_or_else(|| json!([]));
            Some(json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } }))
        }
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if name.is_empty() {
                return Some(json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": { "content": [{ "type": "text", "text": "缺少工具名 name" }], "isError": true }
                }));
            }
            let resp = call_devtools(port, &name, args);
            if let Some(err) = resp.get("error").and_then(|e| e.as_str()) {
                return Some(json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": { "content": [{ "type": "text", "text": err.to_string() }], "isError": true }
                }));
            }
            let result = resp.get("result").cloned().unwrap_or_else(|| json!(null));
            let text = serde_json::to_string_pretty(&result).unwrap_or_else(|_| String::new());
            Some(json!({
                "jsonrpc": "2.0", "id": id,
                "result": { "content": [{ "type": "text", "text": text }], "isError": false }
            }))
        }
        _ => Some(json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": format!("未知方法: {}", method) }
        })),
    }
}

fn main() {
    let port = devtools_port();
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let t = line.trim();
                if t.is_empty() {
                    continue;
                }
                if let Some(resp) = handle_message(t, port) {
                    if let Ok(s) = serde_json::to_string(&resp) {
                        println!("{}", s);
                        let _ = std::io::stdout().flush();
                    }
                }
            }
            Err(_) => break,
        }
    }
}
