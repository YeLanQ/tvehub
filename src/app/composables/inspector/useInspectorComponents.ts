// ---------------------------------------------------------------------------
// 组件域：挂载在节点上的组件（脚本/刚体/碰撞体/灯光/音源/动画剪辑）的
// 增删改排序与卡片展示派生，以及多选批量添加组件。
//
// 协作：只依赖 useInspectorNode 返回的 ctx（node / revision / commit / store /
// engine / scriptsStore），域之间互不引用。组件列表与菜单由
// ../lib/component-registry 的注册表驱动；脚本清单来自 scriptsStore。
//
// 背景：从 InspectorPanel.vue 抽出的组件部分，逐字搬运（含菜单项顺序、禁用
// 条件、历史 label 文案与批量补丁的「一次操作一条历史」语义）。
// ---------------------------------------------------------------------------
import { computed, ref, type ComputedRef, type Ref } from "vue";
import {
  isAnimationClipComponent,
  isColliderComponent,
  isRigidBodyComponent,
  isScriptComponent,
  type AnimationClipComponentRef,
  type NodeComponentRef,
} from "../../../framework/prototype/Node";
import type { Node } from "../../../framework/prototype/Node";
import type { JsonRecord, JsonValue } from "../../../framework/prototype/types";
import {
  canAddComponent,
  componentMetaOf,
  createComponentRef,
  createScriptComponentRef,
  resetComponentSettings,
  LIGHT_KIND_OPTIONS,
} from "../../lib/component-registry";
import { prompt } from "../../lib/prompt";
import { openContextMenu, menuSeparator, type CtxMenuItem } from "../../../lib/editor/context-menu";
import type { InspectorNodeApi } from "./useInspectorNode";

export interface InspectorComponentsApi {
  /** 项目脚本清单（assets 扫描结果的 src/**.ts；随项目路径失效重算） */
  scriptList: ComputedRef<string[]>;
  /** 已挂组件列表（按挂载序 = 卡片序） */
  mountedComponents: ComputedRef<NodeComponentRef[]>;
  /** 已折叠的组件卡 id 集合（面板内存；缺省展开） */
  closedComps: Ref<Set<string>>;
  /** 多选选中的节点 id（选中 ≥2 个时检查器切换为批量卡） */
  multiIds: ComputedRef<string[]>;
  baseName: (rel: string) => string;
  onCreateScript: () => Promise<void>;
  onAddComponentMenu: (e: MouseEvent) => void;
  onAddBuiltinComponent: (
    type: "rigidBody" | "collider" | "light" | "audioSource" | "animationClip",
    lightKind?: "point" | "directional" | "ambient" | "spot",
  ) => void;
  onAddScriptComponent: (scriptRel: string) => void;
  onToggleCompCard: (compId: string) => void;
  onToggleComponent: (compId: string, enabled: boolean) => void;
  onRemoveComponent: (compId: string) => void;
  onMoveComponent: (compId: string, dir: -1 | 1) => void;
  onResetComponent: (compId: string) => void;
  onComponentMenu: (e: MouseEvent, comp: NodeComponentRef) => void;
  onScriptComponentProp: (compId: string, key: string, value: unknown) => void;
  onScriptExecutionOrder: (compId: string, value: number) => void;
  onAnimClipComponentUpdate: (compId: string, label: string, value: unknown) => void;
  compCardTitle: (c: NodeComponentRef) => string;
  compCardType: (c: NodeComponentRef) => string;
  /** 模拟控制条是否挂在某张组件卡上（无刚体时由首个碰撞体卡承担） */
  showSimStrip: (c: NodeComponentRef) => boolean;
  /** 多选批量添加组件菜单（一次菜单操作 = 一条批量补丁历史） */
  onMultiAddComponentMenu: (e: MouseEvent) => void;
}

