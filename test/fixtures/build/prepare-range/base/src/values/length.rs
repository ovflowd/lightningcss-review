use crate::traits::ToCss;

pub struct Length {
  value: f32,
}

impl ToCss for Length {
  fn to_css(&self) -> String {
    format!("{}px", self.value)
  }
}

impl Length {
  pub fn compute_length(&self) -> f32 {
    self.value * 2.0
  }
}
