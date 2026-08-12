import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const required = [
  'manifest_version',
  'name',
  'version',
  'background',
  'permissions',
  'host_permissions',
  'content_scripts',
];

const missing = required.filter((key) => !(key in manifest));
if (missing.length) {
  console.error(`manifest.json 缺少字段：${missing.join(', ')}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) {
  console.error('当前项目应使用 Manifest V3');
  process.exit(1);
}

console.log(`manifest.json OK: ${manifest.name} v${manifest.version}`);