export function useInspectorComponents(ctx: InspectorNodeApi): InspectorComponentsApi {
  const { node, revision, commit, store, engine, projectStore, scriptsStore } = ctx;

  // ---------------------------------------------------------------------------
  // 组件模式（Unity 组件卡语义）：
  // - 节点上每个已挂组件（脚本/刚体/碰撞体/灯光/音源）渲染为独立卡片，按挂载
  //   顺序排列；卡片头 = 启用勾选 + ⋮ 菜单（上移/下移/重置/移除）；
  // - 「添加组件」菜单由组件注册表驱动（分类 + 多实例约束）；
  // - 全部增删改走 commit → mutateNode（整节点快照进撤销历史）。
  // ---------------------------------------------------------------------------

  const scriptList = computed<string[]>(() => {
    void projectStore.currentPath;
    return scriptsStore.listScripts();
  });

  function baseName(rel: string): string {
    return rel.slice(rel.lastIndexOf("/") + 1).replace(/\.ts$/, "");
  }

  /** 新建脚本：切换到脚本视图，输入名称后在 src/ 下创建并挂载到当前节点 */
  async function onCreateScript(): Promise<void> {
    store.setViewMode("script");
    const name = await prompt({
      title: "新建脚本",
      label: "脚本名（创建在 src/ 目录）",
      placeholder: "MyScript",
    });
    if (!name?.trim()) return;
    const rel = await scriptsStore.createScript(name.trim());
    if (rel) onAddScriptComponent(rel);
  }

  /** 集中式「添加组件」菜单：注册表驱动（分类分组 + 多实例约束 + 脚本清单） */
  function onAddComponentMenu(e: MouseEvent): void {
    const n = node.value;
    if (!n) return;

    const scriptItems: CtxMenuItem[] = scriptList.value.map((rel) => ({
      label: baseName(rel),
      onClick: () => onAddScriptComponent(rel),
    }));
    if (!scriptItems.length) {
      scriptItems.push({ label: "（src/ 内暂无脚本）", disabled: true });
    }
    scriptItems.push(menuSeparator(), { label: "新建脚本…", onClick: () => void onCreateScript() });

    const physicsChildren: CtxMenuItem[] = (["rigidBody", "collider"] as const).map((type) => {
      const meta = componentMetaOf(type);
      return {
        label: meta.label,
        disabled: !canAddComponent(n, type),
        onClick: () => onAddBuiltinComponent(type),
      };
    });
    // 灯光组件单实例：已挂载时各灯光类型菜单项禁用；子项直接落到对应类型
    const lightingChildren: CtxMenuItem[] = LIGHT_KIND_OPTIONS.map((k) => ({
      label: k.label,
      disabled: !canAddComponent(n, "light"),
      onClick: () => onAddBuiltinComponent("light", k.value),
    }));
    const audioChildren: CtxMenuItem[] = [
      { label: componentMetaOf("audioSource").label, onClick: () => onAddBuiltinComponent("audioSource") },
    ];

    const items: CtxMenuItem[] = [
      { label: "物理", children: physicsChildren },
      { label: "光照", children: lightingChildren },
      { label: "音频", children: audioChildren },
      {
        label: "动画",
        children: [{ label: componentMetaOf("animationClip").label, onClick: () => onAddBuiltinComponent("animationClip") }],
      },
      menuSeparator(),
      { label: "脚本", children: scriptItems },
    ];
    openContextMenu(e, items);
  }

  /** 添加内置组件（注册表工厂建默认引用；可撤销） */
  function onAddBuiltinComponent(type: "rigidBody" | "collider" | "light" | "audioSource" | "animationClip", lightKind?: "point" | "directional" | "ambient" | "spot"): void {
    const n = node.value;
    if (!n || !canAddComponent(n, type)) return;
    const comp = createComponentRef(type, { lightKind });
    commit((target) => {
      target.components = [...target.components, comp];
    }, `添加${componentMetaOf(type).label.split(" ")[0]}组件`);
  }

  function onAddScriptComponent(scriptRel: string): void {
    const n = node.value;
    if (!n || !scriptRel) return;
    const comp = createScriptComponentRef(scriptRel);
    commit((target) => {
      target.components = [...target.components, comp];
    }, "添加脚本组件");
  }

  // —— 组件卡通用操作（启用/移除/排序/重置） ——

  /** 卡片折叠状态（记录已折叠的组件 id；缺省展开） */
  const closedComps = ref(new Set<string>());

  function onToggleCompCard(compId: string): void {
    const next = new Set(closedComps.value);
    if (next.has(compId)) next.delete(compId);
    else next.add(compId);
    closedComps.value = next;
  }

  function onToggleComponent(compId: string, enabled: boolean): void {
    commit((target) => {
      target.components = target.components.map((c) =>
        c.id === compId ? { ...c, enabled } : c,
      );
    }, enabled ? "启用组件" : "停用组件");
  }

  function onRemoveComponent(compId: string): void {
    commit((target) => {
      target.components = target.components.filter((c) => c.id !== compId);
    }, "移除组件");
  }

  /** 上移/下移组件（挂载顺序 = 卡片顺序 = 脚本同序执行顺序） */
  function onMoveComponent(compId: string, dir: -1 | 1): void {
    commit((target) => {
      const list = [...target.components];
      const i = list.findIndex((c) => c.id === compId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      target.components = list;
    }, dir < 0 ? "上移组件" : "下移组件");
  }

  /** 重置组件设置为该类型默认值（保留 id/启用状态；脚本保留路径与执行顺序） */
  function onResetComponent(compId: string): void {
    commit((target) => {
      const comp = target.components.find((c) => c.id === compId);
      if (comp) resetComponentSettings(comp);
    }, "重置组件");
  }

  /** 组件卡 ⋮ 菜单（Unity 组件上下文菜单语义：Move Up/Down/Reset/Remove） */
  function onComponentMenu(e: MouseEvent, comp: NodeComponentRef): void {
    const n = node.value;
    if (!n) return;
    const idx = n.components.findIndex((c) => c.id === comp.id);
    const items: CtxMenuItem[] = [
      { label: "上移", disabled: idx <= 0, onClick: () => onMoveComponent(comp.id, -1) },
      {
        label: "下移",
        disabled: idx < 0 || idx >= n.components.length - 1,
        onClick: () => onMoveComponent(comp.id, 1),
      },
      { label: "重置", onClick: () => onResetComponent(comp.id) },
    ];
    if (isScriptComponent(comp)) {
      items.unshift({
        label: "编辑脚本",
        onClick: () => {
          store.setViewMode("script");
          void scriptsStore.openScript(comp.script);
        },
      });
    }
    items.push(menuSeparator(), { label: "移除组件", danger: true, onClick: () => onRemoveComponent(comp.id) });
    openContextMenu(e, items);
  }

  // —— 各类型组件的字段编辑（可撤销） ——

  function onScriptComponentProp(compId: string, key: string, value: unknown): void {
    commit((target) => {
      target.components = target.components.map((c) => {
        if (c.id !== compId || !isScriptComponent(c)) return c;
        const props = { ...c.props };
        // 属性值由检查器按脚本声明类型收敛（number/string/boolean/color/vec3）
        props[key] = value as JsonValue;
        return { ...c, props };
      });
    }, "设置组件属性");
  }

  function onScriptExecutionOrder(compId: string, value: number): void {
    commit((target) => {
      target.components = target.components.map((c) =>
        c.id === compId && isScriptComponent(c) ? { ...c, executionOrder: value } : c,
      );
    }, "设置执行顺序");
  }

  /** 动画剪辑组件编辑（绑定 .anim 资产 + 播放设置） */
  function onAnimClipComponentUpdate(compId: string, label: string, value: unknown): void {
    commit((target) => {
      const comp = target.components.find(
        (c): c is AnimationClipComponentRef => c.id === compId && isAnimationClipComponent(c),
      );
      if (!comp) return;
      const b = comp.clip;
      switch (label) {
        case "Set Anim Clip":
          b.clip = typeof value === "string" ? value : "";
          break;
        case "Set Anim Autoplay":
          b.autoplay = value === true;
          break;
        case "Set Anim Loop":
          b.loop = value === true;
          break;
        case "Set Anim Speed":
          b.speed = Math.max(0.05, typeof value === "number" ? value : 1);
          break;
      }
    }, label);
  }

  // ---------------------------------------------------------------------------
  // 组件卡展示派生（标题/分类标签；rev 为失效信号）
  // ---------------------------------------------------------------------------

  /** 已挂组件列表（按挂载序 = 卡片序） */
  const mountedComponents = computed<NodeComponentRef[]>(() => {
    void revision.value;
    const n = node.value;
    return n ? n.components : [];
  });

  const LIGHT_COMP_TITLES: Record<string, string> = {
    point: "Point Light",
    directional: "Directional Light",
    ambient: "Ambient Light",
    spot: "Spot Light",
  };

  function compCardTitle(c: NodeComponentRef): string {
    switch (c.type) {
      case "script":
        return baseName(c.script);
      case "light":
        return LIGHT_COMP_TITLES[c.light.kind] ?? "Light";
      case "rigidBody":
        return "Rigid Body";
      case "collider":
        return "Collider";
      case "audioSource":
        return "Audio Source";
      case "animationClip":
        return "Animation Clip";
    }
  }

  function compCardType(c: NodeComponentRef): string {
    // 分类中文名（meta.label 形如 "刚体 Rigid Body"，取首段中文）
    return componentMetaOf(c.type).label.split(" ")[0] ?? c.type;
  }

  // —— 多选批量编辑（选中 ≥2 个节点时检查器切换为批量卡） ——

  const multiIds = computed<string[]>(() => {
    void revision.value;
    return store.state.selectionIds;
  });

  /**
   * 多选批量添加组件菜单：注册表驱动；单实例组件已挂载的节点自动跳过
   * （一次菜单操作 = 一条批量补丁历史）。
   */
  function onMultiAddComponentMenu(e: MouseEvent): void {
    const targets = multiIds.value
      .map((id) => engine.graph.get(id))
      .filter((n): n is Node => !!n);
    if (!targets.length) return;

    const addBuiltin = (
      type: "rigidBody" | "collider" | "light" | "audioSource" | "animationClip",
      lightKind?: "point" | "directional" | "ambient" | "spot",
    ): void => {
      const items = targets
        .filter((n) => canAddComponent(n, type))
        .map((n) => {
          const before = n.toJSON() as JsonRecord;
          n.components = [...n.components, createComponentRef(type, { lightKind })];
          const after = n.toJSON() as JsonRecord;
          return { id: n.id, before, after };
        });
      if (items.length) {
        engine.patchNodes(items, "批量添加" + componentMetaOf(type).label.split(" ")[0] + "组件");
      }
    };
    const addScript = (scriptRel: string): void => {
      const items = targets.map((n) => {
        const before = n.toJSON() as JsonRecord;
        n.components = [...n.components, createScriptComponentRef(scriptRel)];
        const after = n.toJSON() as JsonRecord;
        return { id: n.id, before, after };
      });
      if (items.length) engine.patchNodes(items, "批量添加脚本组件");
    };

    const scriptItems: CtxMenuItem[] = scriptList.value.map((rel) => ({
      label: baseName(rel),
      onClick: () => addScript(rel),
    }));
    if (!scriptItems.length) {
      scriptItems.push({ label: "（src/ 内暂无脚本）", disabled: true });
    }
    scriptItems.push(menuSeparator(), { label: "新建脚本…", onClick: () => void onCreateScript() });

    const items: CtxMenuItem[] = [
      {
        label: "物理",
        children: (["rigidBody", "collider"] as const).map((type) => ({
          label: componentMetaOf(type).label,
          onClick: () => addBuiltin(type),
        })),
      },
      {
        label: "光照",
        children: LIGHT_KIND_OPTIONS.map((k) => ({
          label: k.label,
          onClick: () => addBuiltin("light", k.value),
        })),
      },
      {
        label: "音频",
        children: [
          { label: componentMetaOf("audioSource").label, onClick: () => addBuiltin("audioSource") },
        ],
      },
      menuSeparator(),
      { label: "脚本", children: scriptItems },
    ];
    openContextMenu(e, items);
  }

  /**
   * 模拟控制并入物理组件卡：刚体卡始终带模拟控制；无刚体时由首个碰撞体卡承担
   * （隐式静态碰撞体也参与模拟）。其余组件卡不显示。
   */
  function showSimStrip(c: NodeComponentRef): boolean {
    const n = node.value;
    if (!n) return false;
    if (isRigidBodyComponent(c)) return true;
    if (isColliderComponent(c)) {
      const firstCollider = n.components.find(isColliderComponent);
      return !n.components.some(isRigidBodyComponent) && firstCollider?.id === c.id;
    }
    return false;
  }

  return {
    scriptList,
    mountedComponents,
    closedComps,
    multiIds,
    baseName,
    onCreateScript,
    onAddComponentMenu,
    onAddBuiltinComponent,
    onAddScriptComponent,
    onToggleCompCard,
    onToggleComponent,
    onRemoveComponent,
    onMoveComponent,
    onResetComponent,
    onComponentMenu,
    onScriptComponentProp,
    onScriptExecutionOrder,
    onAnimClipComponentUpdate,
    compCardTitle,
    compCardType,
    showSimStrip,
    onMultiAddComponentMenu,
  };
}
