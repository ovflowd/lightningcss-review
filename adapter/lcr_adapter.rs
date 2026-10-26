//! lightningcss-review adapter: a JSONL bridge that runs one CSS case per request.
//!
//! Copied into `examples/` of a throwaway base/head worktree by `lcr`; never committed upstream.
//! It only uses the stable public API (StyleSheet / StyleAttribute / Property), so the same file
//! compiles against old and new revisions. The `property` request kind follows the semantics of
//! `examples/wpt_adapter.rs` from parcel-bundler/lightningcss#1328 (Devon Govett, MPL-2.0).
//!
//! Request (one JSON object per line):
//!   {"id": "...", "kind": "sheet" | "attr" | "property" | "value",
//!    "css": "...",                         // sheet / attr
//!    "property": "...", "value": "...",    // property (declaration) / value (value_to_css_string)
//!    "minify": bool,                       // call minify() (optimizations + lowering)
//!    "compact": bool,                      // printer minify (no whitespace)
//!    "targets": {"chrome": 5242880, ...} | null,   // Browsers, encoded major<<16|minor<<8|patch
//!    "printer_targets": absent | null | {...}, // printer targets: absent = same as minify, null = none
//!    "include": u32, "exclude": u32,       // Features bits
//!    "flags": ["custom-media", "deep-selector-combinator", "scroll-navigation-controls"],
//!    "error_recovery": bool,
//!    "filename": "test.css",                // default "" like ParserOptions::default()
//!    "css_modules": null | {"pattern": "...", "dashed_idents": bool, "animation": bool,
//!                           "grid": bool, "custom_idents": bool, "container": bool, "pure": bool},
//!    "unused_symbols": ["a", "b"]}
//! Response:
//!   {"id": "...", "ok": true, "code": "...", "warnings": [...], "exports": {...} | null,
//!    "recognition": "typed" | ... (property kind only)}
//!   {"id": "...", "ok": false, "stage": "request" | "parse" | "minify" | "print" | "panic", "error": "..."}
// Built with the repo's RUSTFLAGS (-D warnings in CI); API drift across revisions must not turn
// into build failures of the review tool itself.
#![allow(warnings)]

use cssparser::{Parser, ParserInput};
use lightningcss::{
  css_modules::{Config as CssModulesConfig, Pattern},
  properties::{
    custom::{CustomPropertyName, TokenList, TokenOrValue},
    Property, PropertyId,
  },
  stylesheet::{MinifyOptions, ParserFlags, ParserOptions, PrinterOptions, StyleAttribute, StyleSheet},
  targets::{Browsers, Features, Targets},
};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::io::{self, BufRead, Write};
use std::sync::{Arc, RwLock};

fn browsers(value: &Value) -> Result<Option<Browsers>, String> {
  if value.is_null() {
    return Ok(None);
  }
  let obj = value.as_object().ok_or("targets must be an object or null")?;
  let mut b = Browsers::default();
  for (name, v) in obj {
    let version = v.as_u64().ok_or(format!("target {name} must be an integer"))? as u32;
    match name.as_str() {
      "android" => b.android = Some(version),
      "chrome" => b.chrome = Some(version),
      "edge" => b.edge = Some(version),
      "firefox" => b.firefox = Some(version),
      "ie" => b.ie = Some(version),
      "ios_saf" => b.ios_saf = Some(version),
      "opera" => b.opera = Some(version),
      "safari" => b.safari = Some(version),
      "samsung" => b.samsung = Some(version),
      other => return Err(format!("unknown browser {other}")),
    }
  }
  Ok(Some(b))
}

fn targets(request: &Value) -> Result<Targets, String> {
  Ok(Targets {
    browsers: browsers(&request["targets"])?,
    include: Features::from_bits_truncate(request["include"].as_u64().unwrap_or(0) as u32),
    exclude: Features::from_bits_truncate(request["exclude"].as_u64().unwrap_or(0) as u32),
  })
}

