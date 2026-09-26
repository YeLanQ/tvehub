import { describe, expect, it } from "vitest";
import {
  decodeDemData,
  demBaseHeights,
  demSig,
  demTerrainFit,
  encodeDemData,
  importDemFile,
  parseTerrainDem,
  resampleGrid,
} from "./dem";
import { parseAscGrid, parseHgt, parsePgm, parseXyzPoints } from "./demFormats";
import { DEFAULT_TERRAIN_SETTINGS, TERRAIN_LIMITS } from "./types";
import { TerrainNode } from "../prototype/nodes/TerrainNode";

// 数字地形数据源：格式解析（ASC/HGT/PGM/XYZ）→ 归一化导入 → 节点持久化 → 基准高度解码。

const ascText = (cols: number, rows: number, gen: (r: number, c: number) => number) =>
  `ncols ${cols}\nnrows ${rows}\nxllcorner 0\nyllcorner 0\ncellsize 1\nnodata_value -9999\n` +
  Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => gen(r, c)).join(" ")).join("\n");

function hgtBuffer(side: number, gen: (i: number) => number): ArrayBuffer {
  const buf = new ArrayBuffer(side * side * 2);
  const view = new DataView(buf);
  for (let i = 0; i < side * side; i++) view.setInt16(i * 2, gen(i), false);
  return buf;
}

describe("格式解析（demFormats）", () => {
  it("正常：ASC 表头 + 行序翻转（首行=北 → 翻转为 z 升序）", () => {
    const g = parseAscGrid(ascText(3, 2, (r, c) => r * 10 + c));
    expect(g.cols).toBe(3);
    expect(g.rows).toBe(2);
    expect(g.heights[0]).toBe(10); // 原末行（r=1,c=0）翻到首行
    expect(g.heights[2]).toBe(12);
    expect(g.heights[5]).toBe(2); // 原首行（r=0,c=2）翻到末行
    expect(g.min).toBe(0);
    expect(g.max).toBe(12);
  });

  it("正常：HGT 大端 int16 方阵 + void 替换", () => {
    const g = parseHgt(hgtBuffer(3, (i) => (i === 4 ? -32768 : i * 100)));
    expect(g.cols).toBe(3);
    expect(g.heights[0]).toBe(0);
    expect(Number.isNaN(g.heights[4])).toBe(true);
    expect(g.max).toBe(800);
  });

  it("边界：PGM 16 位（P5 大端 2 字节）与 8 位归一化语义", () => {
    const head = "P5\n3 2\n65535\n";
    const buf = new ArrayBuffer(head.length + 6 * 2);
    const view = new DataView(buf);
    for (let i = 0; i < head.length; i++) new Uint8Array(buf)[i] = head.charCodeAt(i);
    for (let i = 0; i < 6; i++) view.setUint16(head.length + i * 2, i * 10000, false);
    const g = parsePgm(buf);
    expect(g.heights[5]).toBe(50000);
    expect(g.normalized).toBe(true);
  });

  it("正常：XYZ 散点桶平均栅格化（密度定边长 + 空桶回填）", () => {
    const pts: string[] = [];
    for (let i = 0; i < 400; i++) pts.push(`${i % 20} ${Math.floor(i / 20)} ${(i % 20) + Math.floor(i / 20)}`);
    const g = parseXyzPoints(pts.join("\n"));
    expect(g.cols).toBe(g.rows);
    expect(g.cols).toBeGreaterThanOrEqual(65);
    expect(g.min).toBeGreaterThanOrEqual(0);
    expect(g.max).toBeLessThanOrEqual(19 * 2 + 1);
  });

  it("异常：各格式坏输入抛错不静默", () => {
    expect(() => parseAscGrid("ncols 1\nnrows 1\ncellsize 1\n0")).toThrow();
    expect(() => parseHgt(new ArrayBuffer(10))).toThrow();
    expect(() => parsePgm(new ArrayBuffer(2))).toThrow();
    expect(() => parseXyzPoints("a b c\n1 2")).toThrow();
  });
});

describe("导入管线（importDemFile）", () => {
  it("正常：ASC → 归一化 0..1 内嵌数据（gridN ≤ 513；cellsize 进载荷）", () => {
    const dem = importDemFile("demo.asc", ".asc", () => ascText(4, 4, (r, c) => r * 4 + c), () => new ArrayBuffer(0));
    expect(dem.format).toBe("asc");
    expect(dem.sourceCols).toBe(4);
    expect(dem.gridN).toBeLessThanOrEqual(513);
    expect(dem.sourceCellSize).toBe(1); // ascText 头 cellsize 1
    const norm = decodeDemData(dem.data)!;
    expect(Math.min(...norm)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...norm)).toBeCloseTo(1, 5);
    expect(dem.sourceMin).toBe(0);
    expect(dem.sourceMax).toBe(15);
  });

  it("正常：HGT 二进制入口与 CSV → xyz 语义映射", () => {
    const dem = importDemFile("s.hgt", ".hgt", () => "", () => hgtBuffer(4, (i) => i));
    expect(dem.format).toBe("hgt");
    const csv = importDemFile("p.csv", ".csv", () => Array.from({ length: 90 }, (_, i) => `${i % 9},0,${i}`).join("\n"), () => new ArrayBuffer(0));
    expect(csv.format).toBe("xyz");
  });

  it("异常：未知扩展名抛错", () => {
    expect(() => importDemFile("x.tif", ".tif", () => "", () => new ArrayBuffer(0))).toThrow("不支持");
  });
});

