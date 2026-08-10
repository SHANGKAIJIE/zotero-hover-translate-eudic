/**
 * hideNoteIcon.ts
 *
 * 隐藏 PDF 阅读器中便签图标（CommentIcon / NoteIcon）。
 *
 * 渲染机制（Zotero 9 / Firefox ESR 140，实际运行源码 resource/reader/reader.js）：
 *  - canvas 路径：Renderer._renderCommon() 中
 *      _drawNote(annotation)          —— 独立 Note 的便签图标
 *      _drawCommentIcons(annotations) —— 高亮/下划线/图片中带 comment 的便签图标
 *    （注意：旧版本 _pushCommentIcons/_pushNote 已不存在，patch 它们无效）
 *  - DOM React 路径：AnnotationLayer.setAnnotations() → _renderAnnotations()
 *      → HighlightOrUnderline 组件中 if (annotation.comment) 决定 commentIconPosition
 *      → 渲染 CommentIcon（#annotation-overlay shadow DOM）
 *
 * 隐藏策略（双路径同时 patch）：
 *  1. DOM React 路径：包装 AnnotationLayer.prototype.setAnnotations，
 *     对需要隐藏的 annotation 以副本将 comment 置空（不影响 _annotationsByID 弹窗数据），
 *     使 HighlightOrUnderline 不渲染 CommentIcon；恢复时用原始数据重新 setAnnotations。
 *  2. canvas 路径：包装 Renderer.prototype._drawNote / _drawCommentIcons，
 *     直接过滤需要隐藏的 annotation；恢复原型后 _invalidateSignature() + render() 重绘。
 *
 * 支持模式（pref hideNoteIconMode）：
 *  - word：仅按本插件创建的注释 ID（annotationTrackedIDs 跟踪列表）精确识别隐藏，
 *    不使用标签/文本等启发式判定（避免标签相同导致误判），也不依赖标注颜色
 *  - all：隐藏所有高亮/下划线/图片注释
 * 独立便签图标（type=note）不受 hideNoteIconMode 限制，仅由 hideNoteIconNotes
 * （隐藏/不隐藏）独立控制；总开关 hideNoteIcon 关闭时全部不隐藏。
 *
 * 注释 ID 跟踪（annotationTrackedIDs pref，JSON: {"附件itemID": ["KEY", ...]}）：
 *  - 创建：annotationSync 保存注释成功后调用 recordAnnotationID() 记录
 *  - 判定：word 模式按 annotation.id 是否在跟踪列表中精确识别
 *  - 清理：① 监听 Zotero Notifier item 删除/回收站事件，按 key 即时移除
 *          ② 打开 PDF 注入时返回当前注释 ID 集合，主进程对照该附件清理残留（自愈）
 */
import { getPref, setPref, registerPrefObserver } from "../utils/prefs";
import { getAllReaders, getReaderInnerWindow } from "../utils/window";

const PREF_KEYS = [
  "hideNoteIcon",
  "hideNoteIconMode",
  "hideNoteIconNotes",
  "annotationTrackedIDs",
] as const;

/** 注释跟踪列表 pref 键。 */
const TRACKED_PREF = "annotationTrackedIDs";

/** iframe window 上的 patch 状态 key（V2：新双路径方案，与旧 V1 隔离）。 */
const STATE_KEY = "__hteNoteIconPatchV2";

/** 已 attach 的 reader 集合（防重复 patch）。 */
const attachedReaders = new Set<any>();

/** 轮询定时器。 */
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 已注册的 pref observer symbols。 */
const prefObservers: symbol[] = [];

/** item 删除/回收站观察器 ID（清理跟踪列表）。 */
let itemNotifierID: string | null = null;

/**
 * 从 notifier delete/trash 事件的 extraData 中尽力提取注释 key 列表。
 * Zotero 广播格式有差异（extraData.keys 或按 id 分组的 data），做防御性提取。
 */
function extractKeysFromExtraData(
  ids: Array<string | number>,
  extraData: any,
): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v) out.push(v);
  };
  if (extraData) {
    // 顶层 keys 数组
    if (Array.isArray(extraData.keys)) extraData.keys.forEach(push);
    // 按 id 分组的 data（Zotero.Notifier 对多 id 事件的合并格式）
    if (typeof extraData === "object") {
      for (const id of ids) {
        const d = extraData[String(id)] ?? extraData[id];
        if (d && typeof d === "object" && Array.isArray(d.keys)) {
          d.keys.forEach(push);
        }
      }
    }
  }
  // 去重
  return [...new Set(out)];
}

