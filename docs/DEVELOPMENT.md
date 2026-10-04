# BiliShelf 开发说明

## 目录结构

```text
.
├─ manifest.json          # Manifest V3 配置
├─ background.js          # 后台 Service Worker，负责接口请求、标签页、取消收藏等
├─ content.js             # 注入 B 站页面，负责悬停预览、U 快捷键、页面事件同步
├─ page-hook.js           # 注入页面环境，用于监听页面内请求
├─ preview-frame.js       # 注入 B 站播放器 iframe，设置倍速、静音、预览时长等
├─ sidepanel.html         # 侧边栏页面
├─ sidepanel.css          # 侧边栏样式
├─ sidepanel.js           # 侧边栏逻辑、IndexedDB 缓存、排序、导出、回收站
├─ docs/                  # 文档
└─ .github/workflows/     # GitHub Actions
```

## 调试

- 侧边栏调试：在扩展管理页找到本扩展，点击“检查视图”。
- content script 调试：打开 B 站页面控制台。
- background 调试：扩展管理页中打开 Service Worker 调试窗口。

## 版本发布

修改版本号：

- `manifest.json` 的 `version`
- `README.md` 标题和对应说明
- `CHANGELOG.md`

提交后打标签：

```bash
git tag v0.5.9
git push origin v0.5.9
```

GitHub Actions 会自动打包扩展 zip 并上传到 Release。
