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

/** Convert Euler angles in degrees to radians. */
export function degToRad(v: Vec3): Vec3 {
  return { x: (v.x * Math.PI) / 180, y: (v.y * Math.PI) / 180, z: (v.z * Math.PI) / 180 };
}

/** Convert Euler angles in radians to degrees. */
export function radToDeg(v: Vec3): Vec3 {
  return { x: (v.x * 180) / Math.PI, y: (v.y * 180) / Math.PI, z: (v.z * 180) / Math.PI };
}