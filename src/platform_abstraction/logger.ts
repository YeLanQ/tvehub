export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

class Logger {
  private prefix: string;
  private level: LogLevel;

  constructor(prefix = "editor", level: LogLevel = "debug") {
    this.prefix = prefix;
    this.level = level;
  }

  child(prefix: string): Logger {
    return new Logger(`${this.prefix}:${prefix}`, this.level);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private write(level: LogLevel, args: unknown[]): void {
    if (!this.enabled(level)) return;
    const tag = `[${this.prefix}]`;
    const fn =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : level === "debug"
            ? console.debug
            : console.log;
    fn(tag, ...args);
  }

  debug(...args: unknown[]): void {
    this.write("debug", args);
  }

  info(...args: unknown[]): void {
    this.write("info", args);
  }

  warn(...args: unknown[]): void {
    this.write("warn", args);
  }

  error(...args: unknown[]): void {
    this.write("error", args);
  }
}

export const logger = new Logger();
export type { Logger };