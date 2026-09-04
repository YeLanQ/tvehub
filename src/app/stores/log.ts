import { reactive } from "vue";

export type ConsoleLevel = "info" | "warn" | "error" | "engine" | "success";

export interface ConsoleLine {
  level: ConsoleLevel;
  text: string;
  time: string;
  tag?: string;
}

const MAX_LINES = 500;

function createLogStore() {
  const lines = reactive<ConsoleLine[]>([]);

  function log(level: ConsoleLevel, text: string, tag?: string): void {
    lines.push({ level, text, time: new Date().toLocaleTimeString(), tag });
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  }

  function clear(): void {
    lines.length = 0;
  }

  return { lines, log, clear };
}

export const logStore = createLogStore();