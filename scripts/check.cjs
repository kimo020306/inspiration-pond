const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../dist');
for (const name of ['core.js', 'database.js', 'app.js', 'drawing.js', 'sw.js']) new vm.Script(fs.readFileSync(path.join(root, name), 'utf8'), { filename: name });
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
for (const match of (html + css).matchAll(/(?:src|href)="([^"#]+)"|url\(['"]?([^)'"\s]+)['"]?\)/g)) {
  const value = match[1] || match[2];
  if (/^(?:https?:|data:|#)/.test(value)) continue;
  if (!fs.existsSync(path.join(root, value))) throw new Error('Missing asset: ' + value);
}
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate HTML id');
JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
if (/transition:\s*all/.test(css)) throw new Error('Use specific transition properties');
console.log('脚本语法、静态资源、页面编号与 PWA 清单检查通过');