/** 注册 item 删除观察器：注释删除时即时清理跟踪列表。 */
function registerItemNotifier(): void {
  if (itemNotifierID) return;
  try {
    const observer = {
      notify: async (
        event: string,
        type: string,
        ids: Array<string | number>,
        extraData: { [key: string]: any },
      ) => {
        if (type !== "item") return;
        if (event !== "delete" && event !== "trash") return;
        const keys = extractKeysFromExtraData(ids || [], extraData);
        if (keys.length) {
          noteLog(`item ${event}: removing tracked ids=${keys.join(",")}`);
          removeTrackedIDs(keys);
        }
      },
    };
    itemNotifierID = Zotero.Notifier.registerObserver(observer, ["item"]);
  } catch (e) {
    noteLog("registerItemNotifier error: " + dumpErr(e));
    itemNotifierID = null;
  }
}

function unregisterItemNotifier(): void {
  if (itemNotifierID) {
    try {
      Zotero.Notifier.unregisterObserver(itemNotifierID);
    } catch {
      /* ignore */
    }
    itemNotifierID = null;
  }
}

function noteLog(msg: string) {
  try {
    (Zotero as any)?.debug?.(`[hte-noteicon] ${msg}`);
    console?.log?.(`[hte-noteicon] ${msg}`);
  } catch {
    /* ignore */
  }
}

function dumpErr(e: unknown): string {
  try {
    if (e && typeof e === "object" && "stack" in e) {
      return String((e as any).stack || e);
    }
    return String(e);
  } catch {
    return "[unstringifiable error]";
  }
}

interface PatchParams {
  mode: "off" | "word" | "all";
  hideNotes: boolean;
  /** 本插件创建的注释 ID 列表（word 模式唯一判定依据）。 */
  trackedIDs: string[];
}

