# 灵感池塘

收下看见，留住感受，让碎片慢慢相遇。

一个无需注册的中文灵感记录工具。水蓝色玻璃界面，金鱼暖色点缀，支持手机和桌面。

## 使用

网页文件位于 `dist/`。无需构建或运行时依赖，使用本地服务或 HTTPS 静态托管即可记录。

```sh
npm ci
npm start
```

打开终端显示的 `http://127.0.0.1:4173`。需要 Node.js 22 或更新版本。也可直接打开 `dist/index.html` 查看，但本地文件地址下的存储和安装行为取决于浏览器，请优先使用本地服务。

## GitHub 与部署

源码仓库：[kimo020306/inspiration-pond](https://github.com/kimo020306/inspiration-pond)。

现有网站：[灵感池塘](https://inspiration-pond-kimo.kimo020306.chatgpt.site)。其访问权限由 Sites 管理。

任意静态托管平台的发布目录设为 `dist`，不需要构建命令。GitHub Pages：在仓库 Settings → Pages 中将 Source 设置为 GitHub Actions，然后在 Actions 中手动运行 Deploy to GitHub Pages。私有仓库的 Pages 可用性取决于 GitHub 方案；仓库私有不代表 Pages 网站也私有，请按实际访问需求选择。

Sites 配置位于 `.openai/hosting.json`，绑定原站项目。普通静态托管无需使用这个文件。

- 三个入口：始于看见、始于感受、始于相遇
- 照片、文字、速写（五种笔刷、经典色谱）
- 本地 IndexedDB、新建和编辑草稿、完整备份导出与导入
- 池塘列表与生态视图、随机捞取、灵感关联与创作起点卡

## 数据

记录保存在当前浏览器和网站地址下，不会同步到 GitHub 或自动跨设备同步。换网址或浏览器前，请在“我的池塘 → 备份”导出 JSON，再在新页面导入。

版本 2 的备份包含记录、图片、速写、关联、创作草稿及未完成的记录草稿；兼容版本 1。导入为合并：遇到重复编号保留当前设备的数据。文件先完整校验，再在一个事务中写入，避免半途失败导致部分导入。备份大小上限 64 MB，每条记录最多 9 张照片。

手动输入、存储和已缓存页面不依赖服务器。工具没有云同步和 AI 生成接口，关联提示根据现有线索匹配。

## 项目结构

| 文件 | 用途 |
| --- | --- |
| `dist/index.html` | 页面结构 |
| `dist/styles.css` | 视觉样式与移动布局 |
| `dist/app.js` | 录入、池塘、串联、深化、导出交互 |
| `dist/database.js` | IndexedDB 事务、草稿、完整备份导入 |
| `dist/core.js` | 数据校验、兼容转换与搜索 |
| `dist/sw.js` | 本站静态资源离线缓存 |
| `tests/` | 数据与页面流程回归测试 |

开发测试依赖只用于自动检查，不会加载到网站中。界面不依赖外部 CDN。

## 视觉资源

`assets/pond-water.webp` 为本项目生成的水面与金鱼背景。界面代码不依赖外部 CDN。

## 验证

```sh
npm run check
npm test
```

自动检查包含脚本语法、静态资源、页面编号、PWA 清单、备份格式和数据库写入，以及模拟 DOM 中的完整表单、编辑、串联、深化、焦点流程。检查工作流在 push 和 pull request 时自动运行。

当前已通过 29 项回归测试，包括真实画布像素测试。手机视口布局及鼠标绘画已检查；真实触控笔压感与 Service Worker 离线行为仍需在目标设备验证。

本次修复和验证边界详见 [CHANGELOG.md](CHANGELOG.md)。
