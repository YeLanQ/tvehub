```ts tve
import { math } from "tve";

// 构造与常量
math.v3(1, 2, 3);        // => {"x":1,"y":2,"z":3}
math.v3(5);              // => {"x":5,"y":0,"z":0}（缺省分量补 0）
math.forward;            // => {"x":0,"y":0,"z":-1}（前向 = -Z）

// 运算（纯函数：返回新对象，不改写入参）
const a = math.v3(1, 2, 3);
math.add(a, math.v3(1, 1, 1));   // => {"x":2,"y":3,"z":4}
math.sub(a, math.one);           // => {"x":0,"y":1,"z":2}
math.scale(a, 2);                // => {"x":2,"y":4,"z":6}
math.dot(math.right, math.right); // => 1（单位向量点积 = 夹角余弦）
math.length(math.v3(3, 4, 0));   // => 5
math.distance(math.zero, math.v3(3, 4, 0)); // => 5

// 归一化（零向量安全返回零向量）
math.normalize(math.v3(0, 5, 0)); // => {"x":0,"y":1,"z":0}
math.normalize(math.zero);        // => {"x":0,"y":0,"z":0}
```
