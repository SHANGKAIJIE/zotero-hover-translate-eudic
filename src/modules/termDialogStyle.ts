/**
 * termDialogStyle.ts —— 术语添加/编辑对话框共享样式（2026-08-23）。
 *
 * 布局参考用户提供的豆包风格设计稿（620px 大圆角卡片、focus 蓝色光环、
 * 按钮 hover 态），颜色走 Zotero 主题 CSS 变量适配亮暗：
 *  - 对话框背景用 --color-background（方案 A：亮色纯白 #fff /
 *    暗色 #1e1e1e），不再用 --color-sidepane（亮色实际为 #f2f2f2 灰）；
 *  - 文字用 --fill-primary / --fill-secondary，边框用 --color-border；
 *  - 保存按钮品牌蓝 #2774d9（hover #1f64bd）与 focus 光环为固定值，
 *    亮暗主题下均可读。
 *
 * hover/focus 伪类无法用内联 cssText 表达 → 以 <style> 注入顶层 document
 * （幂等：先移除同 id 旧节点再注入），类名 hte-term-* 前缀隔离。
 */

export const TERM_DIALOG_STYLE_ID = "hte-term-dialog-style";

export const TERM_DIALOG_CSS = `
.hte-term-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483647;display:flex;align-items:center;justify-content:center;}
.hte-term-dlg{box-sizing:border-box;width:400px;max-width:90vw;background:var(--color-background,#fff);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:18px;color:var(--fill-primary,#1a1a1a);font-size:13px;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
.hte-term-title{font-size:15px;font-weight:600;color:var(--fill-primary,#1a1a1a);margin-bottom:14px;}
.hte-term-item{margin-bottom:12px;}
/* 标签用 fill-primary 而非 fill-secondary：后者在 Zotero 10 亮色下实际为
   rgba(0,0,0,.55)，12px 小字发灰难读；primary 为 rgba(0,0,0,.85)/暗色近白 */
.hte-term-label{display:block;font-size:12px;color:var(--fill-primary,#333);margin-bottom:4px;font-weight:500;}
.hte-term-input{width:100%;box-sizing:border-box;border:1px solid var(--color-border,#e0e0e0);border-radius:6px;padding:6px 9px;font-size:13px;color:var(--fill-primary,#222);background:var(--color-background,#fff);transition:border-color .2s ease,box-shadow .2s ease;font-family:inherit;}
.hte-term-input:hover{border-color:#bdbdbd;}
.hte-term-input:focus{outline:none;border-color:#2774d9;box-shadow:0 0 0 3px rgba(39,116,217,.14);}
textarea.hte-term-input{min-height:76px;resize:vertical;}
.hte-term-btnrow{margin-top:16px;display:flex;gap:8px;justify-content:flex-end;}
.hte-term-btn{padding:6px 16px;border-radius:6px;font-size:13px;cursor:pointer;transition:background .2s ease,border-color .2s ease;}
.hte-term-cancel{border:1px solid var(--color-border,#d4d4d4);background:transparent;color:var(--fill-primary,#333);}
.hte-term-cancel:hover{background:rgba(127,127,127,.12);}
.hte-term-save{border:none;background:#2774d9;color:#fff;}
.hte-term-save:hover{background:#1f64bd;}
.hte-term-save[disabled]{opacity:.6;cursor:default;}
.hte-term-danger{border:none;background:#d9534f;color:#fff;}
.hte-term-danger:hover{background:#c9433f;}
`;

/**
 * 向目标 document 注入术语对话框样式（幂等）。必须在弹窗挂载的
 * 同一个 document 上调用（添加弹窗有顶层窗口三级回退，编辑弹窗挂
 * 主窗口），否则类名无样式。
 */
export function injectTermDialogStyle(mdoc: Document): void {
  try {
    mdoc.getElementById(TERM_DIALOG_STYLE_ID)?.remove?.();
  } catch { /* ignore */ }
  try {
    const d = mdoc as any;
    const st: HTMLStyleElement = d.createElementNS
      ? d.createElementNS("http://www.w3.org/1999/xhtml", "style")
      : mdoc.createElement("style");
    st.id = TERM_DIALOG_STYLE_ID;
    st.textContent = TERM_DIALOG_CSS;
    ((mdoc.head || mdoc.documentElement) as any)?.append(st);
  } catch { /* ignore */ }
}
