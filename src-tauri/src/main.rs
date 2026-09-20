// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 子进程模式：--preview-server <port> <root>
    // 预览服务器在独立进程中运行，崩溃不影响主应用
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 && args[1] == "--preview-server" {
        let port: u16 = args[2].parse().unwrap_or(39110);
        let root = std::path::PathBuf::from(&args[3]);
        tve_hub_lib::preview::run_preview_server_mode(port, root);
        return;
    }
    tve_hub_lib::run()
}
