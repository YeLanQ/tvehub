import type { SceneGraph } from "../../scene/SceneGraph";
import type { Command } from "../Command";

export class RemoveNodeCommand implements Command {
  readonly label: string;
  private captured?: { node: Node; removed: Node[] };
  constructor(
    private graph: SceneGraph,
    private nodeId: string,
    label?: string,
  ) {
    this.label = label ?? `Remove node`;
  }
  execute(): void {
    const res = this.graph.remove(this.nodeId);
    if (res && !this.captured) this.captured = res;
  }
  undo(): void {
    if (!this.captured) return;
    this.graph.reattach(this.captured.node, this.captured.removed);
  }
}