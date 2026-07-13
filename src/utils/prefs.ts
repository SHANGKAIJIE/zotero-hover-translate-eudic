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
 */
export function registerPrefObserver<K extends PrefKeys>(
  key: K,
  callback: (value: PluginPrefsMap[K]) => void,
): symbol {
  const prefName = `${PREFS_PREFIX}.${key}`;
  const handler = (changedPref: string, value: any) => {
    if (changedPref === prefName) {
      callback(value as PluginPrefsMap[K]);
    }
  };
  return Zotero.Prefs.registerObserver(prefName, handler, true);
}
