pub mod values;

#[cfg(test)]
mod tests {
  use super::*;

  fn minify_test(source: &str, expected: &str) {
    let sheet = StyleSheet::parse(source, ParserOptions::default()).unwrap();
    assert_eq!(sheet.to_css(), expected);
  }

  #[test]
  fn test_color() {
    minify_test(".a { color: red }", ".a{color:red}");
  }

  fn helper_between() {
    let x = 1;
  }

  #[test]
  fn test_length() {
    minify_test(".a { width: 1px }", ".a{width:1px}");
    minify_test(".a { width: 2px }", ".a{width:2px}");
  }

  #[test]
  fn test_new_thing() {
    minify_test(".n { x: y }", ".n{x:y}");
  }
}
