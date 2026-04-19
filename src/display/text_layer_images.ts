/* Copyright 2026 Mozilla Foundation
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

import { Util } from "../shared/util.js";

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

type ImageCoords = {
  inverseTransform: number[];
  width: number;
  height: number;
  x1: number;
  y1: number;
};

/**
 * Used to manage paceholder <canvas> elements that, when right-clicked on,
 * are populated with the corresponding image extracted from the PDF page.
 */
class TextLayerImages {
  #coordinates: Float32Array = new Float32Array(0);

  #coordinatesByElement = new Map<HTMLCanvasElement, ImageCoords>();

  #getPageCanvas: (() => HTMLCanvasElement | null) | null = null;

  #minSize: number = 0;

  #pageWidth: number = 0;

  #pageHeight: number = 0;

  static #activeImage: WeakRef<HTMLCanvasElement> | null = null;

  constructor(
    minSize: number,
    coordinates: Float32Array,
    viewport: { rawDims: { pageWidth: number; pageHeight: number } },
    getPageCanvas: () => HTMLCanvasElement | null
  ) {
    this.#minSize = minSize;
    this.#coordinates = coordinates;
    this.#pageWidth = viewport.rawDims.pageWidth;
    this.#pageHeight = viewport.rawDims.pageHeight;
    this.#getPageCanvas = getPageCanvas;
  }

  render() {
    const container = document.createElement("div");
    container.className = "textLayerImages";

    for (let i = 0; i < this.#coordinates.length; i += 6) {
      const el = this.#createImagePlaceholder(
        this.#coordinates.subarray(i, i + 6)
      );
      if (el) {
        container.append(el);
      }
    }

    container.addEventListener("contextmenu", event => {
      if (!(event.target instanceof HTMLCanvasElement)) {
        return;
      }
      const imgElement = event.target;
      const coords = this.#coordinatesByElement.get(imgElement);
      if (!coords) {
        return;
      }

      const activeImage = TextLayerImages.#activeImage?.deref();
      if (activeImage === imgElement) {
        return;
      }
      if (activeImage) {
        activeImage.width = 0;
        activeImage.height = 0;
      }
      TextLayerImages.#activeImage = new WeakRef(imgElement);

      const { inverseTransform, x1, y1, width, height } = coords;

      const pageCanvas = this.#getPageCanvas!()!;

      const imageX1 = Math.ceil(x1 * pageCanvas.width);
      const imageY1 = Math.ceil(y1 * pageCanvas.height);
      const imageX2 = Math.floor(
        (x1 + width / this.#pageWidth) * pageCanvas.width
      );
      const imageY2 = Math.floor(
        (y1 + height / this.#pageHeight) * pageCanvas.height
      );

      imgElement.width = imageX2 - imageX1;
      imgElement.height = imageY2 - imageY1;

      const ctx = imgElement.getContext("2d")!;
      ctx.setTransform(...(inverseTransform as [number, number, number, number, number, number]));
      ctx.translate(-imageX1, -imageY1);
      ctx.drawImage(pageCanvas, 0, 0);
    });

    return container;
  }

  #createImagePlaceholder(coords: Float32Array): HTMLCanvasElement | null {
    const [x1, y1, x2, y2, x3, y3] = coords; // top left, bottom left, top right
    const width = Math.hypot(
      (x3 - x1) * this.#pageWidth,
      (y3 - y1) * this.#pageHeight
    );
    const height = Math.hypot(
      (x2 - x1) * this.#pageWidth,
      (y2 - y1) * this.#pageHeight
    );

    if (width < this.#minSize || height < this.#minSize) {
      return null;
    }

    const transform = [
      ((x3 - x1) * this.#pageWidth) / width,
      ((y3 - y1) * this.#pageHeight) / width,
      ((x2 - x1) * this.#pageWidth) / height,
      ((y2 - y1) * this.#pageHeight) / height,
      0,
      0,
    ];
    const inverseTransform = Util.inverseTransform(transform);

    const imgElement = document.createElement("canvas");
    imgElement.className = "textLayerImagePlaceholder";
    imgElement.width = 0;
    imgElement.height = 0;
    Object.assign(imgElement.style, {
      opacity: 0,
      position: "absolute",
      left: percentage(x1),
      top: percentage(y1),
      width: percentage(width / this.#pageWidth),
      height: percentage(height / this.#pageHeight),
      transformOrigin: "0% 0%",
      transform: `matrix(${transform.join(",")})`,
    });

    this.#coordinatesByElement.set(imgElement, {
      inverseTransform,
      width,
      height,
      x1,
      y1,
    });

    return imgElement;
  }
}

export { TextLayerImages };
