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

import { unreachable } from "../shared/util.js";

type CanvasAndContext = {
  canvas: HTMLCanvasElement | null;
  context: CanvasRenderingContext2D | null;
};

class BaseCanvasFactory {
  #enableHWA: boolean = false;

  constructor({ enableHWA = false }: { enableHWA?: boolean } = {}) {
    if (
      (typeof PDFJSDev === "undefined" || PDFJSDev!.test("TESTING")) &&
      this.constructor === BaseCanvasFactory
    ) {
      unreachable("Cannot initialize BaseCanvasFactory.");
    }
    this.#enableHWA = enableHWA;
  }

  create(width: number, height: number): CanvasAndContext {
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid canvas size");
    }
    const canvas = this._createCanvas(width, height);
    return {
      canvas,
      context: canvas.getContext("2d", {
        willReadFrequently: !this.#enableHWA,
      }),
    };
  }

  reset({ canvas }: { canvas: HTMLCanvasElement | null }, width: number, height: number): void {
    if (!canvas) {
      throw new Error("Canvas is not specified");
    }
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid canvas size");
    }
    canvas.width = width;
    canvas.height = height;
  }

  destroy(canvasAndContext: CanvasAndContext): void {
    const { canvas } = canvasAndContext;
    if (!canvas) {
      throw new Error("Canvas is not specified");
    }
    // Zeroing the width and height cause Firefox to release graphics
    // resources immediately, which can greatly reduce memory consumption.
    canvas.width = canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }

  /**
   * @ignore
   */
  _createCanvas(width: number, height: number): HTMLCanvasElement {
    unreachable("Abstract method `_createCanvas` called.");
  }
}

class DOMCanvasFactory extends BaseCanvasFactory {
  _document: Document;

  constructor({
    ownerDocument = globalThis.document,
    enableHWA = false,
  }: {
    ownerDocument?: Document;
    enableHWA?: boolean;
  } = {}) {
    super({ enableHWA });
    this._document = ownerDocument;
  }

  /**
   * @ignore
   */
  override _createCanvas(width: number, height: number): HTMLCanvasElement {
    const canvas = this._document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
}

export { BaseCanvasFactory, DOMCanvasFactory };
