(() => {
(() => {
    const stateKey = null;
    const root = window;
    let state = root[stateKey];
    if (!state) {
      state = root[stateKey] = {
        layerPatches: [],
        rendererPatches: [],
        counters: {
          setAnnotations: 0,
          setAnnotationsHidden: 0,
          drawNote: 0,
          drawNoteHidden: 0,
          commentIcons: 0,
          commentIconsTotal: 0,
          commentIconsFiltered: 0,
          redrawPages: 0,
        },
      };
    }
    const MODE = null;
    const HIDE_NOTES = null;
    const TRACKED_IDS = null;
    // 参数签名：仅参数变化（all↔word、独立注释开关、跟踪 ID）时也要强制重绘，
    // 因为此时原型没有替换，changed 不会置 true，canvas 保持旧画面。
    const paramsKey = [MODE, HIDE_NOTES, TRACKED_IDS.join("|")].join("|");
    let changed = state.lastParamsKey !== paramsKey;
    state.lastParamsKey = paramsKey;

    // V3 修复：最新参数与判定函数挂到 state。
    // 之前 MODE/HIDE_NOTES 被 wrapper 闭包捕获，缓存到 state.layerPatches/
    // state.rendererPatches 后，后续注入即使更新了 patch.enabled（主开关 off/on
    // 因此生效），wrapper 内部的 shouldHide 仍是旧闭包（旧 MODE），导致
    // word↔all 切换、hideNoteIconNotes 开关都无效。现在 wrapper 每次
    // 从 state 读取最新参数与函数，任何参数变化立即生效。
    state.params = { MODE, HIDE_NOTES, TRACKED_IDS };
    // 判定某个注释的图标是否应被隐藏（每次从 state.params 读最新参数）
    state.shouldHide = (annotation) => {
      const p = state.params;
      if (!annotation || p.MODE === "off") return false;
      const type = annotation.type;
      // 独立便签图标：仅由独立开关控制（不受 mode 限制）
      if (type === "note") return p.HIDE_NOTES;
      if (type !== "highlight" && type !== "underline" && type !== "image") return false;
      if (p.MODE === "all") return true;
      // word 模式：仅按注释 ID 精确识别本插件创建的注释（无启发式判定，
      // 避免标签相同/文本相似导致误判；不依赖标注颜色）
      return !!(annotation.id && p.TRACKED_IDS.includes(annotation.id));
    };
    // DOM React 路径专用判定：
    //  - note(独立便签)：仅由 hideNoteIconNotes 控制(与 canvas 路径一致),
    //    由 setAnnotations wrapper 从渲染列表【过滤移除】(置空 comment 无法
    //    移除 note —— StaggeredNotes 直接从注释列表渲染 Note/CommentIcon)
    //  - 其余(高亮/下划线/图片)：置空 comment → CommentIcon 不渲染
    state.shouldHideDom = (annotation) => {
      if (!annotation) return false;
      if (annotation.type === "note") return p.HIDE_NOTES;
      return state.shouldHide(annotation);
    };
    const patchLayer = (layer) => {
      if (!layer || typeof layer.setAnnotations !== "function") return;
      // Zotero 10 守卫：PDFView 集成了原 AnnotationLayer 的职责（有 setAnnotations/
      // _annotations），但没有 DOM React 渲染层特征 _renderAnnotations。PDF 的便签
      // 图标完全走 canvas/display-list 路径（Page._pushNote/_pushCommentIcons），已由
      // installRendererPatch 处理；若在这里 patch PDFView.setAnnotations 置空 comment，
      // 会污染 PDFView._annotations 数据（注释列表/弹窗失去 comment）。因此只 patch
      // 真正的 DOM React 渲染层（Zotero 9 AnnotationLayer / Zotero 10 DOMView/EPUBView）。
      if (typeof layer._renderAnnotations !== "function") return;
      const proto = Object.getPrototypeOf(layer);
      if (!proto) return;
      let rec = state.layerPatches.find((p) => p.proto === proto);
      if (!rec) {
        const orig = proto.setAnnotations;
        rec = {
          proto,
          orig,
          enabled: false,
          wrapper: function (annotations) {
            const full = Array.isArray(annotations) ? annotations : [];
            this.__hteFullAnnotations = full;
            let render = full;
            if (rec.enabled) {
              state.counters.setAnnotations += 1;
              const hidden = full.filter((a) => state.shouldHideDom(a));
              state.counters.setAnnotationsHidden += hidden.length;
              // 独立便签(type=note)：从渲染列表【过滤移除】(StaggeredNotes 从
              // 列表渲染,置空 comment 无效);其余(高亮/下划线/图片):置空
              // comment → CommentIcon 不渲染。弹窗/数据源由下方
              // _annotationsByID 还原为完整列表,不受影响。
              render = full
                .filter((a) => !(a.type === "note" && state.shouldHideDom(a)))
                .map((a) =>
                  state.shouldHideDom(a)
                    ? Object.assign({}, a, { comment: null })
                    : a,
                );
            }
            const result = orig.call(this, render);
            // 弹窗/数据源保持原始 comment
            if (full.length && this._annotationsByID) {
              this._annotationsByID = new Map(full.map((a) => [a.id, a]));
            }
            return result;
          },
        };
        proto.setAnnotations = rec.wrapper;
        state.layerPatches.push(rec);
      }
      rec.enabled = MODE !== "off";
      if (MODE === "off") {
        // 恢复：还原原型并用原始数据重新渲染
        if (proto.setAnnotations === rec.wrapper) {
          proto.setAnnotations = rec.orig;
          if (layer.__hteFullAnnotations) {
            rec.orig.call(layer, layer.__hteFullAnnotations);
            layer.__hteFullAnnotations = undefined;
            changed = true;
          }
        }
      } else {
        if (proto.setAnnotations !== rec.wrapper) {
          rec.orig = proto.setAnnotations;
          proto.setAnnotations = rec.wrapper;
        }
        // 立即用当前数据重渲染
        if (layer._annotations) {
          rec.wrapper.call(layer, layer.__hteFullAnnotations || layer._annotations);
          changed = true;
        }
      }
    };

    // ===== 2. canvas 路径：包装便签图标渲染 =====
    // Zotero 9:  Renderer._drawNote(annotation) / _drawCommentIcons(annotations)
    // Zotero 10: Page._pushNote(items, annotation) / _pushCommentIcons(items, annotations)
    //   （Zotero 10 重构后由 _buildDisplayList() 统一收集，方法挂在 Page 类上）
    // 双版本自动探测：原型上哪个方法存在就包装哪个，两版互不影响。
    const installRendererPatch = (renderer) => {
      const prototype = renderer && Object.getPrototypeOf(renderer);
      if (!prototype) return;
      let patch = state.rendererPatches.find((p) => p.prototype === prototype);
      if (!patch) {
        patch = {
          prototype,
          // Zotero 9
          originalDrawNote: null,
          originalCommentIcons: null,
          wrapperDrawNote: null,
          wrapperCommentIcons: null,
          // Zotero 10
          originalPushNote: null,
          originalPushCommentIcons: null,
          wrapperPushNote: null,
          wrapperPushCommentIcons: null,
          enabled: false,
        };
        if (typeof prototype._drawNote === "function") {
          patch.originalDrawNote = prototype._drawNote;
          patch.wrapperDrawNote = function (annotation) {
            if (patch.enabled) {
              state.counters.drawNote += 1;
              if (state.shouldHide(annotation)) {
                state.counters.drawNoteHidden += 1;
                return;
              }
            }
            return patch.originalDrawNote.call(this, annotation);
          };
        }
        if (typeof prototype._drawCommentIcons === "function") {
          patch.originalCommentIcons = prototype._drawCommentIcons;
          patch.wrapperCommentIcons = function (annotations) {
            if (patch.enabled && Array.isArray(annotations)) {
              state.counters.commentIcons += 1;
              state.counters.commentIconsTotal += annotations.length;
              const hidden = annotations.filter((a) => state.shouldHide(a));
              state.counters.commentIconsFiltered += hidden.length;
              annotations = annotations.filter((a) => !state.shouldHide(a));
            }
            return patch.originalCommentIcons.call(this, annotations);
          };
        }
        // Zotero 10: Page._pushNote(items, annotation) —— 需要隐藏时直接跳过 push
        if (typeof prototype._pushNote === "function") {
          patch.originalPushNote = prototype._pushNote;
          patch.wrapperPushNote = function (items, annotation) {
            if (patch.enabled) {
              state.counters.drawNote += 1;
              if (state.shouldHide(annotation)) {
                state.counters.drawNoteHidden += 1;
                return;
              }
            }
            return patch.originalPushNote.call(this, items, annotation);
          };
        }
        // Zotero 10: Page._pushCommentIcons(items, annotations) —— 过滤后 push
        if (typeof prototype._pushCommentIcons === "function") {
          patch.originalPushCommentIcons = prototype._pushCommentIcons;
          patch.wrapperPushCommentIcons = function (items, annotations) {
            if (patch.enabled && Array.isArray(annotations)) {
              state.counters.commentIcons += 1;
              state.counters.commentIconsTotal += annotations.length;
              const hidden = annotations.filter((a) => state.shouldHide(a));
              state.counters.commentIconsFiltered += hidden.length;
              annotations = annotations.filter((a) => !state.shouldHide(a));
            }
            return patch.originalPushCommentIcons.call(this, items, annotations);
          };
        }
        state.rendererPatches.push(patch);
      }
      patch.enabled = MODE !== "off";
      if (MODE === "off") {
        // Zotero 9 恢复
        if (patch.wrapperDrawNote && prototype._drawNote === patch.wrapperDrawNote) {
          prototype._drawNote = patch.originalDrawNote;
          changed = true;
        }
        if (patch.wrapperCommentIcons && prototype._drawCommentIcons === patch.wrapperCommentIcons) {
          prototype._drawCommentIcons = patch.originalCommentIcons;
          changed = true;
        }
        // Zotero 10 恢复
        if (patch.wrapperPushNote && prototype._pushNote === patch.wrapperPushNote) {
          prototype._pushNote = patch.originalPushNote;
          changed = true;
        }
        if (patch.wrapperPushCommentIcons && prototype._pushCommentIcons === patch.wrapperPushCommentIcons) {
          prototype._pushCommentIcons = patch.originalPushCommentIcons;
          changed = true;
        }
      } else {
        // Zotero 9 安装
        if (patch.wrapperDrawNote && prototype._drawNote !== patch.wrapperDrawNote) {
          patch.originalDrawNote = prototype._drawNote;
          prototype._drawNote = patch.wrapperDrawNote;
          changed = true;
        }
        if (patch.wrapperCommentIcons && prototype._drawCommentIcons !== patch.wrapperCommentIcons) {
          patch.originalCommentIcons = prototype._drawCommentIcons;
          prototype._drawCommentIcons = patch.wrapperCommentIcons;
          changed = true;
        }
        // Zotero 10 安装
        if (patch.wrapperPushNote && prototype._pushNote !== patch.wrapperPushNote) {
          patch.originalPushNote = prototype._pushNote;
          prototype._pushNote = patch.wrapperPushNote;
          changed = true;
        }
        if (patch.wrapperPushCommentIcons && prototype._pushCommentIcons !== patch.wrapperPushCommentIcons) {
          patch.originalPushCommentIcons = prototype._pushCommentIcons;
          prototype._pushCommentIcons = patch.wrapperPushCommentIcons;
          changed = true;
        }
      }
    };

    // 遍历主/次视图的所有页面
    const views = [root._reader?._primaryView, root._reader?._secondaryView].filter(Boolean);
    for (const view of views) {
      for (const page of view._pages ?? []) {
        // Zotero 9: page 对象上挂 _pageRenderer / _detailRenderer（Renderer 实例）
        installRendererPatch(page?._pageRenderer);
        installRendererPatch(page?._detailRenderer);
        // Zotero 10: page 自身就是渲染单元（Page 类，带 _pushNote/_pushCommentIcons/_layer）
        installRendererPatch(page);
        patchLayer(page?._pageRenderer?._layer);
        patchLayer(page?._detailRenderer?._layer);
        // Zotero 10: page._layer = PDFView（集成原 AnnotationLayer 职责）
        patchLayer(page?._layer);
      }
    }
    // Zotero 10 阅读模式(SDT)视图:DOM React 渲染层(DOMView 子类,带
    // _renderAnnotations),便签/注释图标渲染进 #annotation-render-root 的
    // AnnotationOverlay 组件。patchLayer 包装 DOMView.prototype.setAnnotations:
    // 置空 comment 隐藏高亮/下划线便签 + 过滤 note 隐藏独立便签。
    const sdtViews = [
      root._reader?._primarySDTView,
      root._reader?._secondarySDTView,
    ].filter(Boolean);
    for (const sdtView of sdtViews) {
      patchLayer(sdtView);
    }

    // 重渲染：canvas 路径失效签名并重绘；DOM 路径强制同步渲染
    if (changed) {
      for (const view of views) {
        for (const page of view._pages ?? []) {
          state.counters.redrawPages += 1;
          // Zotero 9: _invalidateSignature 失效签名（可选调用，10 中不存在则跳过）
          page?._pageRenderer?._invalidateSignature?.();
          page?._detailRenderer?._invalidateSignature?.();
          // 两版本都有 page.render()；Zotero 10 的 Page.render() 自带 signature 比较
          page?.render?.();
          // Zotero 10: PDFView._render() 触发整页重绘（Page.render 未覆盖的 overlay 部分）
          page?._layer?._render?.();
          page?._pageRenderer?._layer?._renderAnnotations?.(true);
          page?._detailRenderer?._layer?._renderAnnotations?.(true);
        }
      }
      // SDT 阅读模式视图:用当前注释数据强制走一遍 setAnnotations wrapper
      // (其内部已按最新参数过滤 note/置空 comment 并同步重渲染)。
      for (const sdtView of sdtViews) {
        try {
          const src = sdtView.__hteFullAnnotations ?? sdtView._annotations;
          if (Array.isArray(src)) {
            sdtView.setAnnotations(src);
            changed = true;
          }
        } catch { /* ignore */ }
      }
    }
    // 诊断：返回自上次注入以来的计数增量 + 环境信息
    const prevCounters = state.lastCounters || {};
    const counters = {};
    for (const k of Object.keys(state.counters)) {
      counters[k] = (state.counters[k] || 0) - (prevCounters[k] || 0);
    }
    state.lastCounters = Object.assign({}, state.counters);
    // 收集当前 reader 中全部注释的 ID（供主进程对照清理跟踪列表，自愈删除事件遗漏）
    let liveKeys = [];
    let pluginCandidates = [];
    try {
      const all = [];
      for (const view of views) {
        for (const page of view._pages ?? []) {
          // Zotero 9: page._pageRenderer._layer / page._detailRenderer._layer
          const l1 = page?._pageRenderer?._layer;
          if (l1 && Array.isArray(l1._annotations)) all.push(...l1._annotations);
          const l2 = page?._detailRenderer?._layer;
          if (l2 && Array.isArray(l2._annotations)) all.push(...l2._annotations);
          // Zotero 10: page._layer = PDFView（集成原 AnnotationLayer 职责）
          const l3 = page?._layer;
          if (l3 && Array.isArray(l3._annotations)) all.push(...l3._annotations);
        }
      }
      // Zotero 10 阅读模式:SDT 视图的注释列表(_annotations,含 note/高亮/下划线)
      for (const sdtView of sdtViews) {
        if (sdtView && Array.isArray(sdtView._annotations)) {
          all.push(...sdtView._annotations);
        }
      }
      liveKeys = [...new Set(all.map((a) => a && a.id).filter(Boolean))];
      // 自动补录候选:本插件创建特征的注释(单词型 highlight/underline)——
      // 供主进程补录到 annotationTrackedIDs,解决升级前创建的旧注释
      // 未被记录、word 模式下便签无法隐藏的问题。
      const cands = [];
      for (const a of all) {
        if (!a || !a.id) continue;
        const t = String(a.type || "");
        if (t !== "highlight" && t !== "underline") continue;
        const txt = String(a.text || "").trim();
        // 连字(ﬁ→fi)纳入单词识别:注释文本含连字时仍视为单词型注释,
        // 否则便签图标无法隐藏(与 util.ts WORD_RUN 同源)。
        if (/^[A-Za-z\u00C0-\u024F\uFB00-\uFB06]+(?:['’-][A-Za-z\u00C0-\u024F\uFB00-\uFB06]+)*$/.test(txt)) {
          cands.push(a.id);
        }
      }
      pluginCandidates = [...new Set(cands)];
    } catch {
      /* ignore */
    }
    return {
      mode: MODE,
      hideNotes: HIDE_NOTES,
      href: String(window.location.href).slice(0, 200),
      readerFound: !!root._reader,
      views: views.length,
      pages: views.reduce((n, v) => n + (v._pages ? v._pages.length : 0), 0),
      sdtViews: sdtViews.length,
      layers: state.layerPatches.length,
      renderers: state.rendererPatches.length,
      changed,
      counters,
      keys: liveKeys,
      pluginCandidates,
    };
  })()
})();