describe("demBaseHeights / resampleGrid / sig", () => {
  it("正常：解码 + 缩放 + 双线性重采样到目标网格", () => {
    const src = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const rs = resampleGrid(src, 3, 5);
    expect(rs[0]).toBe(0);
    expect(rs[24]).toBe(8);
    const dem = { gridN: 3, data: encodeDemData(src), format: "asc" as const, sourceName: "t", sourceCols: 3, sourceRows: 3, sourceMin: 0, sourceMax: 8, sourceCellSize: 1 };
    const base = demBaseHeights(dem, 10, 5)!;
    expect(base[0]).toBe(0);
    expect(base[24]).toBeCloseTo(80, 5);
  });

  it("空值/异常：损坏 base64 / 长度不符 → null；sig 对 dem 与 null 可区分", () => {
    expect(decodeDemData("!!!not-base64!!!")).toBeNull();
    const bad = parseTerrainDem({ gridN: 3, data: encodeDemData(new Float32Array(9)), format: "asc", sourceName: "x", sourceCols: 3, sourceRows: 3, sourceMin: 0, sourceMax: 1, sourceCellSize: 1 })!;
    expect(demBaseHeights({ ...bad, gridN: 5 }, 1, 5)).toBeNull();
    expect(demSig(null)).toBe("nodem");
    expect(demSig(bad)).not.toBe("nodem");
    expect(demSig({ ...bad, data: bad.data + "AA" })).not.toBe(demSig(bad));
  });
});

describe("demTerrainFit（导入比例自动适配）", () => {
  const dem = (over: Partial<Parameters<typeof demTerrainFit>[0]> = {}) =>
    ({
      gridN: 65, data: "", format: "asc", sourceName: "d.asc",
      sourceCols: 512, sourceRows: 512, sourceMin: 233, sourceMax: 1665.9, sourceCellSize: 30,
      ...over,
    }) as Parameters<typeof demTerrainFit>[0];

  it("正常：默认参数节点 → 高度=源起伏 1432.9、尺寸=源覆盖 15360 钳到上限 2000，含说明", () => {
    const fit = demTerrainFit(dem(), { heightScale: DEFAULT_TERRAIN_SETTINGS.heightScale, size: DEFAULT_TERRAIN_SETTINGS.size });
    expect(fit.heightScale).toBe(1432.9);
    expect(fit.size).toBe(TERRAIN_LIMITS.size.max);
    expect(fit.advisory).toContain("Height Scale");
    expect(fit.advisory).toContain("超出地形尺寸上限");
  });

  it("边界：源覆盖在上限内 → 尺寸精确取源值；pgm/xyz（cellSize=0）不改尺寸", () => {
    const small = dem({ sourceCols: 40, sourceCellSize: 30, sourceMin: 100, sourceMax: 500 });
    const fit = demTerrainFit(small, { heightScale: DEFAULT_TERRAIN_SETTINGS.heightScale, size: DEFAULT_TERRAIN_SETTINGS.size });
    expect(fit.size).toBe(1200);
    const noGeo = dem({ sourceCellSize: 0, sourceMin: 100, sourceMax: 500 });
    const fit2 = demTerrainFit(noGeo, { heightScale: DEFAULT_TERRAIN_SETTINGS.heightScale, size: DEFAULT_TERRAIN_SETTINGS.size });
    expect(fit2.size).toBeUndefined();
    expect(fit2.heightScale).toBe(400);
  });

  it("空值/尊重用户：heightScale 或 size 已被定制 → 对应字段不改写", () => {
    const fit = demTerrainFit(dem(), { heightScale: 300, size: DEFAULT_TERRAIN_SETTINGS.size });
    expect(fit.heightScale).toBeUndefined();
    expect(fit.size).toBe(TERRAIN_LIMITS.size.max);
    const fit2 = demTerrainFit(dem(), { heightScale: 300, size: 800 });
    expect(fit2.heightScale).toBeUndefined();
    expect(fit2.size).toBeUndefined();
    expect(fit2.advisory).toBe("");
  });

  it("异常：退化起伏（min==max）按 1m 下限防零", () => {
    const flat = dem({ sourceMin: 500, sourceMax: 500 });
    const fit = demTerrainFit(flat, { heightScale: DEFAULT_TERRAIN_SETTINGS.heightScale, size: DEFAULT_TERRAIN_SETTINGS.size });
    expect(fit.heightScale).toBe(1);
  });
});

describe("TerrainNode.dem 持久化", () => {
  it("正常：写入 → toJSON → readOwnData 往返保持", () => {
    const n = new TerrainNode();
    n.dem = parseTerrainDem({
      gridN: 5, data: encodeDemData(new Float32Array(25).fill(0.5)),
      format: "hgt", sourceName: "srtm.hgt", sourceCols: 1201, sourceRows: 1201, sourceMin: 100, sourceMax: 900, sourceCellSize: 30,
    });
    const json = n.toJSON() as Record<string, unknown>;
    expect((json.dem as { gridN: number }).gridN).toBe(5);
    const restored = new TerrainNode();
    restored.applyJSON(json);
    expect(restored.dem?.format).toBe("hgt");
    expect(restored.dem?.sourceCols).toBe(1201);
  });

  it("空值：无 dem 的旧场景序列化不含 dem 字段；非法 dem 读回 null", () => {
    const plain = new TerrainNode().toJSON() as Record<string, unknown>;
    expect("dem" in plain).toBe(false);
    const n = new TerrainNode();
    n.applyJSON({ terrain: plain.terrain, dem: { gridN: 1, data: "" } });
    expect(n.dem).toBeNull();
  });
});
