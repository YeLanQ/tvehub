import * as THREE from "three";
import {
  buildIconSvg,
  CAMERA_ICON_PATHS,
  LIGHT_POINT_ICON_PATHS,
  LIGHT_DIRECTIONAL_ICON_PATHS,
  LIGHT_AMBIENT_ICON_PATHS,
  LIGHT_SPOT_ICON_PATHS,
  AUDIO_ICON_PATHS,
  PARTICLE_ICON_PATHS,
} from "./icons";

export type SpriteIconKind =
  | "camera"
  | "light-point"
  | "light-directional"
  | "light-ambient"
  | "light-spot"
  | "audio"
  | "particle";

const TEXTURE_SIZE = 128;

/** 已解码为 CanvasTexture 的图标缓存（白色线稿，运行时用 SpriteMaterial.color 着色） */
const textureCache = new Map<string, THREE.Texture>();
const pendingLoad = new Map<string, Promise<THREE.Texture>>();

function iconPaths(kind: SpriteIconKind): string[] {
  switch (kind) {
    case "camera":
      return CAMERA_ICON_PATHS;
    case "light-point":
      return LIGHT_POINT_ICON_PATHS;
    case "light-directional":
      return LIGHT_DIRECTIONAL_ICON_PATHS;
    case "light-ambient":
      return LIGHT_AMBIENT_ICON_PATHS;
    case "light-spot":
      return LIGHT_SPOT_ICON_PATHS;
    case "audio":
      return AUDIO_ICON_PATHS;
    case "particle":
      return PARTICLE_ICON_PATHS;
  }
}

function svgDataUri(kind: SpriteIconKind): string {
  const svg = buildIconSvg(iconPaths(kind), {
    size: TEXTURE_SIZE,
    strokeWidth: 2.2,
    stroke: "#ffffff",
  });
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/**
 * 将 SVG 数据 URI 栅格化到 <canvas>，生成带透明通道的 CanvasTexture。
 * 浏览器中 Image 解码为异步：首次加载期间精灵暂时显示纯色点，加载完成即显示图标。
 */
function loadTexture(kind: SpriteIconKind): Promise<THREE.Texture> {
  const cached = textureCache.get(kind);
  if (cached) return Promise.resolve(cached);
  const pending = pendingLoad.get(kind);
  if (pending) return pending;

  const task = new Promise<THREE.Texture>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("no DOM for sprite icon texture"));
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = TEXTURE_SIZE;
        canvas.height = TEXTURE_SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas 2d context unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        textureCache.set(kind, tex);
        resolve(tex);
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error(`sprite icon svg decode failed: ${kind}`));
    img.src = svgDataUri(kind);
  });

  pendingLoad.set(kind, task);
  // catch 先吞掉拒绝再 finally：无 DOM 环境（headless）下 finally 的衍生
  // Promise 若带拒绝会成为未处理拒绝（createIconSprite 的主链已自行兜底）
  void task
    .catch(() => {})
    .finally(() => pendingLoad.delete(kind));
  return task;
}

/**
 * 创建一张摄像机对齐（billboard）的图标精灵。
 * @param kind  "camera" | "light-point" | "light-directional" | "light-ambient" | "light-spot"
 * @param color 图标着色（相机用编辑器强调色、灯光用灯光颜色），纹理为白色线稿被其着色
 * @param scale 世界单位尺寸
 */
export function createIconSprite(
  kind: SpriteIconKind,
  color: number,
  scale: number,
): THREE.Sprite {
  const material = new THREE.SpriteMaterial({
    color,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = `__icon_${kind}`;
  sprite.scale.set(scale, scale, 1);

  loadTexture(kind)
    .then((tex) => {
      if (material.map !== tex) {
        material.map = tex;
        material.needsUpdate = true;
      }
    })
    .catch(() => {
      // 解码失败：保持纯色圆点，不阻塞场景
    });
  return sprite;
}
