/**
 * i18n locale key-parity test.
 *
 * Compares every non-English locale file's key tree against en.json so that
 * missing or extra translation keys are caught before they reach production.
 *
 * Run via:  pnpm test:i18n
 */
import { describe, it, expect } from "vitest"
import en from "@/i18n/locales/en.json"
import es from "@/i18n/locales/es.json"
import ko from "@/i18n/locales/ko.json"
import tr from "@/i18n/locales/tr.json"
import zh from "@/i18n/locales/zh.json"

type LocaleTree = Record<string, Record<string, string>>

const locales: Record<string, LocaleTree> = {
  es: es as unknown as LocaleTree,
  ko: ko as unknown as LocaleTree,
  tr: tr as unknown as LocaleTree,
  zh: zh as unknown as LocaleTree,
}

const reference = en as unknown as LocaleTree

/**
 * Recursively collect every dot-joined key path from a nested object.
 * e.g. { a: { b: "v" } } → ["a.b"]
 */
function collectKeys(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix]
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === "object" && v !== null) return collectKeys(v, path)
    return [path]
  })
}

const referenceKeys = collectKeys(reference).sort()

describe("i18n locale key parity", () => {
  describe.each(Object.entries(locales))("%s", (locale, bundle) => {
    const localeKeys = collectKeys(bundle).sort()

    it("contains no missing keys (keys present in en.json but absent in locale)", () => {
      const missing = referenceKeys.filter((k) => !localeKeys.includes(k))
      expect(missing, `Missing keys in ${locale}:\n  ${missing.join("\n  ")}`).toHaveLength(0)
    })

    it("contains no extra keys (keys present in locale but absent in en.json)", () => {
      const extra = localeKeys.filter((k) => !referenceKeys.includes(k))
      expect(extra, `Extra keys in ${locale}:\n  ${extra.join("\n  ")}`).toHaveLength(0)
    })
  })
})
