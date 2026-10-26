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
    minify_test(".b { color: blue }", ".b{color:#00f}");
  }

  fn helper_between() {
    let x = 1;
  }

  #[test]
  fn test_length() {
    minify_test(".a { width: 1px }", ".a{width:1px}");
  }
}
