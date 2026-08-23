import { config } from "../../package.json";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];
type PrefKeys = keyof PluginPrefsMap;

const PREFS_PREFIX = config.prefsPrefix;

/**
 * Get preference value.
 * Wrapper of `Zotero.Prefs.get`.
 */
export function getPref<K extends PrefKeys>(key: K): PluginPrefsMap[K] {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true) as PluginPrefsMap[K];
}

/**
 * Set preference value.
 * Wrapper of `Zotero.Prefs.set`.
 */
export function setPref<K extends PrefKeys>(
  key: K,
  value: PluginPrefsMap[K],
) {
  return Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}

/**
 * Clear preference value.
 */
export function clearPref<K extends PrefKeys>(key: K) {
  return Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}

/**
 * Register a preference observer.
 * @returns symbol to pass to `Zotero.Prefs.unregisterObserver`.
 *
 * 注意：Zotero.Prefs.registerObserver 的回调只会收到一个参数——pref 的
 * 新值（见 chrome/content/zotero/xpcom/prefs.js 的 observe()：
 * `observer(this.get(data, true))`）。旧实现误以为回调会收到
 * `(changedPref, value)` 并用 `changedPref === prefName` 过滤，结果
 * changedPref 拿到的是新值，条件永不成立，回调从不执行——这就是
 * "勾选/取消勾选 pref 不生效" 的根因。这里直接透传新值。
 */
export function registerPrefObserver<K extends PrefKeys>(
  key: K,
  callback: (value: PluginPrefsMap[K]) => void,
): symbol {
  const prefName = `${PREFS_PREFIX}.${key}`;
  const handler = (newValue: any) => {
    callback(newValue as PluginPrefsMap[K]);
  };
  return Zotero.Prefs.registerObserver(prefName, handler, true);
}
