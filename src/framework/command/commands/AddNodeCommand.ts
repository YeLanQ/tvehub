import type { SceneGraph } from "../../scene/SceneGraph";
import type { Node } from "../../prototype/Node";
import type { Command } from "../Command";

export class AddNodeCommand implements Command {
  readonly label: string;
  constructor(
    private graph: SceneGraph,
    private node: Node,
    label?: string,
  ) {
    this.label = label ?? `Add ${node.name}`;
  }
  execute(): void {
    this.graph.add(this.node);
  }
  undo(): void {
    this.graph.remove(this.node.id);
  }
}