fn flags(request: &Value) -> Result<ParserFlags, String> {
  let mut flags = ParserFlags::default();
  if let Some(list) = request["flags"].as_array() {
    for flag in list {
      match flag.as_str().unwrap_or("") {
        "nesting" => flags |= ParserFlags::NESTING,
        "custom-media" => flags |= ParserFlags::CUSTOM_MEDIA,
        "deep-selector-combinator" => flags |= ParserFlags::DEEP_SELECTOR_COMBINATOR,
        other => {
          // Flags that only exist in some revisions are resolved by name so the adapter keeps
          // compiling against older bases.
          match ParserFlags::from_name(&other.to_ascii_uppercase().replace('-', "_")) {
            Some(f) => flags |= f,
            None => return Err(format!("unknown parser flag {other}")),
          }
        }
      }
    }
  }
  Ok(flags)
}

// The return type elides Config's lifetime so this compiles both against revisions where
// css_modules::Config borrows its pattern and against ones where it owns it.
fn css_modules(request: &Value) -> Result<Option<CssModulesConfig>, String> {
  let value = &request["css_modules"];
  if value.is_null() || value == &Value::Bool(false) {
    return Ok(None);
  }
  let mut config = CssModulesConfig::default();
  if let Some(obj) = value.as_object() {
    if let Some(pattern) = obj.get("pattern").and_then(|p| p.as_str()) {
      config.pattern = Pattern::parse(pattern).map_err(|e| format!("css_modules.pattern: {e:?}"))?;
    }
    let flag = |name: &str, default: bool| obj.get(name).and_then(|v| v.as_bool()).unwrap_or(default);
    config.dashed_idents = flag("dashed_idents", config.dashed_idents);
    config.animation = flag("animation", config.animation);
    config.grid = flag("grid", config.grid);
    config.custom_idents = flag("custom_idents", config.custom_idents);
    config.container = flag("container", config.container);
    config.pure = flag("pure", config.pure);
  }
  Ok(Some(config))
}

fn deferred(tokens: &TokenList) -> bool {
  tokens.0.iter().any(|token| match token {
    TokenOrValue::Var(_) | TokenOrValue::Env(_) => true,
    TokenOrValue::Function(f) => deferred(&f.arguments),
    _ => false,
  })
}

fn warnings_to_json<T: std::fmt::Display>(warnings: &Arc<RwLock<Vec<T>>>) -> Value {
  match warnings.read() {
    Ok(list) => Value::Array(list.iter().map(|w| Value::String(w.to_string())).collect()),
    Err(_) => Value::Array(vec![]),
  }
}

fn fail(stage: &str, error: String) -> Value {
  json!({"ok": false, "stage": stage, "error": error})
}

