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
import { createResponseError } from "./network_utils.js";
import { getArrayBuffer } from "./fetch_stream.js";

type ReadResult = { value: ArrayBuffer | undefined; done: boolean };

if (typeof PDFJSDev !== "undefined" && PDFJSDev.test("MOZCENTRAL")) {
  throw new Error(
    'Module "./node_stream.js" shall not be used with MOZCENTRAL builds.'
  );
}

function getReadableStream(url: string | URL, opts: any = null) {
  const fs = (process as any).getBuiltinModule("fs");
  const { Readable } = (process as any).getBuiltinModule("stream");

  const readStream = fs.createReadStream(url, opts);
  return Readable.toWeb(readStream);
}

class PDFNodeStream extends BasePDFStream {
  constructor(source: any) {
    super(source, PDFNodeStreamReader, PDFNodeStreamRangeReader);
    const { url } = source;

    assert(
      url.protocol === "file:",
      "PDFNodeStream only supports file:// URLs."
    );
  }
}

class PDFNodeStreamReader extends BasePDFStreamReader {
  _reader: any = null;

  constructor(stream: BasePDFStream) {
    super(stream);
    const { disableRange, disableStream, rangeChunkSize, url } = (stream as any)._source;

    this._isStreamingSupported = !disableStream;

    const fs = (process as any).getBuiltinModule("fs/promises");
    fs.lstat(url)
      .then((stat: any) => {
        const readableStream = getReadableStream(url);
        this._reader = readableStream.getReader();

        const { size } = stat;
        this._contentLength = size;
        // When the file size is smaller than the size of two chunks, it doesn't
        // make any sense to abort the request and retry with a range request.
        this._isRangeSupported = !disableRange && size > 2 * rangeChunkSize;

        // We need to stop reading when range is supported and streaming is
        // disabled.
        if (!this._isStreamingSupported && this._isRangeSupported) {
          this.cancel(new AbortException("Streaming is disabled."));
        }

        this._headersCapability.resolve();
      })
      .catch((error: any) => {
        if (error.code === "ENOENT") {
          error = createResponseError(/* status = */ 0, url);
        }
        this._headersCapability.reject(error);
      });
  }

  async read(): Promise<ReadResult> {
    await this._headersCapability.promise;
    const { value, done } = await this._reader.read();
    if (done) {
      return { value: undefined, done };
    }
    this._loaded += value.byteLength;
    this._callOnProgress();

    return { value: getArrayBuffer(value) as ArrayBuffer, done: false };
  }

  cancel(reason: unknown) {
    this._reader?.cancel(reason);
  }
}

class PDFNodeStreamRangeReader extends BasePDFStreamRangeReader {
  _readCapability = Promise.withResolvers<void>();

  _reader: any = null;

  constructor(stream: BasePDFStream, begin: number, end: number) {
    super(stream, begin, end);
    const { url } = (stream as any)._source;

    try {
      const readableStream = getReadableStream(url, {
        start: begin,
        end: end - 1,
      });
      this._reader = readableStream.getReader();

      this._readCapability.resolve();
    } catch (error) {
      this._readCapability.reject(error);
    }
  }

  async read(): Promise<ReadResult> {
    await this._readCapability.promise;
    const { value, done } = await this._reader.read();
    if (done) {
      return { value: undefined, done };
    }
    return { value: getArrayBuffer(value) as ArrayBuffer, done: false };
  }

  cancel(reason: unknown) {
    this._reader?.cancel(reason);
  }
}

export { PDFNodeStream };
