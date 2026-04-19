/* Copyright 2013 Mozilla Foundation
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

import { isPdfFile } from "pdfjs-lib";

class BaseDownloadManager {
  #openBlobUrls = new WeakMap<Uint8Array<ArrayBuffer>, string>();

  constructor() {
    if (
      (typeof PDFJSDev === "undefined" || PDFJSDev!.test("TESTING")) &&
      this.constructor === BaseDownloadManager
    ) {
      throw new Error("Cannot initialize BaseDownloadManager.");
    }
  }

  _triggerDownload(
    blobUrl: string | null,
    originalUrl: string,
    filename: string,
    isAttachment = false
  ): void {
    throw new Error("Not implemented: _triggerDownload");
  }

  _getOpenDataUrl(blobUrl: string, filename: string, dest: string | null = null): string {
    throw new Error("Not implemented: _getOpenDataUrl");
  }

  /**
   * @param {Uint8Array<ArrayBuffer>} data
   * @param {string} filename
   * @param {string} [contentType]
   */
  downloadData(data: Uint8Array<ArrayBuffer>, filename: string, contentType?: string): void {
    const blobUrl = URL.createObjectURL(
      new Blob([data], { type: contentType })
    );

    this._triggerDownload(
      blobUrl,
      /* originalUrl = */ blobUrl,
      filename,
      /* isAttachment = */ true
    );
  }

  /**
   * @param {Uint8Array<ArrayBuffer>} data
   * @param {string} filename
   * @param {string | null} [dest]
   * @returns {boolean} Indicating if the data was opened.
   */
  openOrDownloadData(data: Uint8Array<ArrayBuffer>, filename: string, dest: string | null = null): boolean {
    const isPdfData = isPdfFile(filename);
    const contentType = isPdfData ? "application/pdf" : "";

    if (isPdfData) {
      const blobUrl = this.#openBlobUrls.getOrInsertComputed(data, () =>
        URL.createObjectURL(new Blob([data], { type: contentType }))
      );
      try {
        const viewerUrl = this._getOpenDataUrl(blobUrl, filename, dest);

        window.open(viewerUrl);
        return true;
      } catch (ex) {
        console.error("openOrDownloadData:", ex);
        // Release the `blobUrl`, since opening it failed, and fallback to
        // downloading the PDF file.
        URL.revokeObjectURL(blobUrl);
        this.#openBlobUrls.delete(data);
      }
    }

    this.downloadData(data, filename, contentType);
    return false;
  }

  /**
   * @param {Uint8Array<ArrayBuffer>} data
   * @param {string} url
   * @param {string} filename
   */
  download(data: Uint8Array<ArrayBuffer> | null, url: string, filename: string): void {
    const blobUrl = data
      ? URL.createObjectURL(new Blob([data], { type: "application/pdf" }))
      : null;

    this._triggerDownload(blobUrl, /* originalUrl = */ url, filename);
  }
}

export { BaseDownloadManager };
