//! 请求路由与访问口令闸门：把一条已建立的连接变成响应。
//!
//! 路由：`/` 索引页、`/health` 存活探测、`/api/shares` 清单 JSON、
//! `/s/<id>/...` 站点文件（`/s/<id>/` 走入口文件）。站点内相对路径过 `safe_rel`，
//! 再由 `resolve_in_root` 做越界守卫；任何越界一律 404。
//!
//! 访问口令是可选的轻量闸门（明文 HTTP，只防误入，不构成安全边界）：未通过时回
//! 解锁页，口令经 `?k=` 传入并校验通过后下发 cookie、重定向到不含口令的地址。
use std::fs;
use std::io::Read;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::preview::{find_sub, mime_for, percent_decode};
use crate::project::path::resolve_in_root;

use super::pages::{index_html, unlock_html};
use super::server::{respond, respond_json, respond_text, ServerCtx};
use super::share::{safe_rel, LanShare};

pub(super) struct Gate {
    /// 通过校验后下发的 cookie 值（口令散列，避免明文进 cookie）
    token: String,
}

impl Gate {
    pub(super) fn from_code(code: &str) -> Option<Gate> {
        if code.is_empty() {
            return None;
        }
        Some(Gate {
            token: hash_code(code),
        })
    }

    /// 是否已通过：`?k=<口令>` 或 cookie `tve_lan=<散列>`
    fn unlocked(&self, head: &str, query: &str) -> bool {
        if let Some(k) = query_param(query, "k") {
            if constant_time_eq(&hash_code(&k), &self.token) {
                return true;
            }
        }
        for line in head.lines() {
            let lower = line.to_ascii_lowercase();
            let Some(rest) = lower.strip_prefix("cookie:") else {
                continue;
            };
            for part in rest.split(';') {
                if let Some(value) = part.trim().strip_prefix("tve_lan=") {
                    if constant_time_eq(value, &self.token) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

/// 口令散列（FNV-1a 64）：只为不回传明文，不是密码学强度
fn hash_code(code: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in code.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 定长比较：避免逐字节提前返回（口令短，成本可忽略）
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        if it.next().unwrap_or("") == key {
            return Some(percent_decode(it.next().unwrap_or("")));
        }
    }
    None
}

pub(super) fn handle_connection(mut stream: TcpStream, ctx: Arc<ServerCtx>, gate: Option<Arc<Gate>>) {
    // 阻塞模式 + 读超时：Windows 上 accept 返回的连接会继承监听套接字的非阻塞模式；
    // 不发数据的连接（预连接/探测）不允许永久占住线程
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if find_sub(&buf, b"\r\n\r\n").is_some() || buf.len() > 65536 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if buf.is_empty() {
        return; // 空请求 = 连接探测：直接关闭，不写响应
    }
    let head = String::from_utf8_lossy(&buf).into_owned();
    let request_line = head.lines().next().unwrap_or("").trim().to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        respond_text(&mut stream, "405 Method Not Allowed", "405 Method Not Allowed");
        return;
    }

    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.to_string(), String::new()),
    };
    let client = stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();

    // 口令闸门：/health 与 favicon 放行，其余一律校验
    if let Some(gate) = gate.as_ref() {
        let exempt = path == "/health" || path == "/favicon.ico";
        let supplied = query_param(&query, "k");
        if !exempt && !gate.unlocked(&head, &query) {
            let body = unlock_html(&path, supplied.is_some());
            respond(&mut stream, "401 Unauthorized", "text/html; charset=utf-8", body.as_bytes(), &[]);
            return;
        }
        if !exempt && supplied.is_some() {
            // 口令经 ?k= 传入：下发 cookie 后重定向到不含口令的地址，
            // 避免口令留在浏览器历史与分享出去的链接里
            let cookie = format!("tve_lan={}; Path=/; Max-Age=604800; SameSite=Lax", gate.token);
            respond(
                &mut stream,
                "302 Found",
                "text/plain; charset=utf-8",
                b"",
                &[("Location", path.as_str()), ("Set-Cookie", cookie.as_str())],
            );
            return;
        }
    }

    if path == "/health" {
        respond_text(&mut stream, "200 OK", "ok");
        return;
    }
    if path == "/favicon.ico" {
        respond(&mut stream, "204 No Content", "image/x-icon", b"", &[]);
        return;
    }

    let config = ctx.config.lock().map(|c| c.clone()).unwrap_or_default();
    let shares = ctx.shares.lock().map(|s| s.clone()).unwrap_or_default();

    if path == "/api/shares" {
        let list: Vec<&LanShare> = shares.iter().filter(|s| s.enabled).collect();
        respond_json(&mut stream, &list);
        return;
    }
    if path == "/" {
        let body = index_html(&config, &shares);
        respond(&mut stream, "200 OK", "text/html; charset=utf-8", body.as_bytes(), &[]);
        return;
    }

    // /s/<id>[/rel]
    let Some(rest) = path.strip_prefix("/s/") else {
        respond_text(&mut stream, "404 Not Found", "404 Not Found");
        return;
    };
    let mut segs = rest.splitn(2, '/');
    let id = percent_decode(segs.next().unwrap_or(""));
    let rel_raw = segs.next().unwrap_or("");
    let Some(share) = shares.iter().find(|s| s.id == id && s.enabled).cloned() else {
        respond_text(&mut stream, "404 Not Found", "此共享不存在或已停用");
        return;
    };

    if let Ok(mut stats) = ctx.stats.lock() {
        let stat = stats.entry(share.id.clone()).or_default();
        stat.hits += 1;
        stat.last_access = super::now_ms();
        stat.last_client = client;
    }

    let rel = if rel_raw.is_empty() {
        share.entry.clone()
    } else {
        match safe_rel(rel_raw) {
            Ok(r) => r,
            Err(_) => {
                respond_text(&mut stream, "404 Not Found", "404 Not Found");
                return;
            }
        }
    };
    let root = PathBuf::from(&share.root);
    let Ok(file) = resolve_in_root(&root, &rel) else {
        respond_text(&mut stream, "404 Not Found", "404 Not Found");
        return;
    };
    match fs::read(&file) {
        Ok(body) => respond(&mut stream, "200 OK", mime_for(&file), &body, &[]),
        Err(_) => respond_text(&mut stream, "404 Not Found", "404 Not Found"),
    }
}
