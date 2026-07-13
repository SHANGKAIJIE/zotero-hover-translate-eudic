declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

declare class MozXULElement {
  static parseXULToFragment(xul: string): DocumentFragment;
  static insertFTLIfNeeded(ftl: string): void;
}

/**
 * Minimal type for the Translate for Zotero plugin API surface that we reuse.
 * The full plugin exposes `Zotero.PDFTranslate` with `.api`, `.data`, `.hooks`.
 * We only depend on `api.translate`, `api.getServices`, `api.getVersion`.
 */
declare namespace Zotero {
  namespace PDFTranslate {
    interface TranslateTask {
      id: string;
      type: string;
      raw: string;
      result: string;
      audio: Array<{ text: string; url: string }>;
      service: string;
      status: "waiting" | "success" | "fail" | "running";
      langfrom?: string;
      langto?: string;
    }

    interface Api {
      translate(
        raw: string,
        options: {
          pluginID: string;
          service?: string | string[];
          itemID?: number;
          langfrom?: string;
          langto?: string;
        },
      ): Promise<TranslateTask>;
      getServices(): Array<{ id: string; [k: string]: any }>;
      getVersion(): string;
    }

    interface Data {
      translate?: {
        services?: { getAllServices?: () => any[] };
      };
    }
  }

  var PDFTranslate:
    | {
        api: Zotero.PDFTranslate.Api;
        data: Zotero.PDFTranslate.Data;
        hooks: any;
      }
    | undefined;

  var HoverTranslateEudic: import("../src/addon").default | undefined;
}
