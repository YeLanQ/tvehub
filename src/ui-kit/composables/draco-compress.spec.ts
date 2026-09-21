import { describe, expect, it } from "vitest";
import {
  closeDracoCompressDialog,
  dracoCompressState,
  formatBytes,
  openDracoCompressDialog,
} from "./draco-compress";

// Draco 压缩参数弹窗状态机：Promise 语义、缺省值与格式化。

describe("formatBytes", () => {
  it("三级单位与边界值", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.50 MB");
  });
});

describe("openDracoCompressDialog / closeDracoCompressDialog", () => {
  it("open 写入选项与缺省参数；confirm 兑现选择并复位", async () => {
    const p = openDracoCompressDialog({ sourceSize: 2048 });
    expect(dracoCompressState.open).toBe(true);
    expect(dracoCompressState.options.sourceSize).toBe(2048);
    expect(dracoCompressState.options.title).toBe("Draco 压缩"); // 缺省标题
    expect(dracoCompressState.speed).toBe(5);
    expect(dracoCompressState.quality).toBe("standard");

    dracoCompressState.speed = 9;
    dracoCompressState.quality = "high";
    closeDracoCompressDialog({ speed: dracoCompressState.speed, quality: dracoCompressState.quality });
    await expect(p).resolves.toEqual({ speed: 9, quality: "high" });
    expect(dracoCompressState.open).toBe(false);
    expect(dracoCompressState.resolve).toBeNull();
  });

  it("null = 取消语义；再次打开重置缺省（含标题回落）", async () => {
    const p = openDracoCompressDialog({ sourceSize: 1, title: "自定义" });
    dracoCompressState.speed = 0; // 上一次的残留
    closeDracoCompressDialog(null);
    await expect(p).resolves.toBeNull();
    const p2 = openDracoCompressDialog({ sourceSize: 2 });
    expect(dracoCompressState.speed).toBe(5); // 重新打开复位
    expect(dracoCompressState.options.title).toBe("Draco 压缩"); // 不传标题回落缺省
    closeDracoCompressDialog(null);
    await expect(p2).resolves.toBeNull();
  });
});
