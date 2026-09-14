// 构建产物资产加载（压缩/内联归档）：
// - parseArchive：解析 assets.gzip 解压后的帧格式（u32 条数 LE +
//   每条 [u32 pathLen][path][u32 dataLen][data]），得到 相对路径 → 字节表；
// - gunzip：浏览器原生 DecompressionStream 解压（无需服务器配合）；
// - installAssetShim：安装 window.fetch 拦截，命中内存资产的请求直接返回 Response，
//   其余请求透传原生 fetch——player 与 libs 各模块的资产读取代码无需感知产物形态
//   （多文件/单页、gzip/非 gzip 统一按相对路径 fetch）。

/** base64 → 字节（单页内联数据用；大字符串分块解码避免参数长度限制） */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** gzip 解压（浏览器原生 DecompressionStream；不支持时抛错） */
export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 解析归档帧格式（输入为已解压字节） */
export function parseArchive(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const count = view.getUint32(off, true);
  off += 4;
  const map = new Map();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const pathLen = view.getUint32(off, true);
    off += 4;
    const path = dec.decode(bytes.subarray(off, off + pathLen));
    off += pathLen;
    const dataLen = view.getUint32(off, true);
    off += 4;
    map.set(path, bytes.slice(off, off + dataLen));
    off += dataLen;
  }
  return map;
}

/** 安装 fetch 拦截：同源相对路径命中内存资产 → Response；其余透传原生 fetch。
 *  命中项每次返回数据副本（Response 消费后不可复用）。
 *  key 匹配两次尝试：整段 pathname（服务器根部署）与入口页目录的相对路径
 *  （子路径部署 / file:// 双击打开——此时 pathname 是完整磁盘路径）。 */
export function installAssetShim(map) {
  if (window.__tveAssetShimInstalled) return;
  window.__tveAssetShimInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (typeof url === "string" && !init?.body) {
        const u = new URL(url, location.href);
        if (u.origin === location.origin || u.protocol === "file:") {
          const path = decodeURIComponent(u.pathname);
          const keys = [path.replace(/^\/+/, "")];
          const base = location.pathname.replace(/[^/]*$/, "");
          if (path.startsWith(base)) keys.push(path.slice(base.length).replace(/^\/+/, ""));
          for (const key of keys) {
            const hit = map.get(key);
            if (hit) return Promise.resolve(new Response(hit.slice()));
          }
        }
      }
    } catch {
      /* URL 解析失败按原样透传 */
    }
    return nativeFetch(input, init);
  };
}
