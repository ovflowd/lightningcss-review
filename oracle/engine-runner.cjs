'use strict';
// Runs prepared oracle jobs in one engine profile (one Playwright image). Written for Node >= 14
// and old Playwright releases: only chromium/firefox/webkit.launch, newPage, setContent,
// evaluate and screenshot are used. All normalization happens later in compare.mjs.
//
// usage: node engine-runner.cjs --jobs jobs.jsonl --out results.jsonl --profile latest
//        [--engines chromium,firefox,webkit] [--screenshots DIR]
//        node engine-runner.cjs --versions
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const playwright = require('playwright');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const ENGINES = opt('--engines', 'chromium,firefox,webkit').split(',').filter(Boolean);
const SKELETON =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<style>html,body{margin:0;padding:0}#lcr-root{width:800px}</style>' +
  '<style id="lcr-style"></style></head><body><div id="lcr-root"></div></body></html>';

// ---------------------------------------------------------------------------------------------
// In-page code. Must run in old engines (Chromium 100+, Firefox 98+, WebKit 15.4+).

function pageSnapshot(job) {
  var root = document.getElementById('lcr-root');
  var styleEl = document.getElementById('lcr-style');
  root.innerHTML = job.html || '';
  var attrs = job.rootAttrs || {};
  Object.keys(attrs).forEach(function (k) {
    document.documentElement.setAttribute(k, attrs[k]);
  });
  var els = [document.documentElement, document.body];
  var all = root.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) els.push(all[i]);
  var pseudos = [null].concat(job.pseudos || []);
  var propsFilter = job.props ? new Set(job.props) : null;

  function read(el, pseudo) {
    var cs = getComputedStyle(el, pseudo);
    var out = {};
    if (propsFilter) {
      propsFilter.forEach(function (p) {
        out[p] = cs.getPropertyValue(p);
      });
    } else {
      for (var i = 0; i < cs.length; i++) out[cs[i]] = cs.getPropertyValue(cs[i]);
    }
    return out;
  }
  function label(el) {
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    var idx = Array.prototype.indexOf.call(all, el);
    return el.tagName.toLowerCase() + '#' + idx;
  }
  function describeRules(list, out) {
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var entry = { type: r.constructor && r.constructor.name ? r.constructor.name : String(r.type) };
      if (r.selectorText !== undefined) entry.selector = r.selectorText;
      if (r.style && r.style.length !== undefined) entry.decls = r.style.length;
      if (r.media && r.media.mediaText !== undefined) entry.media = r.media.mediaText;
      if (r.conditionText !== undefined) entry.condition = r.conditionText;
      if (r.name !== undefined) entry.name = r.name;
      out.push(entry);
      if (r.cssRules) describeRules(r.cssRules, out);
    }
    return out;
  }
  // Probe whether this engine accepts a declaration / selector / at-rule prelude.
  var scratch = document.createElement('style');
  document.head.appendChild(scratch);
  function acceptsDecl(prop, value, important) {
    var s = document.createElement('div').style;
    s.setProperty(prop, value, important ? 'important' : '');
    return s.length > 0 || s.getPropertyValue(prop) !== '';
  }
  function acceptsSelector(sel) {
    try {
      scratch.sheet.insertRule(sel + '{}', 0);
      scratch.sheet.deleteRule(0);
      return true;
    } catch (e) {
      return false;
    }
  }
  function acceptsPrelude(kind, prelude) {
    try {
      scratch.sheet.insertRule('@' + kind + ' ' + prelude + '{}', 0);
      var r = scratch.sheet.cssRules[0];
      var ok = true;
      if (kind === 'media' && r.media) ok = r.media.mediaText !== 'not all';
      scratch.sheet.deleteRule(0);
      return ok;
    } catch (e) {
      return false;
    }
  }

  var result = { elements: els.map(label), variants: {} };
  var variants = Object.keys(job.sheets);
  for (var v = 0; v < variants.length; v++) {
    var name = variants[v];
    styleEl.textContent = job.sheets[name];
    var snap = {};
    for (var e = 0; e < els.length; e++) {
      for (var p = 0; p < pseudos.length; p++) {
        snap[label(els[e]) + (pseudos[p] || '')] = read(els[e], pseudos[p]);
      }
    }
    var info = { rules: styleEl.sheet ? describeRules(styleEl.sheet.cssRules, []) : null };
    var probe = (job.probe && job.probe[name]) || null;
    if (probe) {
      info.decls = (probe.decls || []).map(function (d) {
        return acceptsDecl(d[0], d[1], d[2]);
      });
      info.selectors = (probe.selectors || []).map(acceptsSelector);
      info.preludes = (probe.preludes || []).map(function (a) {
        return acceptsPrelude(a[0], a[1]);
      });
    }
    result.variants[name] = { snap: snap, info: info };
  }
  styleEl.textContent = '';
  scratch.remove();
  // Return only what differs from the reference variant, plus the reference itself for the
  // properties that the input touched (differs from the empty sheet).
  var ref = result.variants[job.reference || 'input'];
  var empty = result.variants.empty;
  var packed = { elements: result.elements, variants: {} };
  variants.forEach(function (name) {
    var cur = result.variants[name];
    var entry = { info: cur.info };
    if (name === (job.reference || 'input')) {
      var touched = {};
      Object.keys(cur.snap).forEach(function (key) {
        var vals = cur.snap[key];
        var base = empty ? empty.snap[key] : null;
        Object.keys(vals).forEach(function (prop) {
          if (!base || base[prop] !== vals[prop] || job.props) {
            (touched[key] = touched[key] || {})[prop] = vals[prop];
          }
        });
      });
      entry.touched = touched;
    } else if (name !== 'empty') {
      var diff = [];
      Object.keys(cur.snap).forEach(function (key) {
        var vals = cur.snap[key];
        var r = ref.snap[key] || {};
        Object.keys(vals).forEach(function (prop) {
          if (r[prop] !== vals[prop]) diff.push([key, prop, r[prop] === undefined ? null : r[prop], vals[prop]]);
        });
        Object.keys(r).forEach(function (prop) {
          if (!(prop in vals)) diff.push([key, prop, r[prop], null]);
        });
      });
      entry.diff = diff;
      if (job.props) entry.values = cur.snap;
    }
    packed.variants[name] = entry;
  });
  return packed;
}

