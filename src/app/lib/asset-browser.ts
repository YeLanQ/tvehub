// AssetsPanel 拆解 —— asset-browser：当前目录内容（子目录/文件）的筛选、排序、搜索逻辑。
// 纯函数模块（只依赖 api 的 AssetEntry 类型），不依赖 Vue/面板状态。

import type { AssetEntry } from "../../lib/api";

/** 当前目录内容条目 */
export interface ChildEntry {
  name: string;
  path: string;
  kind: string;
  size: number;
  /** 相对当前目录的路径（搜索结果显示子目录资产时用） */
  relPath: string;
}

/** 资产类型筛选（右上「类型」下拉） */
export const ASSET_TYPE_FILTERS: { id: string; label: string; kinds?: string[] }[] = [
  { id: "all", label: "全部" },
  { id: "scene", label: "场景", kinds: ["scene"] },
  { id: "material", label: "材质", kinds: ["mat", "mat2d"] },
  { id: "shader", label: "着色器", kinds: ["shader", "shader2d"] },
  { id: "ts", label: "脚本", kinds: ["ts"] },
  { id: "json", label: "JSON", kinds: ["json"] },
  { id: "tex", label: "纹理", kinds: ["png", "jpg", "jpeg", "webp", "bmp", "hdr"] },
  { id: "texcube", label: "TextureCube", kinds: ["texcube"] },
  { id: "model", label: "模型", kinds: ["glb", "gltf", "fbx", "obj"] },
  { id: "prefab", label: "预制体", kinds: ["prefab"] },
];

/** 资产 kind 是否命中某类型筛选（"all" 或未注册的筛选 id 一律通过） */
export function assetKindMatches(kind: string, filterId: string): boolean {
  if (filterId === "all") return true;
  const f = ASSET_TYPE_FILTERS.find((t) => t.id === filterId);
  if (!f) return true;
  if (f.kinds) return f.kinds.includes(kind);
  return kind === filterId;
}

/** 当前目录内容：目录在前、文件在后；搜索时递归展示匹配资产。 */
export function listDirectoryChildren(
  assets: AssetEntry[],
  dir: string,
  query: string,
  typeFilterId: string,
  sortBy: string,
): ChildEntry[] {
  const prefix = dir ? `${dir}/` : "";
  const q = query.trim().toLowerCase();
  const dirs = new Map<string, ChildEntry>();
  const files: ChildEntry[] = [];
  const pushDir = (name: string, path: string, relPath: string) => {
    if (!dirs.has(path)) dirs.set(path, { name, path, kind: "dir", size: 0, relPath });
  };
  if (q) {
    for (const a of assets) {
      if (!a.path.startsWith(prefix)) continue;
      const rest = a.path.slice(prefix.length);
      if (!rest) continue;
      const segs = rest.split("/");
      for (let i = 0; i < segs.length - 1; i++) {
        if (segs[i].toLowerCase().includes(q)) {
          pushDir(segs[i], `${prefix}${segs.slice(0, i + 1).join("/")}`, segs.slice(0, i + 1).join("/"));
        }
      }
      const base = segs[segs.length - 1];
      if (base.toLowerCase().includes(q)) {
        if (a.kind === "dir") {
          pushDir(base, a.path, rest);
        } else {
          files.push({ name: base, path: a.path, kind: a.kind, size: a.size, relPath: rest });
        }
      }
    }
  } else {
    for (const a of assets) {
      if (!a.path.startsWith(prefix)) continue;
      const rest = a.path.slice(prefix.length);
      if (!rest) continue;
      if (a.kind === "dir") {
        const idx = rest.indexOf("/");
        if (idx < 0) {
          pushDir(rest, a.path, rest);
        } else {
          pushDir(rest.slice(0, idx), `${prefix}${rest.slice(0, idx)}`, rest.slice(0, idx));
        }
        continue;
      }
      const idx = rest.indexOf("/");
      if (idx >= 0) {
        const name = rest.slice(0, idx);
        pushDir(name, `${prefix}${name}`, name);
      } else {
        files.push({ name: rest, path: a.path, kind: a.kind, size: a.size, relPath: "" });
      }
    }
  }
  const nameCmp = (a: ChildEntry, b: ChildEntry) => a.name.localeCompare(b.name, "zh");
  let fileList = files.filter((f) => assetKindMatches(f.kind, typeFilterId));
  if (sortBy === "type") {
    fileList = [...fileList].sort((a, b) => a.kind.localeCompare(b.kind) || nameCmp(a, b));
  } else if (sortBy === "size") {
    fileList = [...fileList].sort((a, b) => b.size - a.size || nameCmp(a, b));
  } else {
    fileList = [...fileList].sort(nameCmp);
  }
  const dirList = [...dirs.values()].sort(nameCmp);
  return [...dirList, ...fileList];
}