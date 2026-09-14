// ---------------------------------------------------------------------------
// 模型材质域：模型内嵌材质卡（ModelMaterialSection）的动作。
//
// - 替换槽位：先预取目标 .mat（及其着色器）再提交覆盖（避免先默认灰后跳变），
//   与基元材质 Set Material 同套路；
// - 应用提取结果 / 清除覆盖：整体提交覆盖表（一次撤销）；
// - 覆盖表改动经 commit → node.patch → properties 事件 → 同步器重刷实例
//   （refreshModelMesh 复用路径会重放材质覆盖）。
// ---------------------------------------------------------------------------
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import { getEditorStore } from "../../stores/editor";
import type { InspectorNodeApi } from "./useInspectorNode";

export interface InspectorModelMaterialApi {
  onModelMaterialUpdate: (label: string, value: unknown) => void;
}

export function useInspectorModelMaterial(ctx: InspectorNodeApi): InspectorModelMaterialApi {
  const { node, commit } = ctx;

  async function onModelMaterialUpdate(label: string, value: unknown): Promise<void> {
    const n = node.value;
    if (!n || !(n instanceof MeshNode) || n.source !== "model") return;
    const engine = getEditorStore().engine;

    if (label === "Set Model Material Slot") {
      const v = value as { name: string; rel: string };
      if (!v?.name) return;
      if (v.rel) {
        await engine.materials.preload([v.rel]);
        const shaderRel = engine.materials.shaderFor(v.rel);
        if (shaderRel) await engine.shaders.preload([shaderRel]);
      }
      commit((m) => {
        const t = m as MeshNode;
        const next = { ...t.modelMaterialOverrides };
        if (v.rel) next[v.name] = v.rel;
        else delete next[v.name];
        t.modelMaterialOverrides = next;
      }, v.rel ? `替换模型材质: ${v.name}` : `还原模型材质: ${v.name}`);
      return;
    }

    if (label === "Apply Extracted Materials") {
      const mapping = value as Record<string, string>;
      if (!mapping || typeof mapping !== "object") return;
      const rels = [...new Set(Object.values(mapping))];
      await engine.materials.preload(rels);
      const shaders = [...new Set(rels.map((r) => engine.materials.shaderFor(r)).filter((s) => s))];
      if (shaders.length) await engine.shaders.preload(shaders);
      commit((m) => {
        const t = m as MeshNode;
        t.modelMaterialOverrides = { ...t.modelMaterialOverrides, ...mapping };
      }, "应用提取的模型材质");
      return;
    }

    if (label === "Clear Model Material Overrides") {
      if (Object.keys(n.modelMaterialOverrides).length === 0) return;
      commit((m) => {
        (m as MeshNode).modelMaterialOverrides = {};
      }, "还原全部模型材质");
    }
  }

  return { onModelMaterialUpdate };
}