/** 读取跟踪列表（JSON: {"附件itemID": ["KEY", ...]}）。防御性解析。 */
function readTrackedMap(): Record<string, string[]> {
  try {
    const raw = String(getPref(TRACKED_PREF) || "{}");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, string[]>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

/** 写回跟踪列表。 */
function writeTrackedMap(map: Record<string, string[]>): void {
  try {
    setPref(TRACKED_PREF, JSON.stringify(map));
  } catch (e) {
    noteLog("writeTrackedMap error: " + dumpErr(e));
  }
}

/**
 * 记录一个由本插件创建的注释 ID（供 word 模式精确识别）。
 * @param attachmentID PDF 附件 itemID
 * @param key 注释 8 位 key（= annotation.id / item.key）
 */
export function recordAnnotationID(attachmentID: number, key: string): void {
  if (!key) return;
  try {
    const map = readTrackedMap();
    const aid = String(attachmentID);
    const list = Array.isArray(map[aid]) ? map[aid] : [];
    if (!list.includes(key)) {
      list.push(key);
      map[aid] = list;
      writeTrackedMap(map);
      noteLog(`tracked annotation: attachment=${aid} key=${key}`);
    }
  } catch (e) {
    noteLog("recordAnnotationID error: " + dumpErr(e));
  }
}

/**
 * 补录候选注释 ID 到跟踪列表（自动识别旧插件注释）。
 * 打开 PDF 时,把「单词型 highlight/underline」注释(本插件创建特征)
 * 补录到 annotationTrackedIDs——解决升级前创建的旧注释未被记录、
 * word 模式下便签无法隐藏的问题。返回是否有新增(供调用方重注入)。
 */
function backfillTrackedIDs(
  attachmentID: number | string | undefined,
  candidateKeys: string[],
): boolean {
  if (!attachmentID || !Array.isArray(candidateKeys) || !candidateKeys.length) {
    return false;
  }
  try {
    const map = readTrackedMap();
    const aid = String(attachmentID);
    const list = Array.isArray(map[aid]) ? map[aid] : [];
    let changed = false;
    for (const k of candidateKeys) {
      if (typeof k === "string" && k && !list.includes(k)) {
        list.push(k);
        changed = true;
      }
    }
    if (changed) {
      map[aid] = list;
      writeTrackedMap(map);
      noteLog(
        `backfilled plugin annotations: +${candidateKeys.length} candidates for attachment=${aid}`,
      );
    }
    return changed;
  } catch (e) {
    noteLog("backfillTrackedIDs error: " + dumpErr(e));
    return false;
  }
}

/** 扁平化全部跟踪 ID（供注入判定使用）。 */
function getAllTrackedIDs(): string[] {  const map = readTrackedMap();
  const set = new Set<string>();
  for (const list of Object.values(map)) {
    if (Array.isArray(list)) {
      for (const k of list) {
        if (typeof k === "string" && k) set.add(k);
      }
    }
  }
  return [...set];
}

/** 按 key 移除跟踪记录（key 全局唯一，跨附件匹配）。 */
function removeTrackedIDs(keys: string[]): void {
  if (!keys || !keys.length) return;
  const keySet = new Set(keys.map((k) => String(k)));
  const map = readTrackedMap();
  let changed = false;
  for (const aid of Object.keys(map)) {
    const before = map[aid].length;
    map[aid] = map[aid].filter((k) => !keySet.has(k));
    if (map[aid].length !== before) changed = true;
    if (!map[aid].length) delete map[aid];
  }
  if (changed) {
    writeTrackedMap(map);
    noteLog(`removed tracked ids: ${keys.join(",")}`);
  }
}

/**
 * 对照自愈：某附件的真实注释集合为 liveKeys 时，清理该附件下已不存在的跟踪 ID。
 * 在 reader 注入返回后调用（避免列表因删除事件丢失而无限增长）。
 */
function pruneTrackedIDsForAttachment(
  attachmentID: number | string | undefined,
  liveKeys: string[],
): void {  if (!attachmentID) return;
  const aid = String(attachmentID);
  const map = readTrackedMap();
  const list = Array.isArray(map[aid]) ? map[aid] : [];
  if (!list.length) return;
  const live = new Set((liveKeys || []).map((k) => String(k)));
  const pruned = list.filter((k) => live.has(k));
  if (pruned.length !== list.length) {
    if (pruned.length) {
      map[aid] = pruned;
    } else {
      delete map[aid];
    }
    writeTrackedMap(map);
    noteLog(
      `pruned attachment=${aid}: ${list.length - pruned.length} stale id(s) removed`,
    );
  }
}

/**
 * 基于数据库真实注释集合同步跟踪列表（异步，reader attach 成功后调用）。
 *
 * 取代旧实现「用 iframe layer 即时快照 prune」——那有两个缺陷：
 *  1. 注释刚创建（layer 尚未刷新）时，iframe 快照不含新注释 key，
 *     prune 会把刚记录的 key 误删 → 术语便签"添加时隐藏、重开 PDF 后显示"；
 *  2. 候选启发式（纯英文单词正则）不识别含空格的短语术语，backfill 无法补录。
 *
 * 这里直接查询 Zotero 数据库该附件的真实注释集合：
 *  - prune：只清理数据库中已不存在的跟踪 key（绝不错删）；
 *  - backfill：按本插件标签（生词 annotationTagName / 术语 terminologyTagName）
 *    精确补录，覆盖单词与术语两类注释。
 * 有变化时用最新 trackedIDs 重新注入一次（应用隐藏）。
 * @returns 是否有变化
 */
async function syncTrackedWithDB(
  reader: any,
  attachmentID: number | string | undefined,
): Promise<boolean> {
  if (attachmentID == null) return false;
  try {
    const anns = await (Zotero as any).Annotations.getAnnotationsForItem(
      Number(attachmentID),
    );
    if (!Array.isArray(anns)) return false;

    const map = readTrackedMap();
    const aid = String(attachmentID);
    const list = Array.isArray(map[aid]) ? map[aid] : [];
    const live = new Set(anns.map((a) => String(a?.key || "")).filter(Boolean));
    let changed = false;

    // 1) prune：仅清理数据库中已不存在的 key
    const pruned = list.filter((k) => live.has(k));
    if (pruned.length !== list.length) {
      if (pruned.length) {
        map[aid] = pruned;
      } else {
        delete map[aid];
      }
      changed = true;
      noteLog(
        `db-pruned attachment=${aid}: ${list.length - pruned.length} stale id(s) removed`,
      );
    }

    // 2) backfill：按本插件标签（生词/术语）精确补录
    const wordTag = (getPref("annotationTagName") as string) || "单词";
    const termTag = (getPref("terminologyTagName") as string) || "术语";
    const added: string[] = [];
    for (const a of anns) {
      const k = String(a?.key || "");
      if (!k) continue;
      let tags: string[] = [];
      try {
        tags = ((a.getTags && a.getTags()) as Array<{ tag?: string }>)
          .map((t) => String(t?.tag || ""))
          .filter(Boolean);
      } catch {
        /* ignore */
      }
      if (!tags.includes(wordTag) && !tags.includes(termTag)) continue;
      const cur = Array.isArray(map[aid]) ? map[aid] : [];
      if (!cur.includes(k)) {
        cur.push(k);
        map[aid] = cur;
        added.push(k);
      }
    }
    if (added.length) {
      changed = true;
      noteLog(
        `db-backfilled ${added.length} tagged annotation(s) for attachment=${aid}: ${added.join(",")}`,
      );
    }

    if (changed) {
      writeTrackedMap(map);
      // 用最新 trackedIDs 重新注入，应用隐藏/恢复
      const win = getReaderInnerWindow(reader);
      if (win) {
        try {
          win.eval.call(win, buildPatchSource(getPatchParams()));
        } catch (e) {
          noteLog("db-sync re-inject error: " + dumpErr(e));
        }
      }
    }
    return changed;
  } catch (e) {
    noteLog("syncTrackedWithDB error: " + dumpErr(e));
    return false;
  }
}

/**
 * 全库扫描补录（插件启动时调用一次）：
 * 把整个库中带本插件标签（生词 annotationTagName / 术语 terminologyTagName）
 * 的注释 key 按附件分组补录进跟踪列表。
 *
 * 用途：旧版本（iframe 快照 prune 误删 / 短语术语无法补录）已存在的
 * 单词/术语注释,即使 key 已在跟踪列表中丢失,启动后也会一次性恢复,
 * 无需逐个重新打开 PDF。返回是否有新增(供调用方 reapplyAll)。
 */
async function backfillAllTaggedFromDB(): Promise<boolean> {
  try {
    const search = new Zotero.Search();
    search.addCondition("libraryID", "is", String(Zotero.Libraries.userLibraryID));
    search.addCondition("itemType", "is", "annotation");
    const ids = (await search.search()) || [];
    if (!ids.length) return false;
    const wordTag = (getPref("annotationTagName") as string) || "单词";
    const termTag = (getPref("terminologyTagName") as string) || "术语";
    const map = readTrackedMap();
    const added: string[] = [];
    for (const id of ids) {
      try {
        const ann = Zotero.Items.get(id);
        if (!ann || String(ann.itemType) !== "annotation") continue;
        let tags: string[] = [];
        try {
          tags = ((ann.getTags && ann.getTags()) as Array<{ tag?: string }>)
            .map((t) => String(t?.tag || ""))
            .filter(Boolean);
        } catch {
          /* ignore */
        }
        if (!tags.includes(wordTag) && !tags.includes(termTag)) continue;
        const aid = ann.parentID;
        const k = String(ann.key || "");
        if (aid == null || !k) continue;
        const sAid = String(aid);
        const cur = Array.isArray(map[sAid]) ? map[sAid] : [];
        if (!cur.includes(k)) {
          cur.push(k);
          map[sAid] = cur;
          added.push(k);
        }
      } catch {
        /* ignore */
      }
    }
    if (added.length) {
      writeTrackedMap(map);
      noteLog(
        `backfillAllTaggedFromDB: +${added.length} tagged annotation(s) across ${Object.keys(map).length} attachment(s)`,
      );
    }
    return added.length > 0;
  } catch (e) {
    noteLog("backfillAllTaggedFromDB error: " + dumpErr(e));
    return false;
  }
}

function getPatchParams(): PatchParams {
  const enabled = !!getPref("hideNoteIcon");
  const mode: PatchParams["mode"] = enabled
    ? getPref("hideNoteIconMode") === "all"
      ? "all"
      : "word"
    : "off";
  // hideNoteIconNotes 是 boolean pref，但旧版 menulist 自动绑定可能把值写成
  // 字符串 "true"/"false"（非空字符串恒 truthy）。必须严格按 "true" 判定，
  // 否则独立便签开关失效（!!"false" === true）。
  const notesRaw = String(getPref("hideNoteIconNotes"));
  return {
    mode,
    hideNotes: notesRaw === "true",
    trackedIDs: getAllTrackedIDs(),
  };
}

/**
 * 构建注入 reader iframe 的 patch 源码（字符串，在 iframe 全局作用域执行）。
 *
 * 双路径：
 *  - AnnotationLayer.prototype.setAnnotations（DOM React 路径，影响高亮/下划线/图片便签）
 *  - Renderer.prototype._drawNote / _drawCommentIcons（canvas 路径）
 *
 * state 缓存在 window[STATE_KEY]，重复注入时按 prototype 去重、只更新参数并重新应用。
 */
function buildPatchSource(params: PatchParams): string {
  const { mode, hideNotes, trackedIDs } = params;
  const MODE = JSON.stringify(mode);
  const HIDE_NOTES = hideNotes ? "true" : "false";
  const TRACKED_IDS = JSON.stringify(trackedIDs || []);
  return `(() => {
    const stateKey = ${JSON.stringify(STATE_KEY)};
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
    const MODE = ${MODE};
    const HIDE_NOTES = ${HIDE_NOTES};
    const TRACKED_IDS = ${TRACKED_IDS};
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
    // DOM React 路径专用判定：note 类型不走这里（其图标由 canvas _drawNote 处理，
    // comment 是 note 内容，绝不能置空）
    state.shouldHideDom = (annotation) => {
      if (!annotation || annotation.type === "note") return false;
      return state.shouldHide(annotation);
    };
    const patchLayer = (layer) => {
      if (!layer || typeof layer.setAnnotations !== "function") return;
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
              render = full.map((a) =>
                state.shouldHideDom(a) ? Object.assign({}, a, { comment: null }) : a
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

    // ===== 2. canvas 路径：包装 Renderer._drawNote / _drawCommentIcons =====
    const installRendererPatch = (renderer) => {
      const prototype = renderer && Object.getPrototypeOf(renderer);
      if (!prototype) return;
      let patch = state.rendererPatches.find((p) => p.prototype === prototype);
      if (!patch) {
        patch = {
          prototype,
          originalDrawNote: null,
          originalCommentIcons: null,
          wrapperDrawNote: null,
          wrapperCommentIcons: null,
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
        state.rendererPatches.push(patch);
      }
      patch.enabled = MODE !== "off";
      if (MODE === "off") {
        if (patch.wrapperDrawNote && prototype._drawNote === patch.wrapperDrawNote) {
          prototype._drawNote = patch.originalDrawNote;
          changed = true;
        }
        if (patch.wrapperCommentIcons && prototype._drawCommentIcons === patch.wrapperCommentIcons) {
          prototype._drawCommentIcons = patch.originalCommentIcons;
          changed = true;
        }
      } else {
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
      }
    };

    // 遍历主/次视图的所有页面
    const views = [root._reader?._primaryView, root._reader?._secondaryView].filter(Boolean);
    for (const view of views) {
      for (const page of view._pages ?? []) {
        installRendererPatch(page?._pageRenderer);
        installRendererPatch(page?._detailRenderer);
        patchLayer(page?._pageRenderer?._layer);
        patchLayer(page?._detailRenderer?._layer);
      }
    }

    // 重渲染：canvas 路径失效签名并重绘；DOM 路径强制同步渲染
    if (changed) {
      for (const view of views) {
        for (const page of view._pages ?? []) {
          state.counters.redrawPages += 1;
          page?._pageRenderer?._invalidateSignature?.();
          page?._detailRenderer?._invalidateSignature?.();
          page?.render?.();
          page?._pageRenderer?._layer?._renderAnnotations?.(true);
        }
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
          const layer = page?._pageRenderer?._layer;
          if (layer && Array.isArray(layer._annotations)) all.push(...layer._annotations);
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
        if (/^[A-Za-z\u00C0-\u024F]+(?:['’-][A-Za-z\u00C0-\u024F]+)*$/.test(txt)) {
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
      layers: state.layerPatches.length,
      renderers: state.rendererPatches.length,
      changed,
      counters,
      keys: liveKeys,
      pluginCandidates,
    };
  })()`;
}

/** 在单个 reader iframe 中应用/恢复 patch。 */
function attachToReader(reader: any): boolean {
  const win = getReaderInnerWindow(reader);
  if (!win) {
    noteLog("attach fail: no inner window");
    return false;
  }
  try {
    const params = getPatchParams();
    const ok = win.eval.call(win, buildPatchSource(params));
    if (ok && typeof ok === "object") {
      try {
        noteLog("attach ok: " + JSON.stringify(ok));
      } catch (_) {
        noteLog("attach ok: [json error]");
      }
      // 对照自愈（异步、基于数据库真实注释集合）：
      // 清理跟踪列表中已删除的 key，并按本插件标签（生词/术语）补录。
      // 不用 iframe layer 即时快照 prune —— 注释刚创建（layer 未刷新）时
      // 快照不含新 key 会误删，导致术语便签"添加时隐藏、重开 PDF 后显示"。
      const attachmentID = (reader as any)?.itemID ?? (reader as any)?._itemID ?? (reader as any)?._attachmentItemID;
      if (attachmentID != null) {
        void syncTrackedWithDB(reader, attachmentID);
      }
      // ===== 关键修复：patch 必须真正安装到 layer/renderer 原型上才算 attach 成功 =====
      // 重启 Zotero 恢复标签页 / 新开 PDF 时，reader iframe 先于 PDF 页面初始化，
      // 首次注入可能发生在 root._reader / _pages / _pageRenderer._layer 尚未创建时——
      // 注入代码遍历不到任何实例，prototype 未被替换，便签图标不会被隐藏。
      // 旧实现只要 eval 返回对象就视为 attach 成功并加入 attachedReaders，
      // scanAllReaders 轮询因此永久跳过该 reader，表现为"重启后图标仍显示，
      // 必须手动切换 pref 或新增生词（触发全量 reapplyAll）才生效"。
      // 修复：未就绪时返回 false，由轮询在 PDF 页面就绪后重试，直到 patch 安装成功。
      if (params.mode !== "off") {
        const ready =
          !!ok.readerFound &&
          (ok.pages as number) > 0 &&
          ((ok.layers as number) > 0 || (ok.renderers as number) > 0);
        if (!ready) {
          noteLog(
            `attach deferred (reader/page not ready): readerFound=${ok.readerFound} pages=${ok.pages} layers=${ok.layers} renderers=${ok.renderers}`,
          );
          return false;
        }
      }
      // 自动补录旧注释:word 模式下,把「单词型高亮/下划线」候选补录到
      // 跟踪列表;有新增则用更新后的 trackedIDs 重新注入一次(应用隐藏)。
      if (
        params.mode === "word" &&
        Array.isArray(ok.pluginCandidates) &&
        ok.pluginCandidates.length
      ) {
        if (backfillTrackedIDs(attachmentID, ok.pluginCandidates)) {
          try {
            const ok2 = win.eval.call(win, buildPatchSource(getPatchParams()));
            return !!ok2;
          } catch (e) {
            noteLog("backfill re-inject error: " + dumpErr(e));
          }
        }
      }
      return true;
    }
    noteLog("attach returned non-true: " + String(ok));
    return false;
  } catch (e) {
    noteLog("attach error: " + dumpErr(e));
    return false;
  }
}

/**
 * 对所有已发现 reader 重新应用当前 pref（pref 变化/插件启用时调用）。
 *
 * 注意：必须对每个 reader 每次都重新注入，不能因为已 attach 就跳过。
 * 注入代码本身幂等：它按最新 pref 更新 iframe 内 patch 状态并重绘/恢复。
 * 旧实现用 `attachedReaders.has(reader) ||` 短路跳过，导致 pref 变更
 * （取消勾选/切换 all/word/独立注释开关）永远无法到达 iframe，
 * 表现为"取消勾选仍隐藏、切 word 仍是 all、独立注释仍隐藏"。
 */
function reapplyAll(): number {
  let okCount = 0;
  const readers = getAllReaders();
  for (const reader of readers) {
    try {
      if (attachToReader(reader)) {
        attachedReaders.add(reader);
        okCount++;
      }
    } catch (e) {
      noteLog("reapply error: " + dumpErr(e));
    }
  }
  noteLog(`reapply done: ${okCount}/${readers.length}`);
  return okCount;
}

/** 轮询扫描新打开的 reader（弹窗/标签页切换场景）。 */
function scanAllReaders(): void {
  for (const reader of getAllReaders()) {
    if (attachedReaders.has(reader)) continue;
    if (attachToReader(reader)) {
      attachedReaders.add(reader);
    }
  }
}

// 上次观察到的 patch 参数签名（保险丝用）
let lastParamsKey = "";

/**
 * 保险丝：即使 pref observer 因任何原因（版本差异、注册失败等）未触发，
 * 轮询也能在 3 秒内发现 pref 变化并重新应用。
 * getPatchParams() 按最新 pref 计算，重复应用幂等。
 */
function pollPrefParams(): void {
  const key = JSON.stringify(getPatchParams());
  if (key !== lastParamsKey) {
    lastParamsKey = key;
    noteLog("pref params changed via poll: " + key);
    try {
      reapplyAll();
    } catch (e) {
      noteLog("reapply error: " + dumpErr(e));
    }
  }
}

/** 初始化：注册 pref observer + 启动轮询 + 立即应用。 */
export function initHideNoteIcon(): void {
  if (pollTimer) return;
  // 规范化历史遗留数据：旧版 menulist 自动绑定可能把 hideNoteIconNotes 写成
  // 字符串 "true"/"false"，重新写回 boolean，避免 truthy 误判。
  try {
    const notesRaw = getPref("hideNoteIconNotes");
    if (typeof notesRaw !== "boolean") {
      setPref("hideNoteIconNotes", String(notesRaw) === "true");
      noteLog("normalized hideNoteIconNotes: " + String(notesRaw));
    }
  } catch (e) {
    noteLog("normalize error: " + dumpErr(e));
  }
  lastParamsKey = JSON.stringify(getPatchParams());
  pollTimer = setInterval(() => {
    try {
      scanAllReaders();
      pollPrefParams();
    } catch (e) {
      noteLog("poll error: " + dumpErr(e));
    }
  }, 3000);

  for (const key of PREF_KEYS) {
    const sym = registerPrefObserver(key, () => {
      lastParamsKey = JSON.stringify(getPatchParams());
      noteLog("pref changed: " + key + " -> " + lastParamsKey);
      try {
        reapplyAll();
      } catch (e) {
        noteLog("reapply error: " + dumpErr(e));
      }
    });
    if (sym) prefObservers.push(sym);
  }

  // 监听注释删除/回收站事件，即时清理跟踪列表
  registerItemNotifier();

  // 存量恢复：启动时全库扫描，把带本插件标签（生词/术语）的注释 key
  // 一次性补录进跟踪列表 —— 旧版本被误删/漏录的单词、术语注释无需逐个
  // 重新打开 PDF，重启插件后即恢复隐藏。
  void backfillAllTaggedFromDB().then((changed) => {
    if (changed) {
      try {
        reapplyAll();
      } catch (e) {
        noteLog("backfill reapply error: " + dumpErr(e));
      }
    }
  });

  reapplyAll();
  noteLog("init done");
}

/** 清理：移除 observer、停止轮询、恢复所有 reader。 */
export function cleanupHideNoteIcon(): void {
  for (const sym of prefObservers) {
    try {
      (Zotero.Prefs as any)?.unregisterObserver?.(sym);
    } catch {
      /* ignore */
    }
  }
  prefObservers.length = 0;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  unregisterItemNotifier();

  // 恢复：以 off 模式重放 patch，卸载 wrapper
  for (const reader of attachedReaders) {
    const win = getReaderInnerWindow(reader);
    if (!win) continue;
    try {
      win.eval.call(win, buildPatchSource({ mode: "off", hideNotes: false, trackedIDs: [] }));
      noteLog("cleanup restore ok");
    } catch (e) {
      noteLog("cleanup restore error: " + dumpErr(e));
    }
  }
  attachedReaders.clear();
}
