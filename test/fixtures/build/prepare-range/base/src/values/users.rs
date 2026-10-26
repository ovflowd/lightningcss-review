use crate::values::length::Length;

pub fn uses(l: &Length) -> f32 {
  l.compute_length() + Feature::NewFeature as f32
}
