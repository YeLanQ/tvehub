//! 把文件/目录移入系统回收站（垃圾篓）。
//! Windows：直接调用 shell32 的 `SHFileOperationW`（FO_DELETE + FOF_ALLOWUNDO），
//! 不依赖任何第三方 crate；其它平台暂不支持（返回错误）。

/// 把 `path` 移入系统回收站。成功返回 `Ok(())`。
pub fn move_to_trash(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_move_to_trash(path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("当前平台暂不支持移入回收站".to_string())
    }
}

#[cfg(target_os = "windows")]
fn windows_move_to_trash(path: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    // SHFILEOPSTRUCTW 常量（shell32）
    const FO_DELETE: u32 = 0x0003;
    /// 允许撤销 → 移入回收站（而非永久删除）
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_SILENT: u16 = 0x0004;
    const FOF_NOERRORUI: u16 = 0x0400;

    #[repr(C)]
    struct SHFILEOPSTRUCTW {
        hwnd: *mut core::ffi::c_void,
        w_func: u32,
        p_from: *const u16,
        p_to: *const u16,
        f_flags: u16,
        f_any_operations_aborted: i32,
        h_name_mappings: *mut core::ffi::c_void,
        lpsz_progress_title: *const u16,
    }

    #[link(name = "shell32")]
    extern "system" {
        fn SHFileOperationW(lp_file_op: *mut SHFILEOPSTRUCTW) -> i32;
    }

    // pFrom 需要双 null 结尾的 UTF-16 字符串
    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .chain(std::iter::once(0))
        .collect();

    let mut op = SHFILEOPSTRUCTW {
        hwnd: ptr::null_mut(),
        w_func: FO_DELETE,
        p_from: wide.as_ptr(),
        p_to: ptr::null(),
        f_flags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
        f_any_operations_aborted: 0,
        h_name_mappings: ptr::null_mut(),
        lpsz_progress_title: ptr::null(),
    };

    // SAFETY: op 各字段有效；p_from 指向双 null 结尾的 UTF-16；SHFileOperationW 同步阻塞执行
    let code = unsafe { SHFileOperationW(&mut op) };
    if code == 0 && op.f_any_operations_aborted == 0 {
        Ok(())
    } else {
        Err(format!("移入回收站失败（SHFileOperationW 返回 {code}）"))
    }
}