import { reactive } from "vue";

export interface DracoCompressDialogOptions {
  title?: string;
  /** 源文件大小（字节，展示用） */
  sourceSize: number;
  confirmText?: string;
  cancelText?: string;
}

export interface DracoCompressSelection {
  /** Draco 编码速度 0（最慢，压缩率最高）–10（最快） */
  speed: number;
  /** 量化档位：standard = WebGL 友好标准位宽；high = 高精度（体积略大） */
  quality: "standard" | "high";
}

interface DracoCompressDialogState {
  open: boolean;
  options: DracoCompressDialogOptions;
  speed: number;
  quality: DracoCompressSelection["quality"];
  resolve: ((value: DracoCompressSelection | null) => void) | null;
}

export const dracoCompressState = reactive<DracoCompressDialogState>({
  open: false,
  options: { title: "", sourceSize: 0 },
  speed: 5,
  quality: "standard",
  resolve: null,
});

/** 字节数 → 可读大小（弹窗与结果提示共用） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** 打开「Draco 压缩」参数弹窗；确认返回参数，取消返回 null */
export function openDracoCompressDialog(
  options: DracoCompressDialogOptions,
): Promise<DracoCompressSelection | null> {
  return new Promise((resolve) => {
    dracoCompressState.options = {
      title: "Draco 压缩",
      confirmText: "开始压缩",
      cancelText: "取消",
      ...options,
    };
    dracoCompressState.speed = 5;
    dracoCompressState.quality = "standard";
    dracoCompressState.resolve = resolve;
    dracoCompressState.open = true;
  });
}

export function closeDracoCompressDialog(result: DracoCompressSelection | null) {
  const r = dracoCompressState.resolve;
  dracoCompressState.open = false;
  dracoCompressState.resolve = null;
  r?.(result);
}
