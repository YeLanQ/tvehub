// 资产相对路径工具：资产被移动/重命名后，把引用旧路径的记录
// （当前打开场景 sceneRel、project.config.json 的 mainScene）改写到新路径。
// 同时覆盖整文件匹配与目录匹配（目录被移动时其内部资产的相对路径整体平移）。

/**
 * 路径前缀改写：path 等于 from 或位于 from/ 之下时映射到 to 对应位置，否则返回 null。
 * from/to 均为相对项目根的正斜杠路径，允许目录带尾斜杠。
 */
export function remapAssetPath(path: string, from: string, to: string): string | null {
  const trim = (p: string): string => p.replace(/\/+$/, "");
  const src = trim(from);
  if (!src) return null;
  if (path === src) return trim(to);
  if (path.startsWith(`${src}/`)) return `${trim(to)}${path.slice(src.length)}`;
  return null;
}
