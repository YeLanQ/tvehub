// ---------------------------------------------------------------------------
// 编辑器内置资源（internal/…）：编辑器随附的只读内置资产。
// 源文件位于仓库 public/internal/ 下（前端开发/网页预览同源可取用），
// 这里经 include_str! 在编译期内嵌同一份内容，运行时由前端命令读取，
// 保证 dev 与打包产物都能无网络地取到内置内容。
// ---------------------------------------------------------------------------

/// 内置材质清单：(相对路径, 文件内容)。约定以 "internal/" 为根（与 LQEN 一致）。
/// internal 只保留引擎必需的系统材质（网格未指定材质时的默认回退）；
/// 配色类材质由用户复制到项目 assets/materials/ 后自行编辑，不作为内置资产。
pub const INTERNAL_MATERIALS: &[(&str, &str)] = &[(
    "internal/materials/Default.mat",
    include_str!("../../public/internal/materials/Default.mat"),
)];

/// 读取内置资源文件内容（rel 为 "internal/…" 相对路径；只读，不支持写入）。
#[tauri::command]
pub fn read_internal_asset(rel: String) -> Result<String, String> {
    INTERNAL_MATERIALS
        .iter()
        .find(|(p, _)| *p == rel)
        .map(|(_, content)| content.to_string())
        .ok_or_else(|| format!("内置资源不存在: {}", rel))
}
