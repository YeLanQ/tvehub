// 材质/着色器资产下拉选项（共享逻辑）：
// Material 卡片与 Skybox 卡片使用同一份实现，保证选择行为完全一致：
// - 内置材质：internal/materials/…（真实目录经 scan_internal_assets 并入 assets 后派生）；
// - 项目材质：assets/… 下的全部 .mat；着色器（.shader）同构（internal/shaders/… + assets/…）。
import { computed, type ComputedRef } from "vue";
import { materialFileStem, shaderFileStem } from "../../framework/material";
import type { AssetEntry } from "../../lib/api";
import { isInternalAsset } from "../../lib/internal-assets";

export interface MaterialOption {
  rel: string;
  name: string;
  internal: boolean;
}

export interface MaterialOptionGroups {
  internal: MaterialOption[];
  project: MaterialOption[];
}

/** 按 kind 派生「内置 + 项目」下拉分组（kind: "mat" 材质 / "shader" 着色器） */
function useKindAssetOptions(
  getAssets: () => readonly AssetEntry[],
  kind: string,
  internalPrefix: string,
  stemOf: (rel: string) => string,
): ComputedRef<MaterialOptionGroups> {
  return computed(() => {
    const seen = new Set<string>();
    const internal: MaterialOption[] = [];
    const project: MaterialOption[] = [];
    for (const a of getAssets()) {
      if (a.kind !== kind) continue;
      if (isInternalAsset(a.path)) {
        if (!a.path.startsWith(internalPrefix) || seen.has(a.path)) continue;
        seen.add(a.path);
        internal.push({ rel: a.path, name: stemOf(a.path), internal: true });
      } else {
        if (!a.path.startsWith("assets/") || seen.has(a.path)) continue;
        seen.add(a.path);
        project.push({ rel: a.path, name: stemOf(a.path), internal: false });
      }
    }
    return { internal, project };
  });
}

/**
 * 材质资产下拉分组选项。
 * @param getAssets 资产平铺列表读取函数（应读取响应式 store；需已合并内置资源，进入 computed 依赖即可自动刷新）
 */
export function useMaterialAssetOptions(
  getAssets: () => readonly AssetEntry[],
): ComputedRef<MaterialOptionGroups> {
  return useKindAssetOptions(getAssets, "mat", "internal/materials/", materialFileStem);
}

/** 着色器资产下拉分组选项（内置 internal/shaders/… + 项目 assets/… 的全部 .shader） */
export function useShaderAssetOptions(
  getAssets: () => readonly AssetEntry[],
): ComputedRef<MaterialOptionGroups> {
  return useKindAssetOptions(getAssets, "shader", "internal/shaders/", shaderFileStem);
}
