/*
 * プレビュー公開用に、CSS と JS を埋め込んだ 1 ファイルの HTML を dist/ に出力する。
 * 公開先が <html>/<head>/<body> を付けるため、ここでは中身だけを出力する。
 *   node scripts/build-artifact.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('index.html');
const title = /<title>(.*?)<\/title>/.exec(html)[1];
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1]
  .replace(/<script src="([^"]+)"><\/script>/g, (_, src) => `<script>\n${read(src).replace(/<\/script/gi, '<\\/script')}</script>`);

const out = `<title>${title}</title>
<style>
${read('css/style.css')}
</style>
${body.trim()}
`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const file = path.join(root, 'dist', 'site-work-hours.html');
fs.writeFileSync(file, out);
console.log(`${path.relative(root, file)} (${(out.length / 1024).toFixed(1)} KB)`);
