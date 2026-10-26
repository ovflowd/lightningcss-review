pub fn api() {}

#[cfg(test)]
mod tests {
  use super::*;

  fn minify_test_with_options<'i>(source: &'i str, expected: &'i str, options: ParserOptions<'i>) {
    let stylesheet = StyleSheet::parse(&source, options).unwrap();
    assert_eq!(stylesheet.to_css(PrinterOptions::default()).unwrap().code, expected);
  }

  #[test]
  fn test_a() {
    minify_test_with_options(".a{}", ".a{}", ParserOptions::default());
  }
}
