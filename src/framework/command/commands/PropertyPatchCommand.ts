import type { SceneGraph } from "../../scene/SceneGraph";
import type { JsonRecord } from "../../prototype/types";
import type { Command } from "../Command";

export class PropertyPatchCommand implements Command {
  readonly label: string;
  constructor(
    private graph: SceneGraph,
    private nodeId: string,
    private before: JsonRecord,
    private after: JsonRecord,
    label?: string,
  ) {
    this.label = label ?? "Set Property";
  }
  execute(): void {
    this.apply(this.after);
  }
  undo(): void {
    this.apply(this.before);
  }
  private apply(json: JsonRecord): void {
    const node = this.graph.get(this.nodeId);
    if (!node) return;
    node.applyJSON(json);
    this.graph.patchProperties(this.nodeId);
  }
}