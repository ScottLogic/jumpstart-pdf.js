/* Copyright 2012 Mozilla Foundation
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

import {
  _isValidExplicitDest,
  isNodeJS,
  stringToBytes,
  warn,
} from "../shared/util.js";

function getUrlProp(val: unknown): URL | null {
  if (typeof PDFJSDev !== "undefined" && PDFJSDev!.test("MOZCENTRAL")) {
    return null; // The 'url' is unused with `PDFDataRangeTransport`.
  }
  if (val instanceof URL) {
    return val;
  }
  if (typeof val === "string") {
    if (
      typeof PDFJSDev !== "undefined" &&
      PDFJSDev!.test("GENERIC") &&
      isNodeJS
    ) {
      if (/^[a-z][a-z0-9\-+.]+:/i.test(val)) {
        return new URL(val);
      }

      const url = (process as any).getBuiltinModule("url");
      return new URL(url.pathToFileURL(val));
    }

    // The full path is required in the 'url' field.
    const url = URL.parse(val, window.location.href);
    if (url) {
      return url;
    }
  }
  throw new Error(
    "Invalid PDF url data: " +
      "either string or URL-object is expected in the url property."
  );
}

function getDataProp(val: unknown): Uint8Array {
  // Converting string or array-like data to Uint8Array.
  if (
    typeof PDFJSDev !== "undefined" &&
    PDFJSDev!.test("GENERIC") &&
    isNodeJS &&
    typeof (globalThis as any).Buffer !== "undefined" &&
    val instanceof (globalThis as any).Buffer
  ) {
    throw new Error(
      "Please provide binary data as `Uint8Array`, rather than `Buffer`."
    );
  }
  if (val instanceof Uint8Array && val.byteLength === val.buffer.byteLength) {
    // Use the data as-is when it's already a Uint8Array that completely
    // "utilizes" its underlying ArrayBuffer, to prevent any possible
    // issues when transferring it to the worker-thread.
    return val;
  }
  if (typeof val === "string") {
    return stringToBytes(val);
  }
  if (
    val instanceof ArrayBuffer ||
    ArrayBuffer.isView(val) ||
    (typeof val === "object" && val !== null && !isNaN((val as any).length))
  ) {
    return new Uint8Array(val as any);
  }
  throw new Error(
    "Invalid PDF binary data: either TypedArray, " +
      "string, or array-like object is expected in the data property."
  );
}

function getFactoryUrlProp(val: unknown): string | null {
  if (typeof val !== "string") {
    return null;
  }
  if (val.endsWith("/")) {
    return val;
  }
  throw new Error(`Invalid factory url: "${val}" must include trailing slash.`);
}

const isRefProxy = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  Number.isInteger((v as any).num) &&
  (v as any).num >= 0 &&
  Number.isInteger((v as any).gen) &&
  (v as any).gen >= 0;

const isNameProxy = (v: unknown): boolean =>
  typeof v === "object" && v !== null && typeof (v as any).name === "string";

const isValidExplicitDest = _isValidExplicitDest.bind(
  null,
  /* validRef = */ isRefProxy,
  /* validName = */ isNameProxy
);

class LoopbackPort {
  #listeners: Map<(...args: any[]) => any, (() => void) | null> = new Map();

  #deferred: Promise<void> = Promise.resolve();

  postMessage(obj: any, transfer?: Transferable[]): void {
    const event = {
      data: structuredClone(obj, transfer ? { transfer } : undefined),
    };

    this.#deferred.then(() => {
      for (const [listener] of this.#listeners) {
        listener.call(this, event);
      }
    });
  }

  addEventListener(
    name: string,
    listener: (...args: any[]) => any,
    options: { signal?: AbortSignal } | null = null
  ): void {
    let rmAbort: (() => void) | null = null;
    if (options?.signal instanceof AbortSignal) {
      const { signal } = options;
      if (signal.aborted) {
        warn("LoopbackPort - cannot use an `aborted` signal.");
        return;
      }
      const onAbort = () => this.removeEventListener(name, listener);
      rmAbort = () => signal.removeEventListener("abort", onAbort);

      signal.addEventListener("abort", onAbort);
    }
    this.#listeners.set(listener, rmAbort);
  }

  removeEventListener(name: string, listener: (...args: any[]) => any): void {
    const rmAbort = this.#listeners.get(listener);
    rmAbort?.();

    this.#listeners.delete(listener);
  }

  terminate(): void {
    for (const [, rmAbort] of this.#listeners) {
      rmAbort?.();
    }
    this.#listeners.clear();
  }
}

export {
  getDataProp,
  getFactoryUrlProp,
  getUrlProp,
  isNameProxy,
  isRefProxy,
  isValidExplicitDest,
  LoopbackPort,
};
