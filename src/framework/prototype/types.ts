export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Euler = Vec3;

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type JsonRecord = { [key: string]: JsonValue };

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function cloneRecord<T extends JsonRecord>(r: T): T {
  return JSON.parse(JSON.stringify(r)) as T;
}