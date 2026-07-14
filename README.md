# Hover Translate Eudic

> 鼠标悬停 / 单击 PDF 中的单词即可翻译，复用 **Translate for Zotero** 的翻译引擎，并支持一键将生词同步到 **欧路词典 (Eudic)** 云端生词本。

[![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209-blue)](https://www.zotero.org/)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-green)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-orange)](https://github.com/SHANGKAIJIE/zotero-hover-translate-eudic/releases)

---

## ✨ 功能特性

- **多种取词触发方式**
  - `悬停`：鼠标悬停到单词上，延迟后自动翻译（可配置延迟）。
  - `修饰键 + 悬停`：按住 `Ctrl` / `Alt` / `Shift`（可组合）悬停即翻译；也支持**先悬停再按下修饰键**。
  - `鼠标左键单击`：单击单词即翻译，无需保持按键。
- **复用 Translate for Zotero 引擎**：翻译结果、字典释义、多语种翻译服务直接复用已安装的 Translate 插件。
- **一键同步欧路生词本**：翻译弹窗内点击 `+生词本`，将当前单词加入欧路云端指定生词本（生词本列表可在设置中刷新选择）。
- **独立高亮**：取词时可选对单词施加高亮，颜色（R/G/B/A 四通道）与开关完全独立配置，不依赖翻译开关。
- **深色模式自适应**：翻译弹窗跟随 Zotero（含 zotero-style 等主题插件）的深色 / 浅色模式自动切换配色。
- **弹窗自动关闭**：可设置弹窗自动关闭延时（0 = 不自动关闭）。

---

## 📦 安装

### 方式一：下载 Release 安装（推荐）

1. 前往 [Releases](https://github.com/SHANGKAIJIE/zotero-hover-translate-eudic/releases) 页面。
2. 下载最新版本的 `zotero-hover-translate-eudic.xpi` 文件。
3. 在 Zotero 中：`工具` → `插件` → 右上角齿轮 → `Install Add-on From File...` → 选择下载的 `.xpi`。
4. 重启 Zotero。

> ⚠️ 若浏览器将 `.xpi` 当作压缩包下载，请右键「链接另存为」并确保后缀为 `.xpi`。

### 方式二：从源码编译

```bash
# 1. 安装依赖
npm install

# 2. 开发构建（含类型检查）
npm run build

# 3.（可选）启动热重载开发服务器
npm start
```

构建产物位于 `.scaffold/build/`，其中的 `zotero-hover-translate-eudic.xpi` 即为可安装的插件包。

---

## ⚙️ 配置说明

打开 Zotero：`编辑` → `首选项` → `Hover Translate Eudic`（或在 macOS 上为 `Zotero` → `设置` → `Hover Translate Eudic`）。

### 1. 欧路词典 Token

插件通过欧路 OpenAPI 同步生词本，需要一个 **NIS Token**：

1. 登录欧路词典网页版，按 [欧路 OpenAPI 开发指南](https://my.eudic.net/OpenAPI/doc_api_study) 申请 Token。
2. 在插件设置中填入 Token（格式为 `NIS <你的token>`）。
3. 点击「刷新列表」拉取你的生词本，选择目标生词本。

### 2. 取词触发方式

| 模式 | 说明 |
| --- | --- |
| 悬停 | 鼠标悬停到单词上触发，延迟可在「悬浮触发延迟」中设置。 |
| 修饰键 + 悬停 | 选中下方修饰键（Ctrl/Alt/Shift 可组合），悬停即翻译；支持先悬停后按修饰键。 |
| 鼠标左键单击 | 单击单词即翻译，悬停延迟设置在此模式下禁用。 |

### 3. 高亮颜色

通过 `R`（红）、`G`（绿）、`B`（蓝，0–255）与 `A`（透明度，0–100%）四个数字框精确调整高亮色，或直接用颜色选择器拾取。

---

## 🔧 自动更新

插件 `update_url` 指向 GitHub Releases：

```
https://github.com/SHANGKAIJIE/zotero-hover-translate-eudic/releases/download/release/update.json
```

发布时需在 Releases 中创建名为 `release` 的标签，并附带 `update.json` 与最新的 `.xpi`，Zotero 即可自动检测更新。

---

## 🗂️ 目录结构

```
zotero-hover-translate-eudic/
├── src/                      # TypeScript 源码
│   ├── index.ts              # 插件入口
│   ├── hooks.ts              # Zotero 生命周期钩子
│   ├── modules/
│   │   ├── hoverTranslate.ts # 悬停 / 单击取词 + 翻译弹窗核心逻辑
│   │   ├── eudic.ts          # 欧路 OpenAPI 客户端（生词本同步）
│   │   ├── preferenceScript.ts # 设置面板交互逻辑
│   │   └── selectionButton.ts  # 选区翻译按钮
│   └── utils/                # 工具函数（prefs 等）
├── addon/                    # 插件静态资源
│   ├── content/              # 设置面板 XHTML
│   ├── locale/               # 多语言（zh-CN / en-US）
│   └── prefs.js
├── .scaffold/build/          # 构建产物（已被 .gitignore 忽略）
├── package.json
└── README.md
```

---

## 📄 开源协议

本项目基于 [AGPL-3.0-or-later](./LICENSE) 开源。
