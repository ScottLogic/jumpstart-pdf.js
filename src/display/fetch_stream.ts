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

import { AbortException, assert } from "../shared/util.js";
import {
  BasePDFStream,
  BasePDFStreamRangeReader,
  BasePDFStreamReader,
} from "../shared/base_pdf_stream.js";
import {
  createHeaders,
  createResponseError,
  ensureResponseOrigin,
  extractFilenameFromHeader,
  getResponseOrigin,
  validateRangeRequestCapabilities,
} from "./network_utils.js";

if (typeof PDFJSDev !== "undefined" && PDFJSDev.test("MOZCENTRAL")) {
  throw new Error(
    'Module "./fetch_stream.js" shall not be used with MOZCENTRAL builds.'
  );
}

type ReadResult = { value: ArrayBuffer | undefined; done: boolean };

function fetchUrl(url: string | URL, headers: Headers, withCredentials: boolean, abortController: AbortController) {
  return fetch(url, {
    method: "GET",
    headers,
    signal: abortController.signal,
    mode: "cors",
    credentials: withCredentials ? "include" : "same-origin",
    redirect: "follow",
  });
}

function ensureResponseStatus(status: number, url: string | URL) {
  if (status !== 200 && status !== 206) {
    throw createResponseError(status, url as any);
  }
}

function getArrayBuffer(val: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (val instanceof Uint8Array) {
    return val.buffer as ArrayBuffer;
  }
  if (val instanceof ArrayBuffer) {
    return val;
  }
  throw new Error(`getArrayBuffer - unexpected data: ${val}`);
}

class PDFFetchStream extends BasePDFStream {
  _responseOrigin: string | null = null;

  declare headers: Headers;

  constructor(source: any) {
    super(source, PDFFetchStreamReader, PDFFetchStreamRangeReader);
    const { httpHeaders, url } = source;

    assert(
      /https?:/.test(url.protocol),
      "PDFFetchStream only supports http(s):// URLs."
    );
    this.headers = createHeaders(/* isHttp = */ true, httpHeaders);
  }
}

class PDFFetchStreamReader extends BasePDFStreamReader {
  _abortController = new AbortController();

  _reader: any = null;

  constructor(stream: BasePDFStream) {
    super(stream);
    const {
      disableRange,
      disableStream,
      rangeChunkSize,
      url,
      withCredentials,
    } = (stream as any)._source;

    this._isStreamingSupported = !disableStream;
    // Always create a copy of the headers.
    const headers = new Headers((stream as PDFFetchStream).headers);

    fetchUrl(url, headers, withCredentials, this._abortController)
      .then(response => {
        (stream as PDFFetchStream)._responseOrigin = getResponseOrigin(response.url);

        ensureResponseStatus(response.status, url);
        this._reader = response.body!.getReader();

        const responseHeaders = response.headers;

        const { contentLength, isRangeSupported } =
          validateRangeRequestCapabilities({
            responseHeaders,
            isHttp: true,
            rangeChunkSize,
            disableRange,
          });
        this._contentLength = contentLength;
        this._isRangeSupported = isRangeSupported;

        this._filename = extractFilenameFromHeader(responseHeaders);

        // We need to stop reading when range is supported and streaming is
        // disabled.
        if (!this._isStreamingSupported && this._isRangeSupported) {
          this.cancel(new AbortException("Streaming is disabled."));
        }

        this._headersCapability.resolve();
      })
      .catch(this._headersCapability.reject);
  }

  async read(): Promise<ReadResult> {
    await this._headersCapability.promise;
    const { value, done } = await this._reader.read();
    if (done) {
      return { value: undefined, done };
    }
    this._loaded += value.byteLength;
    this._callOnProgress();

    return { value: getArrayBuffer(value), done: false };
  }

  cancel(reason: unknown) {
    this._reader?.cancel(reason);
    this._abortController.abort();
  }
}

class PDFFetchStreamRangeReader extends BasePDFStreamRangeReader {
  _abortController = new AbortController();

  _readCapability = Promise.withResolvers<void>();

  _reader: any = null;

  constructor(stream: BasePDFStream, begin: number, end: number) {
    super(stream, begin, end);
    const { url, withCredentials } = (stream as any)._source;

    // Always create a copy of the headers.
    const headers = new Headers((stream as PDFFetchStream).headers);
    headers.append("Range", `bytes=${begin}-${end - 1}`);

    fetchUrl(url, headers, withCredentials, this._abortController)
      .then(response => {
        const responseOrigin = getResponseOrigin(response.url);

        ensureResponseOrigin(responseOrigin, (stream as PDFFetchStream)._responseOrigin);
        ensureResponseStatus(response.status, url);
        this._reader = response.body!.getReader();

        this._readCapability.resolve();
      })
      .catch(this._readCapability.reject);
  }

  async read(): Promise<ReadResult> {
    await this._readCapability.promise;
    const { value, done } = await this._reader.read();
    if (done) {
      return { value: undefined, done };
    }
    return { value: getArrayBuffer(value), done: false };
  }

  cancel(reason: unknown) {
    this._reader?.cancel(reason);
    this._abortController.abort();
  }
}

export { getArrayBuffer, PDFFetchStream };
