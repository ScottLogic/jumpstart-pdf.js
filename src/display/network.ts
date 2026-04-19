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

import { assert, stringToBytes, warn } from "../shared/util.js";
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
import { endRequests } from "./transport_stream.js";

type ReadResult = { value: ArrayBuffer | undefined; done: boolean };
type ReadCapability = ReturnType<typeof Promise.withResolvers<ReadResult>>;

type PendingRequest = {
  validateStatus: ((status: number) => boolean) | null;
  onHeadersReceived?: () => void;
  onDone: (chunk: ArrayBuffer) => void;
  onError: (status: number) => void;
  onProgress: ((evt: ProgressEvent) => void) | null;
};

type RequestArgs = {
  onHeadersReceived?: () => void;
  onDone: (chunk: ArrayBuffer) => void;
  onError: (status: number) => void;
  onProgress: ((evt: ProgressEvent) => void) | null;
  begin?: number;
  end?: number;
};

if (typeof PDFJSDev !== "undefined" && PDFJSDev.test("MOZCENTRAL")) {
  throw new Error(
    'Module "./network.js" shall not be used with MOZCENTRAL builds.'
  );
}

const OK_RESPONSE = 200;
const PARTIAL_CONTENT_RESPONSE = 206;

function getArrayBuffer(val: string | ArrayBuffer): ArrayBuffer {
  return typeof val !== "string" ? val : (stringToBytes(val).buffer as ArrayBuffer);
}

class PDFNetworkStream extends BasePDFStream {
  #pendingRequests = new WeakMap<XMLHttpRequest, PendingRequest>();

  _responseOrigin: string | null = null;

  declare url: URL;

  declare isHttp: boolean;

  declare headers: Headers;

  constructor(source: any) {
    super(source, PDFNetworkStreamReader, PDFNetworkStreamRangeReader);
    const { httpHeaders, url } = source;

    this.url = url;
    this.isHttp = /https?:/.test(url.protocol);
    this.headers = createHeaders(this.isHttp, httpHeaders);
  }

  /**
   * @ignore
   */
  _request(args: RequestArgs): XMLHttpRequest {
    const xhr = new XMLHttpRequest();
    const pendingRequest: PendingRequest = {
      validateStatus: null,
      onHeadersReceived: args.onHeadersReceived,
      onDone: args.onDone,
      onError: args.onError,
      onProgress: args.onProgress,
    };
    this.#pendingRequests.set(xhr, pendingRequest);

    xhr.open("GET", this.url);
    xhr.withCredentials = (this._source as any).withCredentials;
    for (const [key, val] of this.headers) {
      xhr.setRequestHeader(key, val);
    }
    if (this.isHttp && "begin" in args && "end" in args) {
      xhr.setRequestHeader("Range", `bytes=${args.begin}-${args.end! - 1}`);

      // From http://www.w3.org/Protocols/rfc2616/rfc2616-sec14.html#sec14.35.2:
      // "A server MAY ignore the Range header". This means it's possible to
      // get a 200 rather than a 206 response from a range request.
      pendingRequest.validateStatus = status =>
        status === PARTIAL_CONTENT_RESPONSE || status === OK_RESPONSE;
    } else {
      pendingRequest.validateStatus = status => status === OK_RESPONSE;
    }
    xhr.responseType = "arraybuffer";

    assert(args.onError, "Expected `onError` callback to be provided.");
    xhr.onerror = () => args.onError(xhr.status);
    xhr.onreadystatechange = this.#onStateChange.bind(this, xhr) as any;
    xhr.onprogress = this.#onProgress.bind(this, xhr) as any;

    xhr.send(null);

    return xhr;
  }

