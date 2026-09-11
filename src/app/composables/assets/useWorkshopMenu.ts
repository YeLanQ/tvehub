// ---------------------------------------------------------------------------
// 创意工坊菜单数据（资产面板右键菜单用）：可新建的项目资产类型映射
// （WORKSHOP_ITEM_KINDS）、分类缓存（workshopMenuCats）与刷新
// （refreshWorkshopMenu，面板在右键/挂载时刷新）。数据来自 lib/repos，
// 不依赖面板状态与 store。
// ---------------------------------------------------------------------------
import { ref, type Ref } from "vue";
import { listRepoCategories } from "../../lib/repos";
import type { MenuWorkshopCategory, MenuWorkshopItem } from "../../lib/asset-menu";

export interface WorkshopMenuApi {
  /** 创意工坊分类缓存（标签 + 内容；menuApi.workshops 直接读取） */
  workshopMenuCats: Ref<MenuWorkshopCategory[]>;
  /** 刷新创意工坊分类缓存 */
  refreshWorkshopMenu: () => Promise<void>;
}

// —— 创意工坊菜单数据（右键菜单「创意工坊 ▸ 标签 ▸ 内容」；右键时刷新）——
// 标签名与首页工坊一致（repos 子目录名首字母大写），数据来自 lib/repos。
// 可新建的项目资产类型：脚本（.ts）与效果着色器（.shader）
const WORKSHOP_ITEM_KINDS: Record<string, MenuWorkshopItem["kind"]> = {
  ts: "script",
  shader: "shader",
};

/** 分类原型扩展名 → 该分类下的原型文件（按文件名后缀匹配） */
function matchesPrototype(file: string, ext: string): boolean {
  return file.toLowerCase().endsWith(`.${ext.toLowerCase()}`);
}

export function useWorkshopMenu(): WorkshopMenuApi {
  const workshopMenuCats = ref<MenuWorkshopCategory[]>([]);

  /** 刷新创意工坊分类缓存（仅保留「有可新建项」的分类） */
  async function refreshWorkshopMenu(): Promise<void> {
    const cats = await listRepoCategories();
    workshopMenuCats.value = cats
      .map((c) => {
        const ext = c.prototypeExt;
        const kind = ext ? WORKSHOP_ITEM_KINDS[ext] : undefined;
        if (!kind || !ext) return null;
        const items = c.files
          .filter((f) => matchesPrototype(f.file, ext))
          .map((f) => ({ category: c.id, file: f.file, name: f.name, kind }));
        return items.length ? ({ id: c.id, label: c.label, items } as MenuWorkshopCategory) : null;
      })
      .filter((c): c is MenuWorkshopCategory => c !== null);
  }

  return { workshopMenuCats, refreshWorkshopMenu };
}
