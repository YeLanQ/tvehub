// 应用级偏好：新建项目时默认使用的父目录（“默认项目位置”）。
// 通过后端持久化到应用配置目录（app_config_dir/prefs.json），与最近项目同类，跨重启保留。

import { api } from "../../lib/api";

export async function loadDefaultProjectDir(): Promise<string> {
  try {
    const dir = await api.getDefaultProjectDir();
    return dir ?? "";
  } catch {
    return "";
  }
}

export async function saveDefaultProjectDir(dir: string): Promise<void> {
  try {
    await api.setDefaultProjectDir((dir ?? "").trim());
  } catch {
    // 忽略失败：偏好保存失败不影响本次会话使用
  }
}
