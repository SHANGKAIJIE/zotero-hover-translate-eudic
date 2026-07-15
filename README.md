# Hover Translate Eudic

> 鼠标悬停 / 单击 PDF 中的单词即可翻译，复用 **Translate for Zotero** 的翻译引擎，并支持一键同步生词本到 **欧路词典 (Eudic)** 或 **墨墨背单词 (Maimemo)** 云端。

[![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209-blue)](https://www.zotero.org/)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-green)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.9-orange)](https://github.com/SHANGKAIJIE/zotero-hover-translate-eudic/releases)

---

## ✨ 功能特性

- **多种取词触发方式**
  - `悬停`：鼠标悬停到单词上，延迟后自动翻译（可配置延迟）。
  - `修饰键 + 悬停`：按住 `Ctrl` / `Alt` / `Shift`（可组合）悬停即翻译；也支持**先悬停再按下修饰键**。
  - `鼠标左键单击`：单击单词即翻译，无需保持按键。
- **复用 Translate for Zotero 引擎**：翻译结果、字典释义、多语种翻译服务直接复用已安装的 Translate 插件。
- **一键同步欧路 / 墨墨生词本**：翻译弹窗内点击 `+生词本`，将当前单词加入云端指定生词本。支持**欧路词典**与**墨墨背单词**双平台切换。
- **编辑云端生词本**：设置面板中直接浏览所有生词本，支持添加、重命名、删除操作。
- **独立高亮**：取词时可选对单词施加高亮，颜色（R/G/B/A 四通道）与开关完全独立配置，不依赖翻译开关。
- **深色模式自适应**：翻译弹窗跟随 Zotero（含 zotero-style 等主题插件）的深色 / 浅色模式自动切换配色。
- **弹窗自动关闭**：可设置弹窗自动关闭延时（0 = 不自动关闭）。

---

## 📦 安装

### 方式一：插件市场安装（推荐）

1. 在 Zotero 中：`工具` → `插件` → 右上角齿轮 → `Install Add-on from Zotero-CN Plugin Market`
2. 搜索 **Hover Translate Eudic**，点击安装。
3. 重启 Zotero。

### 方式二：下载 Release 安装

1. 前往 [Releases](https://github.com/SHANGKAIJIE/zotero-hover-translate-eudic/releases) 页面。
2. 下载最新版本的 `hover-translate-eudic.xpi` 文件。
3. 在 Zotero 中：`工具` → `插件` → 右上角齿轮 → `Install Add-on From File...` → 选择下载的 `.xpi`。
4. 重启 Zotero。

> ⚠️ 若浏览器将 `.xpi` 当作压缩包下载，请右键「链接另存为」并确保后缀为 `.xpi`。

### 方式三：从源码编译

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

设置面板按功能分为四个区块：

### 基础功能设置

**启用高亮**：勾选后，鼠标取词时对单词施加高亮标记。

**高亮颜色**：通过 `R`（红）、`G`（绿）、`B`（蓝，0–255）与 `A`（透明度，0–100%）四个数字框精确调整高亮色，或直接用颜色选择器拾取。

**启用悬停翻译(插件总开关)**：控制插件的取词翻译功能是否启用。取消勾选后，取词触发方式 / 悬停延迟 / 弹窗关闭 / 显示模式均变为灰色不可操作。

**取词触发方式**：在三种触发方式中选择一种：

| 模式 | 说明 |
| --- | --- |
| 悬停 | 鼠标悬停到单词上触发，延迟可在「悬停触发延迟」中设置。 |
| 修饰键 + 悬停 | 选中下方修饰键（Ctrl/Alt/Shift 可组合），悬停即翻译；支持先悬停后按修饰键。 |
| 鼠标左键单击 | 单击单词即翻译，悬停延迟设置在此模式下禁用。 |

**悬停触发延迟**：设置悬停触发翻译的延迟时间（单位：毫秒）。

**弹窗自动关闭**：设置翻译弹窗自动关闭的延时，设为 0 则不自动关闭。

**翻译显示模式**：控制翻译弹窗中的内容：
| 模式 | 说明 |
| --- | --- |
| 简单翻译 | 仅显示一个译文结果，快速看懂。 |
| 完整释义 | 翻译结果外附加字典释义，深挖词义。 |

**选中文字时禁用悬停**：勾选后，鼠标划词选择文本时自动隐藏悬停窗口，避免与 Translate for Zotero 的划词翻译弹窗冲突。

### 生词本设置

**生词本平台**：选择同步目标平台 — **欧路词典** 或 **墨墨背单词**。

#### 欧路词典

插件通过欧路 OpenAPI 同步生词本，需要一个 **NIS Token**：
1. 登录[欧路 OpenAPI 获取授权](https://my.eudic.net/OpenAPI/Authorization)。
2. 在插件设置中填入 Token（格式为 `NIS <你的token>`，支持带或不带前缀）。
3. 点击「刷新列表」拉取你的生词本。

#### 墨墨背单词

插件通过墨墨开放 API 同步云词本，需要一个 **Access Token**：
1. 登录[墨墨开放平台](https://open.maimemo.com/open/api/v1/tokens/openapi)，申请 Access Token。
2. 在插件设置中填入 Token。
3. 点击「刷新列表」拉取你的云词本。

> ⚠️ **注意**：墨墨开放平台 Access Token 有效期仅 **24 小时**，过期后需重新获取。Token 过期时插件会弹窗提醒。

**选择生词本**：从拉取的生词本列表中选择目标词本，翻译弹窗点击 `+生词本` 时加入该词本。

**编辑词本**：打开弹窗直接浏览所有生词本，支持**添加**新词本、**重命名**已有词本、**删除**词本操作。

**按钮显示场景**：控制翻译弹窗中 `+生词本` 按钮的显示条件：
| 选项 | 说明 |
| --- | --- |
| 悬停 + 划词都显示 | 悬停翻译弹窗和划词按钮中都显示 |
| 仅悬停翻译显示 | 仅在悬停翻译弹窗中显示 |
| 仅划词翻译显示 | 仅在划词翻译按钮中显示 |

**加词方式**：`手动点击按钮添加` 或 `翻译后自动加入生词本`。

**词形选择**（仅欧路词典）：控制添加到生词本时是否进行词形还原——

| 选项 | 说明 |
| --- | --- |
| 还原为单词原型 | 调用词形还原引擎（BNC 词典 + 不规则表 + 后缀规则），将变形词转为原型后上传 |
| 保留变形词（复数 / 过去式 等）| 直接以上下文中的词形上传，不进行词形还原 |

> 建议选择「单词原型」，变形词加入生词本可能导致缺少音标和释义。此选项仅对欧路词典生效；墨墨背单词在 App 展示层已自动归一化为词典原型。

**单词语言**：设置加入生词本的单词语言（en/fr/de/es 等）。

### 导出生词本

**导出格式**：支持 CSV / TSV / TXT / JSON 四种格式。
**保存路径**：自定义导出文件保存位置。
**自动定位文件**：勾选后导出完成自动打开文件管理器定位导出文件。
**导出说明**：
- 若导出文件内容有问题，可尝试再导出一次。
- 墨墨背单词只能导出单词列表，不含音标/释义，因此导出文件只包含单词列。

### 其他设置

**重置所有设置**：将插件所有配置恢复到默认值。
**帮助与关于**：查看插件主页、版本号与构建时间信息。

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
│   │   ├── lemmatize.ts      # 英文词形还原（变形词→原型）v0.1.6
│   │   ├── maimemo.ts        # 墨墨背单词 OpenAPI 客户端 v0.1.5
│   │   ├── eudicExport.ts    # 生词本导出（CSV/TSV/TXT/JSON）
│   │   ├── preferenceScript.ts # 设置面板交互逻辑
│   │   ├── selectionButton.ts  # 选区翻译按钮
│   │   └── util.ts            # 单词提取/验证工具
│   └── utils/                # 工具函数（prefs 等）
├── addon/                    # 插件静态资源
│   ├── content/
│   │   ├── preferences.xhtml         # 设置面板
│   │   ├── edit-wordbook-dialog.xhtml # 编辑词本弹窗（v0.1.4）
│   │   └── icons/                    # 插件图标
│   ├── locale/               # 多语言（zh-CN / en-US）
│   └── prefs.js
├── .scaffold/build/          # 构建产物（已被 .gitignore 忽略）
├── package.json
└── README.md
```

---

## 📄 开源协议

本项目基于 [AGPL-3.0-or-later](./LICENSE) 开源。

---

## 🙏 感谢

本项目基于以下仓库或 API 实现：

- [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) — Zotero 插件模板
- [windingwind/zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate) — PDF 翻译引擎复用
- [bulletproof-system/zotero-maimemo-sync](https://github.com/bulletproof-system/zotero-maimemo-sync) — 墨墨背单词同步参考
- [墨墨开放 API](https://open.maimemo.com/) — 墨墨背单词云词本接口
- [欧路 OpenAPI 获取授权](https://my.eudic.net/OpenAPI/Authorization) — 欧路词典 OpenAPI 授权获取
