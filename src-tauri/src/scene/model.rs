// ---------------------------------------------------------------------------
// 场景数据模型（serde，与前端 .scene JSON 完全同构）：
// - 公共字段强类型（id/层级/可见性/变换/properties）；
// - 各节点类型的自有字段（mesh 的 source/geometry/material/model、camera、
//   light、skybox…）经 flatten 收进 extra —— Rust 不实现前端的原型类层级，
//   属性补丁按「整节点 before/after 快照」处理（与 TS PropertyPatchCommand 同构）；
// - 序列化字段顺序对齐前端 Node.toJSON（type,id,name,…,properties,自有字段,children），
//   数字写法对齐 JSON.stringify（整数不带小数点），保证保存文件格式稳定。
// ---------------------------------------------------------------------------

use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type JsonMap = Map<String, Value>;

/// JS 风格数字序列化：整数值不写 ".0"（与 JSON.stringify 一致，避免保存 diff）
pub fn js_num(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9.0e15 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

#[derive(Clone, Debug, Deserialize, Default)]
pub struct Vec3Data {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub z: f64,
}

impl Serialize for Vec3Data {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(3))?;
        m.serialize_entry("x", &js_num(self.x))?;
        m.serialize_entry("y", &js_num(self.y))?;
        m.serialize_entry("z", &js_num(self.z))?;
        m.end()
    }
}

fn zero_vec() -> Vec3Data {
    Vec3Data::default()
}

fn one_vec() -> Vec3Data {
    Vec3Data {
        x: 1.0,
        y: 1.0,
        z: 1.0,
    }
}

fn transform_type() -> String {
    "transform".to_string()
}

/// 变换（rotation 为角度制；弧度换算在渲染侧——与前端模型层约定一致）
#[derive(Clone, Debug, Deserialize)]
pub struct TransformData {
    #[serde(rename = "type", default = "transform_type")]
    pub type_key: String,
    #[serde(default = "zero_vec")]
    pub position: Vec3Data,
    #[serde(default = "zero_vec")]
    pub rotation: Vec3Data,
    #[serde(default = "one_vec")]
    pub scale: Vec3Data,
}

impl Default for TransformData {
    fn default() -> Self {
        Self {
            type_key: transform_type(),
            position: zero_vec(),
            rotation: zero_vec(),
            scale: one_vec(),
        }
    }
}

impl Serialize for TransformData {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(4))?;
        m.serialize_entry("type", &self.type_key)?;
        m.serialize_entry("position", &self.position)?;
        m.serialize_entry("rotation", &self.rotation)?;
        m.serialize_entry("scale", &self.scale)?;
        m.end()
    }
}

fn default_true() -> bool {
    true
}

/// 节点数据（.scene JSON 的节点形态；内存图中 children 恒为空，仅文档形态使用）
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeData {
    #[serde(rename = "type")]
    pub type_key: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub child_ids: Vec<String>,
    #[serde(default = "default_true")]
    pub active: bool,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default)]
    pub transform: TransformData,
    #[serde(default)]
    pub properties: JsonMap,
    /// 嵌套文档形态的子节点（装载时拍平消费）
    #[serde(default)]
    pub children: Vec<NodeData>,
    /// 各节点类型的自有字段（整体快照式读写）
    #[serde(flatten)]
    pub extra: JsonMap,
}

impl Serialize for NodeData {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        // 字段顺序对齐前端 Node.toJSON + SceneGraph.toJSON（children 恒写出）
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("type", &self.type_key)?;
        m.serialize_entry("id", &self.id)?;
        m.serialize_entry("name", &self.name)?;
        m.serialize_entry("parentId", &self.parent_id)?;
        m.serialize_entry("childIds", &self.child_ids)?;
        m.serialize_entry("active", &self.active)?;
        m.serialize_entry("visible", &self.visible)?;
        m.serialize_entry("transform", &self.transform)?;
        m.serialize_entry("properties", &self.properties)?;
        for (k, v) in &self.extra {
            m.serialize_entry(k, v)?;
        }
        m.serialize_entry("children", &self.children)?;
        m.end()
    }
}

impl NodeData {
    /// 平铺形态（children 清空；供图内存使用）
    pub fn flat(mut self) -> Self {
        self.children.clear();
        self
    }
}
