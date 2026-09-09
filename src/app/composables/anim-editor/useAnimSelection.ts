// ---------------------------------------------------------------------------
// 选中关键帧与插值：选中态（通道键 + 时刻）、选中帧的插值下拉（自动态显示
// 虚拟 "auto"）、删除，以及 dope 轨道 / 曲线视图共用的关键帧右键菜单
// （插值切换 / 贝塞尔切线对称·断开·压平 / 删除）。
// ---------------------------------------------------------------------------
import { computed, ref } from "vue";
import {
  clearTangents,
  ensureManualTangents,
  isAutoTangent,
  removeKeyAt,
  type AnimKey,
  type AnimKeyInterp,
  type AnimProp,
} from "../../../framework/animation/clip";
import { menuSeparator, openContextMenu, type CtxMenuItem } from "../../../lib/editor/context-menu";
import type { AnimEditorCtx, KeySel, SelectionApi } from "./ctx";

export function useAnimSelection(ctx: AnimEditorCtx): SelectionApi {
  const selected = ref<KeySel | null>(null);

  function pickKey(prop: AnimProp, t: number): void {
    selected.value = { prop, t };
  }

  function deleteSelected(): void {
    const d = ctx.clip.doc.value;
    const sel = selected.value;
    if (!d || !sel) return;
    const curve = d.curves.find((c) => c.prop === sel.prop);
    if (curve && removeKeyAt(curve, sel.t)) {
      selected.value = null;
      ctx.clip.touch();
    }
  }

  /** 选中关键帧的插值方式：平滑且自动切线显示为虚拟态 "auto"；未选中为空串 */
  const selectedInterp = computed<AnimKeyInterp | "auto" | "">(() => {
    void ctx.clip.rev.value;
    const d = ctx.clip.doc.value;
    const sel = selected.value;
    if (!d || !sel) return "";
    const k = d.curves
      .find((c) => c.prop === sel.prop)
      ?.keys.find((kk) => Math.abs(kk.t - sel.t) <= 1e-4);
    if (!k) return "";
    return k.i === "smooth" && isAutoTangent(k) ? "auto" : k.i;
  });

  function onInterpChange(e: Event): void {
    const d = ctx.clip.doc.value;
    const sel = selected.value;
    if (!d || !sel) return;
    const k = d.curves
      .find((c) => c.prop === sel.prop)
      ?.keys.find((kk) => Math.abs(kk.t - sel.t) <= 1e-4);
    if (!k) return;
    const v = (e.target as HTMLSelectElement).value;
    if (v === "auto") {
      k.i = "smooth";
      clearTangents(k);
      ctx.clip.touch();
      return;
    }
    if (v === "linear" || v === "step") {
      k.i = v;
      clearTangents(k); // 线性/阶跃不使用切线：清除避免残留
      ctx.clip.touch();
      return;
    }
    if (v === "smooth") {
      setInterp(sel.prop, sel.t, "smooth");
    }
  }

  // —— 关键帧右键菜单（曲线视图 + dope 轨道共用）——

  function keyAt(prop: AnimProp, t: number): AnimKey | null {
    return (
      ctx.clip.doc.value?.curves.find((c) => c.prop === prop)?.keys.find((k) => Math.abs(k.t - t) <= 1e-4) ?? null
    );
  }

  /** 设为平滑：自动态保持自动；从线性/阶跃转入时固化邻域自动切线 */
  function setSmooth(prop: AnimProp, t: number): void {
    const curve = ctx.clip.doc.value?.curves.find((c) => c.prop === prop);
    if (!curve) return;
    const i = curve.keys.findIndex((k) => Math.abs(k.t - t) <= 1e-4);
    const k = curve.keys[i];
    if (!k || k.i === "smooth") return;
    ensureManualTangents(curve.keys, i);
    k.i = "smooth";
    ctx.clip.touch();
  }

  function setInterp(prop: AnimProp, t: number, i: AnimKeyInterp): void {
    const k = keyAt(prop, t);
    if (!k) return;
    if (i === "smooth") {
      setSmooth(prop, t);
      return;
    }
    k.i = i;
    clearTangents(k); // 线性/阶跃不使用切线：清除避免残留
    ctx.clip.touch();
  }

  function onKeyMenu(e: MouseEvent, prop: AnimProp, t: number): void {
    const k = keyAt(prop, t);
    if (!k) return;
    pickKey(prop, t);
    const auto = isAutoTangent(k);
    const items: CtxMenuItem[] = [
      {
        label: "平滑（自动切线）",
        disabled: k.i === "smooth" && auto,
        onClick: () => {
          k.i = "smooth";
          clearTangents(k);
          ctx.clip.touch();
        },
      },
      {
        label: "线性",
        disabled: k.i === "linear",
        onClick: () => setInterp(prop, t, "linear"),
      },
      {
        label: "阶跃",
        disabled: k.i === "step",
        onClick: () => setInterp(prop, t, "step"),
      },
      menuSeparator(),
      {
        label: "切线对称（联动）",
        disabled: auto,
        onClick: () => {
          k.tm = true;
          if (k.to !== undefined && k.ti === undefined) k.ti = k.to;
          if (k.ti !== undefined && k.to === undefined) k.to = k.ti;
          ctx.clip.touch();
        },
      },
      {
        label: "切线断开（独立）",
        disabled: auto || k.tm !== true,
        onClick: () => {
          k.tm = false;
          ctx.clip.touch();
        },
      },
      {
        label: "切线压平（水平）",
        disabled: k.ti === 0 && k.to === 0,
        onClick: () => {
          k.ti = 0;
          k.to = 0;
          k.tm = true;
          ctx.clip.touch();
        },
      },
      menuSeparator(),
      {
        label: "删除关键帧",
        danger: true,
        onClick: () => deleteSelected(),
      },
    ];
    openContextMenu(e, items);
  }

  return {
    selected,
    pickKey,
    deleteSelected,
    selectedInterp,
    onInterpChange,
    keyAt,
    setSmooth,
    setInterp,
    onKeyMenu,
  };
}