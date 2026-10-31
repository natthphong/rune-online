// UI translations (2.5.0). `t("party.invite", { name })` reads flat dotted keys from locales/<lang>.json, `{name}` placeholders and
// simple plurals (`key_one` / `key_other`, chosen by `count`, Intl.PluralRules). A key missing in the active language falls back to en,
// a key missing in en shows the key itself. Static markup in index.html uses data-i18n / data-i18n-title / data-i18n-placeholder
// (applyI18n). Data names (items, monsters, skills, maps, NPC text) are NOT in these files: see tData() and docs/I18N.md.
import en from "./locales/en.json";
import th from "./locales/th.json";

export type Lang = "en" | "th";
export const LANGS: { id: Lang; label: string }[] = [{ id: "en", label: "English" }, { id: "th", label: "ไทย" }];
const TABLES: Record<Lang, Record<string, string>> = { en, th };
const LANG_KEY = "rl.lang";

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "en" || saved === "th") return saved;
  } catch { /* private mode */ }
  return (typeof navigator !== "undefined" && navigator.language || "en").toLowerCase().startsWith("th") ? "th" : "en";
}
let lang: Lang = initialLang();
if (typeof document !== "undefined") document.documentElement.lang = lang; // :lang(th) CSS also applies on the first load
const listeners = new Set<(l: Lang) => void>();

export const getLang = () => lang;
export function setLang(next: Lang) {
  if (next === lang || !TABLES[next]) return;
  lang = next;
  try { localStorage.setItem(LANG_KEY, next); } catch { /* private mode */ }
  document.documentElement.lang = next;
  applyI18n();
  for (const f of listeners) f(next);
}
/** Run `f` after every language switch (windows built in TS re-render their text here). */
export const onLangChange = (f: (l: Lang) => void) => { listeners.add(f); };

type Vars = Record<string, string | number>;
function fill(s: string, vars?: Vars) {
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}
/** Translate `key`; `vars.count` (a number) picks `key_one` / `key_other` (falls back to `key`). */
export function t(key: string, vars?: Vars): string {
  let k = key;
  if (vars && typeof vars.count === "number") {
    const cat = new Intl.PluralRules(lang).select(vars.count), pk = `${key}_${cat}`;
    if (pk in TABLES[lang] || pk in en) k = pk;
  }
  return fill(TABLES[lang][k] ?? (en as Record<string, string>)[k] ?? key, vars);
}

/** Static markup: data-i18n (text), data-i18n-title, data-i18n-placeholder, data-i18n-aria (aria-label). */
export function applyI18n(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((e) => { e.textContent = t(e.dataset.i18n!); });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((e) => { e.title = t(e.dataset.i18nTitle!); });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((e) => { e.placeholder = t(e.dataset.i18nPlaceholder!); });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((e) => { e.setAttribute("aria-label", t(e.dataset.i18nAria!)); });
}

/** Fill every <select class="lang-sel"> with the languages and keep it in step with setLang (options window, login corner). */
export function bindLangSelects(root: ParentNode = document) {
  root.querySelectorAll<HTMLSelectElement>("select.lang-sel").forEach((sel) => {
    if (!sel.options.length) for (const l of LANGS) sel.add(new Option(l.label, l.id));
    sel.value = lang;
    sel.addEventListener("change", () => setLang(sel.value as Lang));
    onLangChange((l) => { sel.value = l; });
  });
}

/** Data names hook (items, monsters, skills, maps ...): an optional translation file per language and table in
 *  locales/data/<lang>/<table>.json = { "<id>": { "<field>": "text" } }. Missing -> the English value passed in `fallback`. */
const dataFiles = import.meta.glob<Record<string, Record<string, string>>>("./locales/data/*/*.json", { eager: true, import: "default" });
export function tData(table: string, id: string | number, field: string, fallback = ""): string {
  return dataFiles[`./locales/data/${lang}/${table}.json`]?.[String(id)]?.[field] ?? fallback;
}
