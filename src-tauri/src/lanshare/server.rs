//! 局域网上常驻的极简静态服务：起停、连接接入（accept 循环 + 每连接一线程）与响应写出。
//!
//! 请求怎么路由、访问口令怎么校验，见 [`super::routes`]；这里只管「把监听套接字跑
//! 起来、把每条连接交给路由、把响应字节写回去」。
//!
//! HTTP 细节（读头、路径解码、MIME）复用 `preview.rs` 里已被验证的实现，避免出现
//! 两份各自漏坑的解析代码；响应写入沿用其 Windows 语义（半关闭代替 drop，避免
//! 带未读入站数据时内核发 RST 截断响应）。服务只读不写，只暴露被共享目录下的文件。

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;

use super::config::LanShareConfig;
use super::routes::Gate;
use super::share::LanShare;
use super::{AccessStat, LanShareInner, RunningServer};

/// 服务线程读的上下文（与状态分开持有：请求处理只碰这几个 Arc，不碰外层状态锁）
pub(super) struct ServerCtx {
    pub(super) config: Arc<Mutex<LanShareConfig>>,
    pub(super) shares: Arc<Mutex<Vec<LanShare>>>,
    pub(super) stats: Arc<Mutex<HashMap<String, AccessStat>>>,
}

/// 访问口令闸门（口令为空时不建闸门，全部放行）
// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------

/// 起服：优先配置端口，被占用则回退系统分配（端口变化经 notice 告知用户）
pub(super) fn start(
    inner: &LanShareInner,
    config: LanShareConfig,
) -> Result<(RunningServer, Option<String>), String> {
    let ctx = Arc::new(ServerCtx {
        config: inner.config.clone(),
        shares: inner.shares.clone(),
        stats: inner.stats.clone(),
    });
    let gate = Gate::from_code(&config.access_code).map(Arc::new);
    let bind_host = config.host.parse::<Ipv4Addr>().ok();
    spawn(bind_host, config.port, ctx, gate)
}

fn spawn(
    bind_host: Option<Ipv4Addr>,
    port: u16,
    ctx: Arc<ServerCtx>,
    gate: Option<Arc<Gate>>,
) -> Result<(RunningServer, Option<String>), String> {
    let ip = bind_host.map(IpAddr::V4).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    let addr = SocketAddr::new(ip, port);
    let (listener, notice) = match TcpListener::bind(addr) {
        Ok(l) => (l, None),
        Err(e) if port != 0 => {
            let fallback =
                TcpListener::bind(SocketAddr::new(ip, 0)).map_err(|e2| format!("绑定端口失败: {e2}"))?;
            let actual = fallback.local_addr().map(|a| a.port()).unwrap_or(0);
            (fallback, Some(format!("端口 {port} 不可用（{e}），已改用 {actual}")))
        }
        Err(e) => return Err(format!("绑定端口失败: {e}")),
    };
    let bound = listener.local_addr().map_err(|e| e.to_string())?;
    let shutdown = Arc::new(AtomicBool::new(false));
    let flag = shutdown.clone();
    let handle = thread::spawn(move || accept_loop(listener, ctx, gate, flag));
    Ok((RunningServer::new(bound, shutdown, handle), notice))
}

fn accept_loop(
    listener: TcpListener,
    ctx: Arc<ServerCtx>,
    gate: Option<Arc<Gate>>,
    shutdown: Arc<AtomicBool>,
) {
    let _ = listener.set_nonblocking(true);
    while !shutdown.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let ctx = ctx.clone();
                let gate = gate.clone();
                thread::spawn(move || super::routes::handle_connection(stream, ctx, gate));
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(8));
            }
            Err(_) => thread::sleep(Duration::from_millis(20)),
        }
    }
}

// ---------------------------------------------------------------------------
// 请求处理
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