fn run_sheet(request: &Value) -> Value {
  let css = match request["css"].as_str() {
    Some(css) => css,
    None => return fail("request", "missing css".into()),
  };
  let targets = match targets(request) {
    Ok(t) => t,
    Err(e) => return fail("request", e),
  };
  let flags = match flags(request) {
    Ok(f) => f,
    Err(e) => return fail("request", e),
  };
  let css_modules = match css_modules(request) {
    Ok(c) => c,
    Err(e) => return fail("request", e),
  };
  let warnings = Arc::new(RwLock::new(Vec::new()));
  let options = ParserOptions {
    // Default "" = ParserOptions::default(); CSS module hashes depend on it.
    filename: request["filename"].as_str().unwrap_or("").to_string(),
    css_modules,
    error_recovery: request["error_recovery"].as_bool().unwrap_or(false),
    warnings: Some(warnings.clone()),
    flags,
    ..ParserOptions::default()
  };
  let mut sheet = match StyleSheet::parse(css, options) {
    Ok(sheet) => sheet,
    Err(e) => return fail("parse", format!("{e} | {:?}", e.kind)),
  };
  if request["minify"].as_bool().unwrap_or(false) {
    let unused_symbols: HashSet<String> = request["unused_symbols"]
      .as_array()
      .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
      .unwrap_or_default();
    if let Err(e) = sheet.minify(MinifyOptions {
      targets,
      unused_symbols,
    }) {
      return fail("minify", format!("{e} | {:?}", e.kind));
    }
  }
  // Absent: the printer gets the same targets as minify() (what most test helpers do).
  // null: printer defaults (custom_media_test). Object: separate printer browsers.
  let printer_targets = match request.get("printer_targets") {
    None => targets,
    Some(Value::Null) => Targets::default(),
    // {"browsers": .., "include": .., "exclude": ..}: full printer Targets (test_with_printer_options)
    Some(v) if v.get("browsers").is_some() || v.get("include").is_some() || v.get("exclude").is_some() => {
      match browsers(&v["browsers"]) {
        Ok(b) => Targets {
          browsers: b,
          include: Features::from_bits_truncate(v["include"].as_u64().unwrap_or(0) as u32),
          exclude: Features::from_bits_truncate(v["exclude"].as_u64().unwrap_or(0) as u32),
        },
        Err(e) => return fail("request", e),
      }
    }
    Some(v) => match browsers(v) {
      Ok(b) => Targets {
        browsers: b,
        ..Targets::default()
      },
      Err(e) => return fail("request", e),
    },
  };
  let result = match sheet.to_css(PrinterOptions {
    minify: request["compact"].as_bool().unwrap_or(false),
    targets: printer_targets,
    ..PrinterOptions::default()
  }) {
    Ok(r) => r,
    Err(e) => return fail("print", format!("{e} | {:?}", e.kind)),
  };
  // Sorted by name: older revisions use a HashMap, whose iteration order is random.
  let exports = match &result.exports {
    Some(exports) => {
      let mut entries: Vec<(String, String)> = exports
        .iter()
        .map(|(name, export)| (name.clone(), format!("{export:?}")))
        .collect();
      entries.sort();
      let mut map = Map::new();
      for (name, export) in entries {
        map.insert(name, Value::String(export));
      }
      Value::Object(map)
    }
    None => Value::Null,
  };
  json!({"ok": true, "code": result.code, "warnings": warnings_to_json(&warnings), "exports": exports})
}

fn run_attr(request: &Value) -> Value {
  let css = match request["css"].as_str() {
    Some(css) => css,
    None => return fail("request", "missing css".into()),
  };
  let targets = match targets(request) {
    Ok(t) => t,
    Err(e) => return fail("request", e),
  };
  let mut attr = match StyleAttribute::parse(css, ParserOptions::default()) {
    Ok(attr) => attr,
    Err(e) => return fail("parse", format!("{e} | {:?}", e.kind)),
  };
  if request["minify"].as_bool().unwrap_or(false) {
    attr.minify(MinifyOptions {
      targets,
      ..MinifyOptions::default()
    });
  }
  match attr.to_css(PrinterOptions {
    minify: request["compact"].as_bool().unwrap_or(false),
    targets,
    ..PrinterOptions::default()
  }) {
    Ok(r) => json!({"ok": true, "code": r.code, "warnings": [], "exports": null}),
    Err(e) => fail("print", format!("{e} | {:?}", e.kind)),
  }
}

