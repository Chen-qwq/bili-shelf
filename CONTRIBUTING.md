# BiliShelf 贡献指南

欢迎提交 Issue 和 Pull Request。

## 开发方式

1. Fork 仓库。
2. 新建分支，例如：

```bash
git checkout -b feat/export-format
```

3. 修改代码后，在 Edge / Chrome 扩展管理页加载仓库根目录进行测试。
4. 提交 PR，并说明改动内容、测试方式和可能影响。

## 代码约定

- 这是 Manifest V3 扩展，当前无构建步骤。
- `manifest.json` 放在仓库根目录。
- 不要提交个人 Cookie、缓存数据、截图里的隐私信息。
- 遇到 B 站接口风控时，不要通过高频请求绕过，应优先降频、缓存、提示用户手动重试。

## 建议的 PR 描述

```text
改动：
- ...

测试：
- Edge 开发者模式加载成功
- 打开侧边栏正常
- 慢速同步正常 / 或说明未测试原因
```
