import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { EudicClient, EudicCategory } from "./modules/eudic";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
    };
    // Hover translate runtime state
    hover: {
      // active popup element per reader inner window
      activePopups: Map<Window, HTMLElement>;
      // active highlight cleanup per reader inner window
      activeHighlights: Map<Window, () => void>;
      // hover timer id
      hoverTimer: number | null;
      // last word we translated (to avoid duplicate calls)
      lastWord: string;
      // flag: is a selection-popup currently shown? (pause hover)
      selectionPopupActive: boolean;
    };
    // Eudic
    eudic: {
      client: EudicClient | null;
      categories: EudicCategory[];
    };
  };
  public hooks: typeof hooks;
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      ztoolkit: createZToolkit(),
      locale: undefined,
      hover: {
        activePopups: new Map(),
        activeHighlights: new Map(),
        hoverTimer: null,
        lastWord: "",
        selectionPopupActive: false,
      },
      eudic: {
        client: null,
        categories: [],
      },
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
