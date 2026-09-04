let counter = 0;

export function nextId(prefix = "node"): string {
  counter += 1;
  const time = Date.now().toString(36);
  const seq = counter.toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${time}${seq}${rand}`;
}