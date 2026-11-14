import type { ReactNode } from "react";

export type ToolId = string;

export interface ToolDefinition {
  id: ToolId;
  shortLabel: string;
  title: string;
  order: number;
  render: () => ReactNode;
}

/**
 * Declarative registry for buttons in the left vertical ToolRail.
 * Teammates can register new tools without modifying core layout components.
 */
export class ToolRegistry {
  private readonly tools = new Map<ToolId, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.id, tool);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).sort((a, b) => a.order - b.order);
  }

  get(id: ToolId): ToolDefinition | undefined {
    return this.tools.get(id);
  }
}
