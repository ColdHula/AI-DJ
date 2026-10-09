// Builds dist/ai-dj.html: one self-contained page with every script inlined.
// Usage: node build.js
const fs = require('fs');
const path = require('path');

const root = __dirname;
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// The artifact host supplies its own doctype, charset and viewport.
html = html.replace(/^<!doctype html>\s*/i, '').replace(/^<meta charset="utf-8">\s*/i, '');
html = html.replace(/<meta name="viewport"[^>]*>\s*/i, '');

html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  const code = fs.readFileSync(path.join(root, src), 'utf8').replace(/<\/script/gi, '<\\/script');
  return '<script>\n' + code + '\n</script>';
});

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'ai-dj.html'), html);
console.log('dist/ai-dj.html', (html.length / 1024).toFixed(1) + ' KB');
