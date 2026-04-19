/* Copyright 2015 Mozilla Foundation
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

import { stringToBytes, unreachable } from "../shared/util.js";
import { fetchData } from "./display_utils.js";

type BinaryDataKind = "cMapUrl" | "standardFontDataUrl" | "wasmUrl";

class BaseBinaryDataFactory {
  #errorStr: Readonly<Record<BinaryDataKind, string>> = Object.freeze({
    cMapUrl: "CMap",
    standardFontDataUrl: "font",
    wasmUrl: "wasm",
  });

  cMapUrl: string | null;
  standardFontDataUrl: string | null;
  wasmUrl: string | null;

  constructor({
    cMapUrl = null,
    standardFontDataUrl = null,
    wasmUrl = null,
  }: {
    cMapUrl?: string | null;
    standardFontDataUrl?: string | null;
    wasmUrl?: string | null;
  } = {}) {
    if (
      (typeof PDFJSDev === "undefined" || PDFJSDev!.test("TESTING")) &&
      this.constructor === BaseBinaryDataFactory
    ) {
      unreachable("Cannot initialize BaseBinaryDataFactory.");
    }
    this.cMapUrl = cMapUrl;
    this.standardFontDataUrl = standardFontDataUrl;
    this.wasmUrl = wasmUrl;
  }

  async fetch({ kind, filename }: { kind: BinaryDataKind; filename: string }): Promise<Uint8Array> {
    switch (kind) {
      case "cMapUrl":
      case "standardFontDataUrl":
      case "wasmUrl":
        break;
      default:
        unreachable(`Not implemented: ${kind}`);
    }
    const baseUrl = this[kind];
    if (!baseUrl) {
      throw new Error(`Ensure that the \`${kind}\` API parameter is provided.`);
    }
    const url = `${baseUrl}${filename}`;

    return this._fetch(url, kind).catch(() => {
      throw new Error(`Unable to load ${this.#errorStr[kind]} data at: ${url}`);
    });
  }

  /**
   * @ignore
   */
  async _fetch(url: string, kind: string): Promise<Uint8Array> {
    unreachable("Abstract method `_fetch` called.");
  }
}

class DOMBinaryDataFactory extends BaseBinaryDataFactory {
  /**
   * @ignore
   */
  override async _fetch(url: string, kind: string): Promise<Uint8Array> {
    const type =
      kind === "cMapUrl" && !url.endsWith(".bcmap") ? "text" : "bytes";
    const data = await fetchData(url, type);
    return data instanceof Uint8Array ? data : stringToBytes(data);
  }
}

export { BaseBinaryDataFactory, DOMBinaryDataFactory };
