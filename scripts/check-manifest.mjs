import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

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

const scriptFiles = [
  'background.js',
  'content.js',
  'page-hook.js',
  'preview-frame.js',
  'sidepanel.js'
];

for (const file of scriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`${file} 语法检查失败：`);
    console.error(result.stderr || result.stdout || `退出码 ${result.status}`);
    process.exit(1);
  }
}

console.log(`JavaScript syntax OK: ${scriptFiles.join(', ')}`);
