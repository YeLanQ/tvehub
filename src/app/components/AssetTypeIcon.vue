<script setup lang="ts">
/**
 * 资产类型 SVG 图标（简洁线稿风格，24×24 viewBox，随 currentColor 着色）：
 * 目录 / 场景 / 脚本 / 材质 / 纹理 / 模型 / 着色器 / 相机 / 灯光 / 其它文件。
 * 相机与灯光路径与 3D 视口节点图标共用（framework/engine/modules/helpers/icons）。
 */
import {
  CAMERA_ICON_PATHS,
  LIGHT_POINT_ICON_PATHS,
  LIGHT_DIRECTIONAL_ICON_PATHS,
  LIGHT_AMBIENT_ICON_PATHS,
} from "../../framework/engine/modules/helpers/icons";

defineProps<{ kind: string }>();
</script>

<template>
  <svg
    class="asset-type-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- 目录 -->
    <template v-if="kind === 'dir'">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </template>

    <!-- 场景（.scene）：场记板 -->
    <template v-else-if="kind === 'scene'">
      <path d="M3 6h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
      <path d="M3 10h18" />
      <path d="M7 6l-1.6 4M12 6l-1.6 4M17 6l-1.6 4" />
    </template>

    <!-- 脚本（.ts）：带代码行的文档 -->
    <template v-else-if="kind === 'ts'">
      <path d="M6 3h9l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M9 12h7M9 16h5" />
    </template>

    <!-- 材质（.mat）：材质球 -->
    <template v-else-if="kind === 'mat' || kind === 'mat2d'">
      <circle cx="12" cy="12" r="8" />
      <path d="M6.2 9.2c2.1 3.2 5.2 4.6 8.4 4.2" />
    </template>

    <!-- 纹理：图片（山 + 太阳） -->
    <template v-else-if="kind === 'png' || kind === 'jpg' || kind === 'jpeg' || kind === 'webp' || kind === 'bmp' || kind === 'hdr'">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="9" r="1.7" />
      <path d="M4 17.5l4.2-4.2 3 3 3.2-3.2 5 4.6" />
    </template>

    <!-- TextureCube（.texcube）：立方体贴图（线框立方体 + 顶面取样点） -->
    <template v-else-if="kind === 'texcube'">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
      <circle cx="12" cy="7.4" r="1.3" />
    </template>

    <!-- 模型：线框立方体 -->
    <template v-else-if="kind === 'glb' || kind === 'gltf' || kind === 'fbx' || kind === 'obj'">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </template>

    <!-- 着色器：尖括号代码 -->
    <template v-else-if="kind === 'shader' || kind === 'shader2d'">
      <path d="M8.5 7.5L4 12l4.5 4.5" />
      <path d="M15.5 7.5L20 12l-4.5 4.5" />
    </template>

    <!-- 相机：相机机身 + 镜头 -->
    <template v-else-if="kind === 'camera'">
      <path v-for="d in CAMERA_ICON_PATHS" :key="d" :d="d" />
    </template>

    <!-- 灯光：点光 = 灯泡 / 平行光 = 太阳 / 环境光 = 球体 -->
    <template v-else-if="kind === 'light' || kind === 'light:point'">
      <path v-for="d in LIGHT_POINT_ICON_PATHS" :key="d" :d="d" />
    </template>
    <template v-else-if="kind === 'light:directional'">
      <path v-for="d in LIGHT_DIRECTIONAL_ICON_PATHS" :key="d" :d="d" />
    </template>
    <template v-else-if="kind === 'light:ambient'">
      <path v-for="d in LIGHT_AMBIENT_ICON_PATHS" :key="d" :d="d" />
    </template>

    <!-- 其它文件：带折角的文档 -->
    <template v-else>
      <path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v4h4" />
    </template>
  </svg>
</template>

<style scoped>
.asset-type-icon {
  display: block;
  width: 100%;
  height: 100%;
}
</style>