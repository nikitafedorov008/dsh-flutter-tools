// Dev-only harness: serves the plugin's /flutter route outside DSH, so the
// panel UI and the MCP child can be exercised (and inspected in a browser)
// without installing the plugin into a profile. /flutter/theme-test renders a
// stand-in for the DSH shell that hands the theme over the way the real one
// does — through `document.adoptedStyleSheets`, which a plain `document
// .styleSheets` walk cannot see.
//
//   node dev-server.mjs [port] [workspaceCwd]
import { createServer } from 'node:http'
import { createFlutterPanel } from './index.js'

const port = Number(process.argv[2] ?? 9177)
const cwd = process.argv[3] ?? process.cwd()
const panel = createFlutterPanel()

const THEME_TEST = `<!doctype html>
<html><head><meta charset="utf-8"><title>theme test</title>
<style>body { margin: 0; background: #0b0b0b; }</style></head>
<body>
<iframe id="frame" src="/flutter" style="width: 380px; height: 900px; border: 0"></iframe>
<script>
// ── stand-in for the app: the theme arrives as an ADOPTED stylesheet ─────────
const sheet = new CSSStyleSheet();
sheet.replaceSync(':root{' +
  '--dsw-alias-label-primary:#ff0000;' +
  '--dsw-alias-label-secondary:#00ff00;' +
  '--dsw-alias-label-tertiary:#ffff00;' +
  '--dsw-alias-label-dimmed:#00ffff;' +
  '--dsw-alias-label-primary-foreground:#000000;' +
  '--dsw-alias-button-primary-fill:#ff00ff;' +
  '--dsw-alias-bg-layer-1:#101820;' +
  '--dsw-alias-border-l2:#ffffff;' +
  '--dsw-alias-border-l4:#ffffff;' +
  '--dsw-alias-state-success-primary:#00ff88;' +
  '--dsw-radius-md:2px;}');
document.adoptedStyleSheets = [sheet];

// ── mirror of client.js (keep in sync with the bundle) ──────────────────────
var BUILTIN_TOKENS = ['--dsw-alias-label-primary', '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary', '--dsw-alias-label-dimmed',
  '--dsw-alias-label-primary-foreground', '--dsw-alias-button-primary-fill',
  '--dsw-alias-bg-layer-1', '--dsw-alias-border-l2', '--dsw-alias-border-l4',
  '--dsw-alias-state-success-primary', '--dsw-radius-md'];
function collectTokenNames() {
  var names = new Set(BUILTIN_TOKENS);
  var walk = function (rules) {
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i], style = rule.style;
      if (style) for (var j = 0; j < style.length; j++) if (style[j].slice(0, 6) === '--dsw-') names.add(style[j]);
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  var sources = [];
  var sheets = document.styleSheets || [];
  for (var s = 0; s < sheets.length; s++) sources.push(sheets[s]);
  var adopted = document.adoptedStyleSheets || [];
  for (var a = 0; a < adopted.length; a++) sources.push(adopted[a]);
  for (var k = 0; k < sources.length; k++) { try { walk(sources[k].cssRules); } catch (e) {} }
  return names;
}
function readToken(view, name) {
  var scope = [document.documentElement, document.body];
  for (var i = 0; i < scope.length; i++) {
    if (!scope[i]) continue;
    var value = view.getComputedStyle(scope[i]).getPropertyValue(name);
    if (value && value.trim() !== '') return value.trim();
  }
  return '';
}
function applyTheme(frame) {
  if (!frame) return;
  var target = frame.contentDocument && frame.contentDocument.documentElement;
  if (!target) return;
  var view = document.defaultView, source = document.documentElement;
  var copied = 0;
  collectTokenNames().forEach(function (name) {
    var value = readToken(view, name);
    if (value === '') return;
    target.style.setProperty(name, value);
    copied += 1;
  });
  var colorScheme = view.getComputedStyle(source).colorScheme;
  if (colorScheme) target.style.colorScheme = colorScheme;
  var attr = source.getAttribute('class');
  if (attr !== null) target.setAttribute('class', attr);
  window.__copied = copied;
}
var frame = document.getElementById('frame');
var sync = function () { applyTheme(frame); report(); };
function report() {
  var t = frame.contentDocument.documentElement;
  var names = ['--dsw-alias-label-primary','--dsw-alias-label-secondary','--dsw-alias-label-tertiary',
    '--dsw-alias-label-dimmed','--dsw-alias-button-primary-fill','--dsw-alias-state-success-primary','--dsw-radius-md'];
  var lines = ['copied=' + window.__copied];
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    lines.push(n + ' inline=[' + t.style.getPropertyValue(n) + '] computed=[' +
      frame.contentWindow.getComputedStyle(t).getPropertyValue(n) + ']');
  }
  var h2 = frame.contentDocument.querySelector('h2');
  lines.push('h2 computed color=[' + (h2 ? frame.contentWindow.getComputedStyle(h2).color : 'n/a') + ']');
  var pre = document.getElementById('report') || document.createElement('pre');
  pre.id = 'report';
  pre.textContent = lines.join(' | ');
  document.body.appendChild(pre);
}
frame.addEventListener('load', sync);
sync();
setTimeout(sync, 250);
</script>
</body></html>`

const server = createServer((req, res) => {
  if (req.url?.startsWith('/flutter/theme-test') === true) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(THEME_TEST)
    return
  }
  if (req.url?.startsWith('/flutter') !== true) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  panel.handle(req, res)
})

server.listen(port, '127.0.0.1', () => {
  const { port: actual } = server.address()
  console.log(`panel:  http://127.0.0.1:${actual}/flutter?cwd=${encodeURIComponent(cwd)}`)
  console.log(`harness: http://127.0.0.1:${actual}/flutter/theme-test`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    panel.dispose()
    server.close(() => process.exit(0))
  })
}