  #onProgress(xhr: XMLHttpRequest, evt: ProgressEvent) {
    const pendingRequest = this.#pendingRequests.get(xhr);
    pendingRequest?.onProgress?.(evt);
  }

  #onStateChange(xhr: XMLHttpRequest, _evt: Event) {
    const pendingRequest = this.#pendingRequests.get(xhr);
    if (!pendingRequest) {
      return; // Maybe abortRequest was called...
    }

    if (xhr.readyState >= 2 && pendingRequest.onHeadersReceived) {
      pendingRequest.onHeadersReceived();
      delete pendingRequest.onHeadersReceived;
    }

    if (xhr.readyState !== 4) {
      return;
    }

    if (!this.#pendingRequests.has(xhr)) {
      // The XHR request might have been aborted in onHeadersReceived()
      // callback, in which case we should abort request.
      return;
    }
    this.#pendingRequests.delete(xhr);

    // Success status == 0 can be on ftp, file and other protocols.
    if (xhr.status === 0 && this.isHttp) {
      pendingRequest.onError(xhr.status);
      return;
    }
    const xhrStatus = xhr.status || OK_RESPONSE;

    if (!pendingRequest.validateStatus!(xhrStatus)) {
      pendingRequest.onError(xhr.status);
      return;
    }

    const chunk = getArrayBuffer(xhr.response);
    if (xhrStatus === PARTIAL_CONTENT_RESPONSE) {
      const rangeHeader = xhr.getResponseHeader("Content-Range");
      if (/bytes (\d+)-(\d+)\/(\d+)/.test(rangeHeader!)) {
        pendingRequest.onDone(chunk);
      } else {
        warn(`Missing or invalid "Content-Range" header.`);
        pendingRequest.onError(0);
      }
    } else if (chunk) {
      pendingRequest.onDone(chunk);
    } else {
      pendingRequest.onError(xhr.status);
    }
  }

  /**
   * Abort the request, if it's pending.
   * @ignore
   */
  _abortRequest(xhr: XMLHttpRequest) {
    if (this.#pendingRequests.has(xhr)) {
      this.#pendingRequests.delete(xhr);
      xhr.abort();
    }
  }

  override getRangeReader(begin: number, end: number) {
    const reader = super.getRangeReader(begin, end);

    if (reader) {
      (reader as PDFNetworkStreamRangeReader).onClosed = () =>
        this._rangeReaders.delete(reader);
    }
    return reader;
  }
}

class PDFNetworkStreamReader extends BasePDFStreamReader {
  #endRequests = endRequests.bind(this) as () => void;

  _cachedChunks: ArrayBuffer[] = [];

  _done = false;

  _requests: ReadCapability[] = [];

  _storedError: Error | null = null;

  _fullRequestXhr: XMLHttpRequest | null = null;

  constructor(stream: BasePDFStream) {
    super(stream);
    // Note that `XMLHttpRequest` doesn't support streaming, and range requests
    // will be enabled (if supported) in `this.#onHeadersReceived` below.

    this._fullRequestXhr = (stream as PDFNetworkStream)._request({
      onHeadersReceived: this.#onHeadersReceived.bind(this),
      onDone: this.#onDone.bind(this),
      onError: this.#onError.bind(this),
      onProgress: this.#onProgress.bind(this),
    });
  }

  #onHeadersReceived() {
    const stream = this._stream as PDFNetworkStream;
    const { disableRange, rangeChunkSize } = stream._source as any;
    const fullRequestXhr = this._fullRequestXhr!;

    stream._responseOrigin = getResponseOrigin(fullRequestXhr.responseURL);

    const rawResponseHeaders = fullRequestXhr.getAllResponseHeaders();
    const responseHeaders = new Headers(
      rawResponseHeaders
        ? rawResponseHeaders
            .trimStart()
            .replace(/[^\S ]+$/, "") // Not `trimEnd`, to keep regular spaces.
            .split(/[\r\n]+/)
            .map(x => {
              const [key, ...val] = x.split(": ");
              return [key, val.join(": ")] as [string, string];
            })
        : []
    );

    const { contentLength, isRangeSupported } =
      validateRangeRequestCapabilities({
        responseHeaders,
        isHttp: stream.isHttp,
        rangeChunkSize,
        disableRange,
      });
    this._contentLength = contentLength;
    this._isRangeSupported = isRangeSupported;

    this._filename = extractFilenameFromHeader(responseHeaders);

    if (this._isRangeSupported) {
      // NOTE: by cancelling the full request, and then issuing range
      // requests, there will be an issue for sites where you can only
      // request the pdf once. However, if this is the case, then the
      // server should not be returning that it can support range requests.
      stream._abortRequest(fullRequestXhr);
    }