pub(super) fn respond(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    extra_headers: &[(&str, &str)],
) {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in extra_headers {
        head.push_str(k);
        head.push_str(": ");
        head.push_str(v);
        head.push_str("\r\n");
    }
    // 共享内容可能被跨源页面读取（含 file:// 打开的页面），统一放开 CORS；不涉及凭证
    head.push_str("Access-Control-Allow-Origin: *\r\n\r\n");

    let mut out = Vec::with_capacity(head.len() + body.len());
    out.extend_from_slice(head.as_bytes());
    out.extend_from_slice(body);
    let _ = stream.set_nodelay(true);
    let _ = stream.write_all(&out);
    let _ = stream.flush();
    // 显式半关闭代替直接 drop：Windows 上带未读入站数据时 drop 会让内核发 RST，
    // 把刚写出的响应一起掐断
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
    let mut sink = [0u8; 1024];
    while matches!(stream.read(&mut sink), Ok(n) if n > 0) {}
}

pub(super) fn respond_json<T: Serialize>(stream: &mut TcpStream, value: &T) {
    match serde_json::to_vec(value) {
        Ok(body) => respond(stream, "200 OK", "application/json; charset=utf-8", &body, &[]),
        Err(_) => respond_text(stream, "500 Internal Server Error", "500"),
    }
}

