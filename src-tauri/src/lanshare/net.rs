//! 本机局域网地址发现：决定「二维码该编哪个地址」。
//!
//! 两个来源合并去重：
//! 1. **默认路由探测**：UDP connect 不发包，只让内核按路由表选源地址，
//!    因此不依赖目标可达，离线环境同样能判断出「出网那张网卡」的地址；
//! 2. **系统网卡清单**：Windows 解析 `ipconfig` 输出。多网卡（有线 + 无线 +
//!    虚拟网卡）只有这条能补全，探测只能给出默认路由那一个。
//!
//! 排序：默认路由地址 → 其它私网地址 → 公网地址。前端取第一条作二维码内容。

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

use serde::Serialize;

/// 一个候选局域网地址
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanAddress {
    pub ip: String,
    /// 默认路由所在地址（同网段设备最可能访问到的那个）
    pub primary: bool,
    /// 私有网段（10/8、172.16/12、192.168/16）
    pub private: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanNetInfo {
    pub hostname: String,
    pub device_name: String,
    pub addresses: Vec<LanAddress>,
}

/// 探测本机在通往 `target` 的路由上的源地址（失败 = 该路由不可用）
fn probe_local_ip(target: &str) -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect(target).ok()?;
    match socket.local_addr().ok()? {
        SocketAddr::V4(addr) => Some(*addr.ip()),
        SocketAddr::V6(_) => None,
    }
}

/// 默认路由地址（探测目标覆盖公网 DNS 与常见私网网关，任一成功即可）
pub(super) fn default_route_ip() -> Option<Ipv4Addr> {
    const PROBES: [&str; 7] = [
        "8.8.8.8:80",
        "1.1.1.1:80",
        "114.114.114.114:53",
        "192.168.1.1:80",
        "192.168.0.1:80",
        "10.0.0.1:80",
        "172.16.0.1:80",
    ];
    PROBES.iter().find_map(|target| {
        probe_local_ip(target).filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
    })
}

/// 私网地址判定
pub(super) fn is_private_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168)
}

/// 地址是否值得对外发布：排除回环、未指定、169.254 链路本地（APIPA 无法被访问）
fn usable(ip: &Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_unspecified() && ip.octets()[0] != 169
}

/// 系统当前 IPv4 列表。解析只认 "IPv4" 这个 ASCII 标记与点分十进制字面量，
/// 因此中文系统（"IPv4 地址 . . . : 192.168.1.5"）同样适用。
#[cfg(windows)]
fn system_ipv4s() -> Vec<Ipv4Addr> {
    // release 主程序是 GUI 子系统（无控制台可继承）：裸起 ipconfig 会让每次
    // 调用都弹出一个黑色控制台空窗（共享页每条 lan_share_* 命令开头都要探测
    // 网卡，用户看到的就是「切一次页签 / 点一次开关就弹一窗」）。
    // CREATE_NO_WINDOW 让子进程静默执行；dev 下从终端启动本就无此问题。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = std::process::Command::new("ipconfig");
    cmd.arg("/all");
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut found = Vec::new();
    for line in text.lines() {
        if !line.contains("IPv4") {
            continue;
        }
        let bytes = line.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if !bytes[i].is_ascii_digit() {
                i += 1;
                continue;
            }
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            if let Ok(ip) = line[start..i].parse::<Ipv4Addr>() {
                found.push(ip);
            }
        }
    }
    found
}

#[cfg(not(windows))]
fn system_ipv4s() -> Vec<Ipv4Addr> {
    // 其它平台暂不外调命令：默认路由探测已能给出主要地址
    Vec::new()
}

/// 可供同网段访问的地址列表（去重 + 排序）
pub(super) fn discover_addresses() -> Vec<Ipv4Addr> {
    let primary = default_route_ip();
    let mut all: Vec<Ipv4Addr> = Vec::new();
    for ip in primary.into_iter().chain(system_ipv4s()) {
        if usable(&ip) && !all.contains(&ip) {
            all.push(ip);
        }
    }
    all.sort_by_key(|ip| {
        let rank = if Some(*ip) == primary {
            0
        } else if is_private_v4(*ip) {
            1
        } else {
            2
        };
        (rank, ip.octets())
    });
    all
}

/// 带标记的地址清单（无地址时返回空表，由调用方兜底）
pub(super) fn addresses_info() -> Vec<LanAddress> {
    let primary = default_route_ip();
    discover_addresses()
        .into_iter()
        .map(|ip| LanAddress {
            ip: ip.to_string(),
            primary: Some(ip) == primary,
            private: is_private_v4(ip),
        })
        .collect()
}

/// 网络信息（含主机名与设备名）
pub(super) fn net_info(device_name: &str) -> LanNetInfo {
    let hostname = std::env::var(if cfg!(windows) { "COMPUTERNAME" } else { "HOSTNAME" })
        .unwrap_or_default();
    LanNetInfo {
        hostname,
        device_name: device_name.to_string(),
        addresses: addresses_info(),
    }
}

/// 便于单测：把 IpAddr 收敛成 Ipv4
#[allow(dead_code)]
pub(super) fn as_v4(ip: IpAddr) -> Option<Ipv4Addr> {
    match ip {
        IpAddr::V4(v4) => Some(v4),
        IpAddr::V6(_) => None,
    }
}
