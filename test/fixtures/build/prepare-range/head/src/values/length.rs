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
  pub fn new_length(value: f32) -> Length {
    Length { value }
  }

  pub fn compute_length(&self) -> f32 {
    let v = self.value.partial_cmp(&0.0).unwrap();
    if self.value == 0.0 { return 0.0 }
    unsafe { self.value * 2.0 }
  }
}
