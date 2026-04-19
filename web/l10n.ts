/* Copyright 2023 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

interface IL10nProvider {
  formatMessages(
    ids: Array<{ id: string; args?: Record<string, string> | null }>
  ): Promise<Array<{ value: string | null }>>;
  connectRoot(element: HTMLElement): void;
  translateRoots(): Promise<void>;
  translateElements(elements: HTMLElement[]): Promise<void>;
  disconnectRoot(element: HTMLElement): void;
  pauseObserving(): void;
  resumeObserving(): void;
}

/**
 * NOTE: The L10n-implementations should use lowercase language-codes
 *       internally.
 */
class L10n {
  #dir: string;

  #elements: Set<HTMLElement> | null = null;

  #lang: string;

  #l10n: IL10nProvider | null;

  constructor({ lang, isRTL }: { lang: string; isRTL?: boolean }, l10n: IL10nProvider | null = null) {
    this.#lang = L10n.#fixupLangCode(lang);
    this.#l10n = l10n;
    this.#dir = (isRTL ?? L10n.#isRTL(this.#lang)) ? "rtl" : "ltr";
  }

  _setL10n(l10n: IL10nProvider): void {
    this.#l10n = l10n;
    if (typeof PDFJSDev !== "undefined" && PDFJSDev.test("TESTING")) {
      document.l10n = l10n;
    }
  }

  /** @inheritdoc */
  getLanguage(): string {
    return this.#lang;
  }

  /** @inheritdoc */
  getDirection(): string {
    return this.#dir;
  }

  /** @inheritdoc */
  async get(
    ids: string | string[],
    args: Record<string, string> | null = null,
    fallback?: string
  ): Promise<string | string[]> {
    if (Array.isArray(ids)) {
      const messages = await this.#l10n!.formatMessages(ids.map(id => ({ id })));
      return messages.map(message => message.value as string);
    }

    const messages = await this.#l10n!.formatMessages([{ id: ids, args }]);
    return (messages[0]?.value ?? fallback) as string;
  }

  /** @inheritdoc */
  async translate(element: HTMLElement): Promise<void> {
    (this.#elements ||= new Set()).add(element);
    try {
      this.#l10n!.connectRoot(element);
      await this.#l10n!.translateRoots();
    } catch {
      // Element is under an existing root, so there is no need to add it again.
    }
  }

  /** @inheritdoc */
  async translateOnce(element: HTMLElement): Promise<void> {
    try {
      await this.#l10n!.translateElements([element]);
    } catch (ex) {
      console.error("translateOnce:", ex);
    }
  }

  /** @inheritdoc */
  async destroy(): Promise<void> {
    if (this.#elements) {
      for (const element of this.#elements) {
        this.#l10n!.disconnectRoot(element);
      }
      this.#elements.clear();
      this.#elements = null;
    }
    this.#l10n!.pauseObserving();
  }

  /** @inheritdoc */
  pause(): void {
    this.#l10n!.pauseObserving();
  }

  /** @inheritdoc */
  resume(): void {
    this.#l10n!.resumeObserving();
  }

  static #fixupLangCode(langCode: string | null | undefined): string {
    // Use only lowercase language-codes internally, and fallback to English.
    langCode = langCode?.toLowerCase() || "en-us";

    // Try to support "incompletely" specified language codes (see issue 13689).
    const PARTIAL_LANG_CODES = {
      en: "en-us",
      es: "es-es",
      fy: "fy-nl",
      ga: "ga-ie",
      gu: "gu-in",
      hi: "hi-in",
      hy: "hy-am",
      nb: "nb-no",
      ne: "ne-np",
      nn: "nn-no",
      pa: "pa-in",
      pt: "pt-pt",
      sv: "sv-se",
      zh: "zh-cn",
    };
    return PARTIAL_LANG_CODES[langCode as keyof typeof PARTIAL_LANG_CODES] ?? langCode;
  }

  static #isRTL(lang: string): boolean {
    const shortCode = lang.split("-", 1)[0];
    return ["ar", "he", "fa", "ps", "ur"].includes(shortCode);
  }
}

const GenericL10n = null;

export { GenericL10n, L10n };
