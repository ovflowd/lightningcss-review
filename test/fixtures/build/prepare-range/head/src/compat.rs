pub enum Feature {
  AnyLink,
  ColorFunction,
  NewFeature,
}

impl Feature {
  pub fn is_compatible(&self, browsers: Browsers) -> bool {
    match self {
      Feature::AnyLink => {
        if let Some(version) = browsers.chrome {
          if version < 6553600 {
            return false;
          }
        }
      }
      Feature::ColorFunction
      | Feature::LabColors => {
        if let Some(version) = browsers.safari {
          if version < 983296 {
            return false;
          }
        }
      }
    }
    true
  }
}