pub(super) fn respond_text(stream: &mut TcpStream, status: &str, text: &str) {
    respond(stream, status, "text/plain; charset=utf-8", text.as_bytes(), &[]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lanshare::routes::Gate;
    use std::fs;
    use std::path::PathBuf;
    use std::path::Path;
    use std::sync::atomic::AtomicUsize;

    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tve-lanshare-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 测试用服务：回环地址 + 随机端口；闸门按传入配置的访问口令决定有无
    struct Harness {
        bound: SocketAddr,
        shutdown: Arc<AtomicBool>,
        dir: PathBuf,
    }

    impl Harness {
        fn start(root: PathBuf, shares: Vec<LanShare>, config: LanShareConfig) -> Harness {
            let gate = Gate::from_code(&config.access_code).map(Arc::new);
            let ctx = Arc::new(ServerCtx {
                config: Arc::new(Mutex::new(config)),
                shares: Arc::new(Mutex::new(shares)),
                stats: Arc::new(Mutex::new(HashMap::new())),
            });
            let listener = TcpListener::bind("127.0.0.1:0").expect("绑定回环");
            let bound = listener.local_addr().expect("读地址");
            let shutdown = Arc::new(AtomicBool::new(false));
            let flag = shutdown.clone();
            thread::spawn(move || accept_loop(listener, ctx, gate, flag));
            Harness {
                bound,
                shutdown,
                dir: root,
            }
        }

        /// 发一个 GET，返回完整响应文本（含状态行与头）
        fn get(&self, path: &str, cookie: Option<&str>) -> String {
            let mut stream = TcpStream::connect(self.bound).expect("连接测试服务");
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut req = format!("GET {path} HTTP/1.1\r\nHost: test\r\n");
            if let Some(c) = cookie {
                req.push_str(&format!("Cookie: {c}\r\n"));
            }
            req.push_str("\r\n");
            stream.write_all(req.as_bytes()).expect("写请求");
            let mut out = Vec::new();
            let _ = stream.read_to_end(&mut out);
            String::from_utf8_lossy(&out).into_owned()
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.shutdown.store(true, Ordering::Relaxed);
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn make_share(dir: &Path, entry: &str) -> LanShare {
        LanShare {
            id: "abc12345".into(),
            kind: "site".into(),
            title: "测试<共享>".into(),
            note: String::new(),
            source: "test".into(),
            entry: entry.into(),
            root: dir.display().to_string(),
            managed: false,
            enabled: true,
            created_at: 0,
            updated_at: 0,
            file_count: 1,
            size: 10,
            hits: 0,
            last_access: 0,
            last_client: String::new(),
        }
    }

    #[test]
    fn routes_serve_index_health_api_and_files() {
        let dir = temp_dir("routes");
        fs::write(dir.join("index.html"), "<h1>hello</h1>").unwrap();
        fs::write(dir.join("style.css"), "body{}").unwrap();
        let mut config = LanShareConfig::default();
        config.device_name = "我的电脑".into();
        config.access_code = String::new();
        let h = Harness::start(dir.clone(), vec![make_share(&dir, "index.html")], config);

        let health = h.get("/health", None);
        assert!(health.starts_with("HTTP/1.1 200 OK"), "{health}");
        assert!(health.ends_with("ok"), "{health}");

        let index = h.get("/", None);
        assert!(index.contains("我的电脑"), "索引页含设备名");
        assert!(index.contains("测试&lt;共享&gt;"), "索引页转义了标题");

        let entry = h.get("/s/abc12345/", None);
        assert!(entry.contains("200 OK") && entry.ends_with("<h1>hello</h1>"), "{entry}");

        let css = h.get("/s/abc12345/style.css", None);
        assert!(css.contains("text/css"), "MIME 正确: {css}");
        assert!(css.ends_with("body{}"), "{css}");

        let api = h.get("/api/shares", None);
        assert!(api.contains("abc12345") && api.contains("application/json"), "{api}");

        assert!(h.get("/s/abc12345/missing.txt", None).contains("404"));
        assert!(h.get("/s/nosuchid/", None).contains("404"));
        assert!(h.get("/s/abc12345/../../index.json", None).contains("404"), "越界必须 404");
        assert!(h.get("/s/abc12345/%2e%2e/%2e%2e/index.json", None).contains("404"), "编码越界必须 404");
    }

    #[test]
    fn disabled_share_is_not_reachable() {
        let dir = temp_dir("disabled");
        fs::write(dir.join("index.html"), "x").unwrap();
        let mut share = make_share(&dir, "index.html");
        share.enabled = false;
        let mut config = LanShareConfig::default();
        config.access_code = String::new();
        let h = Harness::start(dir.clone(), vec![share], config);
        assert!(h.get("/s/abc12345/", None).contains("404"));
        let api = h.get("/api/shares", None);
        assert!(api.ends_with("[]"), "停用项不进清单: {api}");
        let index = h.get("/", None);
        assert!(index.contains("没有共享内容"), "{index}");
    }

    #[test]
    fn access_code_gate_blocks_then_unlocks() {
        let dir = temp_dir("gate");
        fs::write(dir.join("index.html"), "<h1>secret</h1>").unwrap();
        let mut config = LanShareConfig::default();
        config.access_code = "s3cret".into();
        let h = Harness::start(dir.clone(), vec![make_share(&dir, "index.html")], config);

        let blocked = h.get("/s/abc12345/", None);
        assert!(blocked.contains("401 Unauthorized"), "{blocked}");
        assert!(blocked.contains("请输入访问口令"), "{blocked}");
        assert!(!blocked.contains("secret"), "未通过口令不得泄露内容");

        // 口令错误：仍回解锁页
        assert!(h.get("/s/abc12345/?k=wrong", None).contains("401"));

        // 口令正确：302 + Set-Cookie
        let ok = h.get("/s/abc12345/?k=s3cret", None);
        assert!(ok.contains("302 Found"), "{ok}");
        assert!(ok.contains("Set-Cookie: tve_lan="), "{ok}");

        // 带 cookie 访问：放行
        let token = ok
            .lines()
            .find_map(|l| l.trim().strip_prefix("Set-Cookie: tve_lan="))
            .and_then(|v| v.split(';').next())
            .expect("取到 cookie")
            .to_string();
        let unlocked = h.get("/s/abc12345/", Some(&format!("tve_lan={token}")));
        assert!(unlocked.contains("200 OK") && unlocked.ends_with("<h1>secret</h1>"), "{unlocked}");

        // /health 不受闸门影响（外部探测用）
        assert!(h.get("/health", None).starts_with("HTTP/1.1 200 OK"));
    }

    #[test]
    fn non_get_is_rejected() {
        let dir = temp_dir("method");
        let mut config = LanShareConfig::default();
        config.access_code = String::new();
        let h = Harness::start(dir.clone(), vec![], config);
        let mut stream = TcpStream::connect(h.bound).unwrap();
        stream.write_all(b"POST / HTTP/1.1\r\nHost: t\r\nContent-Length: 0\r\n\r\n").unwrap();
        let mut out = Vec::new();
        let _ = stream.read_to_end(&mut out);
        assert!(String::from_utf8_lossy(&out).contains("405"));
    }
}