// CSSOM-level check for a single property value (WPT parsing tests), adapted from the browser
// oracle in parcel-bundler/lightningcss#1328 (wpt/browser.mjs, Devon Govett, MPL-2.0).
function pageProperty(job) {
  var property = job.property;
  var original = document.createElement('div').style;
  original.setProperty(property, job.value);
  var read = original.getPropertyValue(property);
  var out = { baseline: null, variants: {} };
  var matches = function (actual, expected) {
    return Array.isArray(expected) ? expected.indexOf(actual) >= 0 : actual === expected;
  };
  if (job.wptKind === 'invalid') {
    if (read !== '') out.baseline = { status: 'baseline-failure', actual: read };
  } else if (!read) {
    out.baseline = { status: 'baseline-unsupported', actual: '' };
  } else if (job.wptKind === 'valid' && job.expected !== undefined && !matches(read, job.expected)) {
    out.baseline = { status: 'baseline-failure', actual: read, expected: job.expected };
  }
  Object.keys(job.outputs).forEach(function (name) {
    var output = job.outputs[name];
    if (output === null) {
      out.variants[name] = { status: 'no-output' };
      return;
    }
    var transformed = document.createElement('div').style;
    transformed.cssText = output;
    if (job.wptKind === 'invalid') {
      if (transformed.length) {
        out.variants[name] = { status: 'invalid-became-valid', code: transformed.cssText };
        return;
      }
      var o2 = document.createElement('div').style;
      o2.setProperty(property, 'initial');
      if (!o2.length) {
        out.variants[name] = { status: 'baseline-unsupported-property' };
        return;
      }
      var fallback = o2.cssText;
      o2.setProperty(property, job.value);
      var t2 = document.createElement('div').style;
      t2.cssText = fallback + ';' + output;
      out.variants[name] = o2.cssText === t2.cssText ? { status: 'pass' } : { status: 'fallback-changed', original: o2.cssText, transformed: t2.cssText };
      return;
    }
    if (!read) {
      out.variants[name] = { status: transformed.length ? 'unsupported-input' : 'both-unsupported' };
      return;
    }
    if (!transformed.length) {
      out.variants[name] = { status: 'valid-became-invalid' };
      return;
    }
    var names = {};
    Array.prototype.forEach.call(original, function (n) { names[n] = 1; });
    Array.prototype.forEach.call(transformed, function (n) { names[n] = 1; });
    names[property] = 1;
    var differences = Object.keys(names)
      .map(function (n) { return { property: n, original: original.getPropertyValue(n), transformed: transformed.getPropertyValue(n) }; })
      .filter(function (x) { return x.original !== x.transformed; });
    // Shorthand reset probe: longhands preseeded to inherit must be reset by both.
    var longhands = Array.prototype.slice.call(original);
    if (longhands.length > 1) {
      var seededO = document.createElement('div').style;
      var seededT = document.createElement('div').style;
      longhands.forEach(function (n) { seededO.setProperty(n, 'inherit'); });
      var before = seededO.cssText;
      seededO.setProperty(property, job.value);
      seededT.cssText = before + ';' + output;
      var missing = longhands.filter(function (n) {
        return seededO.getPropertyValue(n) !== 'inherit' && seededT.getPropertyValue(n) === 'inherit';
      });
      if (missing.length) {
        out.variants[name] = { status: 'shorthand-reset-changed', properties: missing };
        return;
      }
    }
    if (!differences.length) {
      out.variants[name] = { status: 'pass' };
      return;
    }
    if (/(?:url\(|var\(|env\()/i.test(output)) {
      out.variants[name] = { status: 'context-required', differences: differences };
      return;
    }
    var root = document.getElementById('lcr-root');
    var make = function (cssText) {
      var c = document.createElement('div');
      c.style.cssText = 'width:800px;height:600px;font:16px serif;color:black';
      var el = document.createElement('div');
      el.style.cssText = cssText;
      c.appendChild(el);
      root.appendChild(c);
      return { c: c, el: el };
    };
    var a = make(original.cssText);
    var b = make(transformed.cssText);
    var sa = getComputedStyle(a.el);
    var sb = getComputedStyle(b.el);
    var computed = differences.map(function (d) {
      return { property: d.property, original: sa.getPropertyValue(d.property), transformed: sb.getPropertyValue(d.property) };
    });
    a.c.remove();
    b.c.remove();
    var differs = computed.filter(function (x) { return x.original !== x.transformed; });
    out.variants[name] = differs.length
      ? { status: 'computed-difference', differences: differences, computed: computed }
      : { status: 'contextual-match', differences: differences };
  });
  return out;
}

// ---------------------------------------------------------------------------------------------

async function versions() {
  let pw = 'unknown';
  try {
    pw = require('playwright/package.json').version;
  } catch (_) {
    try {
      pw = require(require('path').join(require.resolve('playwright'), '..', 'package.json')).version;
    } catch (__) {}
  }
  const out = { playwright: pw, node: process.version };
  for (const name of ENGINES) {
    try {
      const browser = await playwright[name].launch();
      out[name] = browser.version();
      await browser.close();
    } catch (e) {
      out[name] = 'ERROR: ' + String(e.message || e).split('\n')[0];
    }
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

async function readJobs(file) {
  const jobs = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of rl) if (line.trim()) jobs.push(JSON.parse(line));
  return jobs;
}

async function runEngine(name, jobs, out, shotsDir) {
  const browser = await playwright[name].launch();
  const version = browser.version();
  const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, colorScheme: 'light' });
  let page = await context.newPage();
  await page.setContent(SKELETON);
  for (const job of jobs) {
    const started = Date.now();
    let record;
    try {
      if (job.kind === 'property') {
        record = { result: await page.evaluate(pageProperty, job) };
      } else {
        if (job.colorScheme) await page.emulateMedia({ colorScheme: job.colorScheme });
        record = { result: await page.evaluate(pageSnapshot, job) };
        if (job.visual && shotsDir) {
          record.shots = {};
          for (const variant of Object.keys(job.sheets)) {
            if (variant === 'empty') continue;
            await page.evaluate(
              ({ html, css }) => {
                document.getElementById('lcr-root').innerHTML = html;
                document.getElementById('lcr-style').textContent = css;
              },
              { html: job.html || '', css: job.sheets[variant] }
            );
            const handle = await page.$('#lcr-root');
            const buf = await handle.screenshot();
            const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
            record.shots[variant] = hash;
            const file = path.join(shotsDir, `${job.id}.${name}.${variant}.png`);
            fs.writeFileSync(file, buf);
          }
          await page.evaluate(() => {
            document.getElementById('lcr-style').textContent = '';
          });
        }
        if (job.colorScheme) await page.emulateMedia({ colorScheme: 'light' });
      }
    } catch (e) {
      record = { error: String(e && e.message ? e.message : e).split('\n').slice(0, 3).join(' ') };
      // A crashed or wedged page is replaced so one bad case cannot poison the rest.
      try {
        await page.close();
      } catch (_) {}
      page = await context.newPage();
      await page.setContent(SKELETON);
    }
    record.id = job.id;
    record.engine = name;
    record.version = version;
    record.ms = Date.now() - started;
    out.write(JSON.stringify(record) + '\n');
  }
  await browser.close();
}

async function main() {
  if (args.includes('--versions')) return versions();
  const jobsFile = opt('--jobs');
  const outFile = opt('--out');
  if (!jobsFile || !outFile) throw new Error('usage: engine-runner.cjs --jobs FILE --out FILE');
  const jobs = await readJobs(jobsFile);
  const shotsDir = opt('--screenshots', null);
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
  const out = fs.createWriteStream(outFile);
  for (const name of ENGINES) {
    // propsByEngine: legacy runs read only the properties the reference engine of the same family
    // saw the input touch.
    const subset = jobs
      .filter((j) => !j.engines || j.engines.indexOf(name) >= 0)
      .map((j) => (j.propsByEngine ? Object.assign({}, j, { props: j.propsByEngine[name] || [] }) : j));
    if (subset.length) await runEngine(name, subset, out, shotsDir);
  }
  await new Promise((resolve) => out.end(resolve));
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e) + '\n');
  process.exit(2);
});