/// A single property value, as a CSSOM setter would receive it (WPT parsing tests).
fn run_property(request: &Value) -> Value {
  let (name, value) = match (request["property"].as_str(), request["value"].as_str()) {
    (Some(n), Some(v)) => (n, v),
    _ => return fail("request", "missing property/value".into()),
  };
  let targets = match targets(request) {
    Ok(t) => t,
    Err(e) => return fail("request", e),
  };
  let mut input = ParserInput::new(value);
  let mut parser = Parser::new(&mut input);
  // A setter accepts one value, not a declaration list: reject trailing `;`/`!important`.
  let property = match Property::parse(PropertyId::from(name), &mut parser, &ParserOptions::default()) {
    Ok(p) => p,
    Err(e) => return fail("parse", format!("{e:?}")),
  };
  if let Err(e) = parser.expect_exhausted() {
    return fail("parse", format!("{e:?}"));
  }
  let recognition = match &property {
    Property::Custom(p) => match p.name {
      CustomPropertyName::Custom(_) => "custom-property",
      CustomPropertyName::Unknown(_) => "unknown-property",
    },
    Property::Unparsed(p) if deferred(&p.value) => "deferred",
    Property::Unparsed(_) => {
      let printed = property
        .value_to_css_string(PrinterOptions::default())
        .unwrap_or_default()
        .to_ascii_lowercase();
      if matches!(
        printed.as_str(),
        "initial" | "inherit" | "unset" | "revert" | "revert-layer"
      ) {
        "css-wide"
      } else {
        "unparsed"
      }
    }
    _ => "typed",
  };
  let mut style = match StyleAttribute::parse("", ParserOptions::default()) {
    Ok(s) => s,
    Err(e) => return fail("parse", e.to_string()),
  };
  style.declarations.declarations.push(property);
  if request["minify"].as_bool().unwrap_or(false) {
    style.minify(MinifyOptions {
      targets,
      ..MinifyOptions::default()
    });
  }
  match style.to_css(PrinterOptions {
    minify: request["compact"].as_bool().unwrap_or(false),
    targets,
    ..PrinterOptions::default()
  }) {
    Ok(r) => json!({"ok": true, "code": r.code, "warnings": [], "exports": null, "recognition": recognition}),
    Err(e) => fail("print", e.to_string()),
  }
}

/// A property value parsed on its own and printed with value_to_css_string, like the repo's
/// `property_range_test` helper. `recognition` tells typed values from preserved (unparsed) ones.
fn run_value(request: &Value) -> Value {
  let (name, value) = match (request["property"].as_str(), request["value"].as_str()) {
    (Some(n), Some(v)) => (n, v),
    _ => return fail("request", "missing property/value".into()),
  };
  let property = match Property::parse_string(PropertyId::from(name), value, ParserOptions::default()) {
    Ok(p) => p,
    Err(e) => return fail("parse", format!("{e:?}")),
  };
  let recognition = match &property {
    Property::Unparsed(_) => "unparsed",
    Property::Custom(_) => "custom",
    _ => "typed",
  };
  match property.value_to_css_string(PrinterOptions {
    minify: request["compact"].as_bool().unwrap_or(true),
    ..PrinterOptions::default()
  }) {
    Ok(code) => json!({"ok": true, "code": code, "warnings": [], "exports": null, "recognition": recognition}),
    Err(e) => fail("print", e.to_string()),
  }
}

fn run(request: &Value) -> Value {
  match request["kind"].as_str().unwrap_or("sheet") {
    "sheet" => run_sheet(request),
    "attr" => run_attr(request),
    "property" => run_property(request),
    "value" => run_value(request),
    other => fail("request", format!("unknown kind {other}")),
  }
}

fn main() {
  // Keep panics out of stderr noise; the message is returned in the response.
  std::panic::set_hook(Box::new(|_| {}));
  let stdout = io::stdout();
  let mut out = stdout.lock();
  for line in io::stdin().lock().lines() {
    let line = match line {
      Ok(l) => l,
      Err(_) => break,
    };
    if line.trim().is_empty() {
      continue;
    }
    let request: Value = match serde_json::from_str(&line) {
      Ok(v) => v,
      Err(e) => {
        writeln!(out, "{}", json!({"id": null, "ok": false, "stage": "request", "error": e.to_string()})).unwrap();
        out.flush().unwrap();
        continue;
      }
    };
    let id = request["id"].clone();
    let mut response = match std::panic::catch_unwind(|| run(&request)) {
      Ok(v) => v,
      Err(payload) => {
        let message = payload
          .downcast_ref::<String>()
          .map(String::as_str)
          .or_else(|| payload.downcast_ref::<&str>().copied())
          .unwrap_or("non-string panic payload");
        fail("panic", message.to_string())
      }
    };
    response["id"] = id;
    writeln!(out, "{response}").unwrap();
    out.flush().unwrap();
  }
}