    this._headersCapability.resolve();
  }

  #onDone(chunk: ArrayBuffer) {
    if (this._requests.length > 0) {
      const capability = this._requests.shift()!;
      capability.resolve({ value: chunk, done: false });
    } else {
      this._cachedChunks.push(chunk);
    }
    this._done = true;
    if (this._cachedChunks.length === 0) {
      this.#endRequests();
    }
  }

  #onError(status: number) {
    this._storedError = createResponseError(status, (this._stream as PDFNetworkStream).url);
    this._headersCapability.reject(this._storedError);
    for (const capability of this._requests) {
      capability.reject(this._storedError);
    }
    this._requests.length = 0;
    this._cachedChunks.length = 0;
  }

  #onProgress(evt: ProgressEvent) {
    this.onProgress?.({
      loaded: evt.loaded,
      total: evt.lengthComputable ? evt.total : this._contentLength,
    });
  }

  override async read(): Promise<ReadResult> {
    await this._headersCapability.promise;

    if (this._storedError) {
      throw this._storedError;
    }
    if (this._cachedChunks.length > 0) {
      const chunk = this._cachedChunks.shift()!;
      return { value: chunk, done: false };
    }
    if (this._done) {
      return { value: undefined, done: true };
    }
    const capability = Promise.withResolvers<ReadResult>();
    this._requests.push(capability);
    return capability.promise;
  }

  override cancel(reason: unknown) {
    this._done = true;
    this._headersCapability.reject(reason);
    this.#endRequests();

    (this._stream as PDFNetworkStream)._abortRequest(this._fullRequestXhr!);
    this._fullRequestXhr = null;
  }
}

class PDFNetworkStreamRangeReader extends BasePDFStreamRangeReader {
  #endRequests = endRequests.bind(this) as () => void;

  onClosed: (() => void) | null = null;

  _done = false;

  _queuedChunk: ArrayBuffer | null = null;

  _requests: ReadCapability[] = [];

  _storedError: Error | null = null;

  _requestXhr: XMLHttpRequest | null = null;

  constructor(stream: BasePDFStream, begin: number, end: number) {
    super(stream, begin, end);

    this._requestXhr = (stream as PDFNetworkStream)._request({
      begin,
      end,
      onHeadersReceived: this.#onHeadersReceived.bind(this),
      onDone: this.#onDone.bind(this),
      onError: this.#onError.bind(this),
      onProgress: null,
    });
  }

  #onHeadersReceived() {
    const responseOrigin = getResponseOrigin(this._requestXhr?.responseURL ?? "");
    try {
      ensureResponseOrigin(responseOrigin, (this._stream as PDFNetworkStream)._responseOrigin);
    } catch (ex) {
      this._storedError = ex as Error;
      this.#onError(0);
    }
  }

  #onDone(chunk: ArrayBuffer) {
    if (this._requests.length > 0) {
      const capability = this._requests.shift()!;
      capability.resolve({ value: chunk, done: false });
    } else {
      this._queuedChunk = chunk;
    }
    this._done = true;
    this.#endRequests();
    this.onClosed?.();
  }

  #onError(status: number) {
    this._storedError ??= createResponseError(status, (this._stream as PDFNetworkStream).url);
    for (const capability of this._requests) {
      capability.reject(this._storedError);
    }
    this._requests.length = 0;
    this._queuedChunk = null;
  }

  override async read(): Promise<ReadResult> {
    if (this._storedError) {
      throw this._storedError;
    }
    if (this._queuedChunk !== null) {
      const chunk = this._queuedChunk;
      this._queuedChunk = null;
      return { value: chunk, done: false };
    }
    if (this._done) {
      return { value: undefined, done: true };
    }
    const capability = Promise.withResolvers<ReadResult>();
    this._requests.push(capability);
    return capability.promise;
  }

  override cancel(_reason: unknown) {
    this._done = true;
    this.#endRequests();

    (this._stream as PDFNetworkStream)._abortRequest(this._requestXhr!);
    this.onClosed?.();
  }
}

export { PDFNetworkStream };
