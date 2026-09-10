// ---------------------------------------------------------------------------
// 灯光与音频域：灯光组件卡（LightComponentFields）、音源组件卡
// （AudioSection，按 compId 定位）的字段编辑，以及灯光节点卡（LightSection）
// 与音源节点卡（AudioSection）的字段编辑——节点卡与组件卡共用标签语义。
//
// 协作：只依赖 useInspectorNode 返回的 ctx（node / commit），域之间互不引用。
// 编辑走 commit → mutateNode（整节点快照进撤销历史），标签文案即历史文案；
// 运行时控制（模拟条、播放）由卡片直连引擎，不经这里。
//
// 背景：从 InspectorPanel.vue 抽出的灯光/音频部分，逐字搬运（含 instanceof
// 类型门控、Math.max/min 收敛与各默认值）。
// ---------------------------------------------------------------------------
import {
  AudioNode,
  DirectionalLightNode,
  LightNode,
  PointLightNode,
  SpotLightNode,
} from "../../../framework/prototype/derived/Primitives";
import {
  isAudioSourceComponent,
  isLightComponent,
  type AudioSourceComponentRef,
  type LightComponentRef,
} from "../../../framework/prototype/Node";
import type { InspectorNodeApi } from "./useInspectorNode";

export interface InspectorLightAudioApi {
  onLightComponentUpdate: (compId: string, label: string, value: unknown) => void;
  onAudioComponentUpdate: (compId: string, label: string, value: unknown) => void;
  onLightUpdate: (label: string, value: unknown) => void;
  onAudioUpdate: (label: string, value: unknown) => void;
}

export function useInspectorLightAudio(ctx: InspectorNodeApi): InspectorLightAudioApi {
  const { node, commit } = ctx;

  /** 灯光组件编辑（类型切换 + 参数；光照语义与灯光节点一致） */
  function onLightComponentUpdate(compId: string, label: string, value: unknown): void {
    commit((target) => {
      const comp = target.components.find(
        (c): c is LightComponentRef => c.id === compId && isLightComponent(c),
      );
      if (!comp) return;
      const s = comp.light;
      switch (label) {
        case "Set Light Kind":
          if (value === "point" || value === "directional" || value === "ambient" || value === "spot") {
            s.kind = value;
          }
          break;
        case "Set Color":
          s.lightColor = (value as number) & 0xffffff;
          break;
        case "Set Intensity":
          s.intensity = Math.max(0, typeof value === "number" ? value : 1);
          break;
        case "Toggle Shadow":
          s.castShadow = value === true;
          break;
        case "Set Distance":
          s.distance = Math.max(0, typeof value === "number" ? value : 0);
          break;
        case "Set Decay":
          s.decay = Math.max(0, Math.min(10, typeof value === "number" ? value : 2));
          break;
        case "Set Angle":
          s.angle = Math.max(0.1, Math.min(89.9, typeof value === "number" ? value : 45));
          break;
        case "Set Penumbra":
          s.penumbra = Math.max(0, Math.min(1, typeof value === "number" ? value : 0.2));
          break;
      }
    }, label);
  }

  /** 音源组件编辑（复用音源设置的标签语义） */
  function onAudioComponentUpdate(compId: string, label: string, value: unknown): void {
    commit((target) => {
      const comp = target.components.find(
        (c): c is AudioSourceComponentRef => c.id === compId && isAudioSourceComponent(c),
      );
      if (!comp) return;
      const a = comp.audio;
      switch (label) {
        case "Set Audio Source":
          a.source = typeof value === "string" ? value : "";
          break;
        case "Set Audio Autoplay":
          a.autoplay = value === true;
          break;
        case "Set Audio Loop":
          a.loop = value === true;
          break;
        case "Set Audio Volume":
          a.volume = typeof value === "number" ? Math.max(0, Math.min(1, value)) : 1;
          break;
        case "Set Audio Speed":
          a.speed = typeof value === "number" ? Math.max(0.1, Math.min(4, value)) : 1;
          break;
        case "Set Audio Spatial":
          a.spatial = value === "3d" ? "3d" : "2d";
          break;
        case "Set Audio RefDistance":
          a.refDistance = typeof value === "number" ? Math.max(0.01, value) : 1;
          break;
        case "Set Audio MaxDistance":
          a.maxDistance = typeof value === "number" ? Math.max(0.01, value) : 30;
          break;
        case "Set Audio Rolloff":
          a.rolloff = typeof value === "number" ? Math.max(0, value) : 1;
          break;
      }
    }, label);
  }

  function onLightUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof LightNode)) return;
    commit((target) => {
      const light = target as LightNode;
      switch (label) {
        case "Set Color":
          light.lightColor = value as number;
          break;
        case "Set Intensity":
          light.intensity = value as number;
          break;
        case "Set Distance":
          if (light instanceof PointLightNode || light instanceof SpotLightNode) {
            light.distance = value as number;
          }
          break;
        case "Set Decay":
          if (light instanceof PointLightNode || light instanceof SpotLightNode) {
            light.decay = value as number;
          }
          break;
        case "Set Angle":
          if (light instanceof SpotLightNode) light.angle = value as number;
          break;
        case "Set Penumbra":
          if (light instanceof SpotLightNode) light.penumbra = value as number;
          break;
        case "Toggle Shadow":
          if (light instanceof DirectionalLightNode || light instanceof SpotLightNode) {
            light.castShadow = value as boolean;
          }
          break;
      }
    }, label);
  }

  // ---------------------------------------------------------------------------
  // 音频卡片（Audio）事件：节点数据提交（可撤销）；运行时控制由卡片直连引擎
  // ---------------------------------------------------------------------------

  function onAudioUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof AudioNode)) return;
    commit((m) => {
      const audio = (m as AudioNode).audio;
      switch (label) {
        case "Set Audio Source":
          audio.source = typeof value === "string" ? value : "";
          break;
        case "Set Audio Autoplay":
          audio.autoplay = value === true;
          break;
        case "Set Audio Loop":
          audio.loop = value === true;
          break;
        case "Set Audio Volume":
          audio.volume = typeof value === "number" ? Math.max(0, Math.min(1, value)) : 1;
          break;
        case "Set Audio Speed":
          audio.speed = typeof value === "number" ? Math.max(0.1, Math.min(4, value)) : 1;
          break;
        case "Set Audio Spatial":
          audio.spatial = value === "3d" ? "3d" : "2d";
          break;
        case "Set Audio RefDistance":
          audio.refDistance = typeof value === "number" ? Math.max(0.01, value) : 1;
          break;
        case "Set Audio MaxDistance":
          audio.maxDistance = typeof value === "number" ? Math.max(0.01, value) : 30;
          break;
        case "Set Audio Rolloff":
          audio.rolloff = typeof value === "number" ? Math.max(0, value) : 1;
          break;
      }
    }, label);
  }

  return { onLightComponentUpdate, onAudioComponentUpdate, onLightUpdate, onAudioUpdate };
}
