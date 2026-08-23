# 第三方许可证声明 (Third-Party Licenses)

本项目 (Hover Translate Eudic) 基于以下第三方仓库 / 库实现，特此声明其版权与许可证信息。

本项目自身以 [AGPL-3.0-or-later](./LICENSE) 开源。以下列出的第三方组件均保留其原始许可证条款；本项目对相应组件的使用遵循各自许可证的要求。

---

## 1. zotero-plugin-template

- **仓库**: https://github.com/windingwind/zotero-plugin-template
- **作者**: windingwind
- **许可证**: [AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html)
- **用途**: Zotero 插件开发模板（项目脚手架、构建工具链）
- **版权声明**: Copyright (c) windingwind (https://github.com/windingwind)

## 2. zotero-pdf-translate

- **仓库**: https://github.com/windingwind/zotero-pdf-translate
- **作者**: windingwind
- **许可证**: [AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html)
- **用途**: 复用其翻译引擎与字典释义服务（运行时依赖）
- **版权声明**: Copyright (c) windingwind (https://github.com/windingwind)

## 3. zotero-vocab-builder

- **仓库**: https://github.com/Zzq-02/zotero-vocab-builder
- **作者**: Zzq-02
- **许可证**: [AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html)
- **用途**: Zotero 笔记生词本参考实现
- **版权声明**: Copyright (c) Zzq-02 (https://github.com/Zzq-02)

## 4. zotero-maimemo-sync

- **仓库**: https://github.com/bulletproof-system/zotero-maimemo-sync
- **作者**: bulletproof-system
- **许可证**: [AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html)
- **用途**: 墨墨背单词同步参考实现
- **版权声明**: Copyright (c) bulletproof-system (https://github.com/bulletproof-system)

## 5. shanbay-ext (扇贝单词助手 V3)

- **仓库**: https://github.com/honwhy/shanbay-ext
- **作者**: Honwhy Wang
- **许可证**: [MIT](https://opensource.org/licenses/MIT)
- **用途**: 扇贝 API 参考实现；本项目 `src/modules/shanbayDecode.ts` 中的 Trie 解码算法**直接移植**自其 `src/entrypoints/decodes.js`
- **版权声明与许可文本**:

```
MIT License

Copyright (c) 2024 Honwhy Wang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 6. word-translator-zotero (Word Translator for Zotero)

- **仓库**: https://github.com/chen7447/word-translator-zotero
- **作者**: chen7447
- **许可证**: [MIT](https://opensource.org/licenses/MIT)
- **用途**: PDF 右侧生词本面板参考实现；本项目 `src/modules/wordbookPanel.ts` 的 ItemPane 面板机制、卡片渲染与字体缩放思路移植自该仓库
- **版权声明与许可文本**:

```
MIT License

Copyright (c) 2026 chen7447

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 7. zotero-ai-sidebar (Zotero Sentence Translator)

- **仓库**: https://github.com/xuhan-rgb/zotero-ai-sidebar
- **作者**: qwer
- **许可证**: [AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html)
- **用途**: PDF 句子/段落定位参考实现；本项目 `src/locate/` 的以下代码**直接移植**自其 `src/context/pdf-locator.ts` 与 `src/translate/sentence-splitter.ts`：
  - `src/locate/sentence-splitter.ts` — 句子切分（缩写 / 属名缩写 / acronym 例外，支持用户自定义例外词）
  - `src/locate/page-bundle.ts` — `normalizeWithMap` 文本归一化与偏移回映（含连字符断词 `hyphenBreakEndAt`、连字扩展 `LIGATURES`、零宽字符剥离）；rect 按行分组合并（`mergeRectParts` / `shouldMergeInline`）、最近 anchor 查找（`closestAnchorIndex` / `rectsDist` / `fullAnchorRect`）
  - `src/locate/sentence-locator.ts` — 段落检测（`paragraphAnchorRanges` / `lineEndsSentence` / 缩进断段）与段内句子锚点分割（`segmenterTextForAnchors` / `anchorIndexByTextRange` / `closestSentenceSegment`）
- **版权声明**: Copyright (c) qwer (https://github.com/xuhan-rgb)

---

## API 服务致谢

- **墨墨开放 API**: https://open.maimemo.com/ — 墨墨背单词云词本接口
- **欧路 OpenAPI**: https://my.eudic.net/OpenAPI/Authorization — 欧路词典 OpenAPI 授权获取

以上为在线 API 服务，使用遵循其各自的服务条款，无需附带许可证文件。
