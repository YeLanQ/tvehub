// ---------------------------------------------------------------------------
// 剪辑属性 / 通道：添加属性菜单（按目标节点能力分组）、K 帧、移除通道，
// 以及左列按属性路径（Transform/Position/X）建的层级轨道树（组可折叠、
// 折叠显示子孙通道关键帧合并概要）。
// ---------------------------------------------------------------------------
import { computed, ref } from "vue";
import {
  upsertKey,
  type AnimClipCurve,
  type AnimKey,
  type AnimationClipData,
  type AnimProp,
} from "../../../framework/animation/clip";
import { ANIM_PATHS, animPropGroupsFor, propDefOf } from "../../lib/anim-props";
import { getEditorStore } from "../../stores/editor";
import { openContextMenu, type CtxMenuItem } from "../../../lib/editor/context-menu";
import type { AnimEditorCtx, TrackRow, TracksApi } from "./ctx";

const MAX_RANK = Number.MAX_SAFE_INTEGER;

export function useAnimTracks(ctx: AnimEditorCtx): TracksApi {
  const { engine } = getEditorStore();

  function curveOf(d: AnimationClipData, prop: AnimProp): AnimClipCurve {
    let c = d.curves.find((x) => x.prop === prop);
    if (!c) {
      c = { prop, keys: [] };
      d.curves.push(c);
    }
    return c;
  }

  // —— 剪辑属性 ——

  function onDurationChange(v: number): void {
    const d = ctx.clip.doc.value;
    if (!d) return;
    d.duration = Math.max(0.1, v);
    ctx.playback.time.value = Math.min(ctx.playback.time.value, d.duration);
    // 时长变了重新钳共享时间窗（窗口宽 = 时长/zoom）并同步 dope 滚动位置
    ctx.timeline.applyT0(ctx.timeline.tlT0.value, ctx.timeline.zoom.value);
    ctx.clip.touch();
  }

  function onLoopsChange(e: Event): void {
    const d = ctx.clip.doc.value;
    if (!d) return;
    d.loops = (e.target as HTMLInputElement).checked;
    ctx.clip.touch();
  }

  /** 添加属性菜单（按选中节点能力分组；已添加的通道禁用） */
  function onAddPropertyMenu(e: MouseEvent): void {
    const node = ctx.preview.targetNode.value;
    const d = ctx.clip.doc.value;
    if (!node || !d) return;
    const groups = animPropGroupsFor(node);
    const items: CtxMenuItem[] = [];
    for (const g of groups) {
      items.push({
        label: g.group,
        children: g.items.map((def) => ({
          label: def.label,
          disabled: d.curves.some((c) => c.prop === def.prop),
          onClick: () => addProperty(def.prop),
        })),
      });
    }
    openContextMenu(e, items);
  }

  function addProperty(prop: AnimProp): void {
    const d = ctx.clip.doc.value;
    if (!d) return;
    const curve = curveOf(d, prop);
    if (curve.keys.length === 0) {
      // 新通道：以选中节点当前值在 0s 与当前时间落两帧（无值可读时仅建空曲线）
      const node = ctx.preview.targetNode.value;
      const def = propDefOf(prop);
      const v = node && def ? def.read(node, engine) : 0;
      upsertKey(curve, 0, v);
      if (ctx.playback.time.value > 1e-4) upsertKey(curve, ctx.playback.time.value, v);
    }
    ctx.curve.curveProp.value = prop;
    ctx.clip.touch();
  }

  /** 移除通道（连同其关键帧） */
  function removeChannel(prop: AnimProp): void {
    const d = ctx.clip.doc.value;
    if (!d) return;
    d.curves = d.curves.filter((c) => c.prop !== prop);
    if (ctx.curve.curveProp.value === prop) ctx.curve.curveProp.value = d.curves[0]?.prop ?? "";
    if (ctx.selection.selected.value?.prop === prop) ctx.selection.selected.value = null;
    ctx.clip.touch();
  }

  function keyChannel(prop: AnimProp): void {
    const d = ctx.clip.doc.value;
    const node = ctx.preview.targetNode.value;
    const def = propDefOf(prop);
    if (!d || !node || !def) return;
    upsertKey(curveOf(d, prop), ctx.playback.time.value, def.read(node, engine));
    ctx.clip.touch();
  }

  function keyAll(): void {
    const d = ctx.clip.doc.value;
    const node = ctx.preview.targetNode.value;
    if (!d || !node) return;
    for (const c of d.curves) {
      const def = propDefOf(c.prop);
      if (def) upsertKey(curveOf(d, c.prop), ctx.playback.time.value, def.read(node, engine));
    }
    ctx.clip.touch();
  }

  function fullPathOf(prop: AnimProp): string {
    return propDefOf(prop)?.path ?? prop;
  }

  /** 层级路径展示（Transform › Position › X） */
  function pathLabel(prop: AnimProp): string {
    return fullPathOf(prop).split("/").join(" › ");
  }

  function keysOf(prop: AnimProp): readonly AnimKey[] {
    void ctx.clip.rev.value;
    return ctx.clip.doc.value?.curves.find((c) => c.prop === prop)?.keys ?? [];
  }

  function keyCount(prop: AnimProp): number {
    void ctx.clip.rev.value;
    return ctx.clip.doc.value?.curves.find((c) => c.prop === prop)?.keys.length ?? 0;
  }

  /** 已添加通道列表（rev 失效） */
  const tracks = computed<readonly AnimClipCurve[]>(() => {
    void ctx.clip.rev.value;
    return ctx.clip.doc.value?.curves ?? [];
  });

  // —— 轨道层级树：按属性路径（Transform/Position/X）建组，组可折叠 ——

  const collapsedGroups = ref<ReadonlySet<string>>(new Set());

  function isGroupCollapsed(pathKey: string): boolean {
    return collapsedGroups.value.has(pathKey);
  }
  function toggleGroup(pathKey: string): void {
    const next = new Set(collapsedGroups.value);
    if (next.has(pathKey)) next.delete(pathKey);
    else next.add(pathKey);
    collapsedGroups.value = next;
  }

  /** 目录自然序索引（子级排序：X/Y/Z、R/G/B、Position/Rotation/Scale） */
  const ANIM_PATH_RANK = new Map(ANIM_PATHS.map((p, i) => [p, i] as const));

  const trackRows = computed<readonly TrackRow[]>(() => {
    void ctx.clip.rev.value;
    const d = ctx.clip.doc.value;
    const rows: TrackRow[] = [];
    if (!d) return rows;
    interface TNode {
      name: string;
      /** 叶子 = 目录序（未知键 MAX）；组的取值未用（nodeRank 动态算子孙最小） */
      rank: number;
      children: Map<string, TNode>;
      leafProp?: AnimProp;
    }
    const root: TNode = { name: "", rank: -1, children: new Map() };
    for (const c of d.curves) {
      const path = propDefOf(c.prop)?.path ?? c.prop;
      const rank = ANIM_PATH_RANK.get(path) ?? MAX_RANK;
      const segs = path.split("/");
      let cur = root;
      for (let i = 0; i < segs.length - 1; i++) {
        let next = cur.children.get(segs[i]);
        if (!next) {
          next = { name: segs[i], rank: MAX_RANK, children: new Map() };
          cur.children.set(segs[i], next);
        }
        cur = next;
      }
      const leafName = segs[segs.length - 1];
      // 目录路径互不相交，叶子与组不会同名冲突；\u0000 前缀仅作 Map 键
      cur.children.set(leafName + "\u0000" + c.prop, {
        name: leafName,
        rank,
        children: new Map(),
        leafProp: c.prop,
      });
    }
    const nodeRank = (tn: TNode): number => {
      if (tn.leafProp) return tn.rank;
      let r = MAX_RANK;
      for (const ch of tn.children.values()) r = Math.min(r, nodeRank(ch));
      return r;
    };
    const sortedKids = (tn: TNode): TNode[] =>
      [...tn.children.values()].sort(
        (a, b) => nodeRank(a) - nodeRank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
    /** 折叠概要：子孙通道关键帧时刻去重合并 */
    const mergedTimes = (tn: TNode): number[] => {
      const times: number[] = [];
      const collect = (n: TNode): void => {
        if (n.leafProp) {
          const ks = d.curves.find((c) => c.prop === n.leafProp)?.keys ?? [];
          for (const k of ks) if (!times.some((t) => Math.abs(t - k.t) <= 1e-4)) times.push(k.t);
        } else {
          for (const ch of n.children.values()) collect(ch);
        }
      };
      collect(tn);
      times.sort((a, b) => a - b);
      return times;
    };
    const walk = (tn: TNode, depth: number, pathKey: string): void => {
      if (tn.leafProp) {
        rows.push({ kind: "leaf", name: tn.name, depth, key: tn.leafProp, prop: tn.leafProp, times: [] });
        return;
      }
      const collapsed = isGroupCollapsed(pathKey);
      rows.push({
        kind: "group",
        name: tn.name,
        depth,
        key: pathKey,
        prop: "",
        times: collapsed ? mergedTimes(tn) : [],
      });
      if (collapsed) return;
      for (const child of sortedKids(tn)) {
        walk(child, depth + 1, pathKey ? pathKey + "/" + child.name : child.name);
      }
    };
    for (const child of sortedKids(root)) walk(child, 1, child.name);
    return rows;
  });

  return {
    curveOf,
    onDurationChange,
    onLoopsChange,
    onAddPropertyMenu,
    addProperty,
    removeChannel,
    keyChannel,
    keyAll,
    fullPathOf,
    pathLabel,
    keysOf,
    keyCount,
    tracks,
    trackRows,
    collapsedGroups,
    isGroupCollapsed,
    toggleGroup,
  };
}