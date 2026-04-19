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

import { RenderableView, RenderingStates } from "./renderable_view.js";
import { RenderingCancelledException } from "pdfjs-lib";

class BasePDFPageView extends RenderableView {
  #loadingId: ReturnType<typeof setTimeout> | null = null;
  #renderError: unknown = null;
  #renderingState: number = RenderingStates.INITIAL;
  #showCanvas: ((isLastShow: boolean) => void) | null = null;
  #startTime: number = 0;
  #tempCanvas: HTMLCanvasElement | null = null;

  canvas: HTMLCanvasElement | null = null;
  div: HTMLDivElement | null = null;
  enableOptimizedPartialRendering: boolean = false;
  imagesRightClickMinSize: number = -1;
  eventBus: any = null;
  id: number | null = null;
  imageCoordinates: any = null;
  pageColors: any = null;
  recordedBBoxes: any = null;
  renderingQueue: any = null;
  minDurationToUpdateCanvas: number = 500;
  declare pdfPage: any;
  declare renderTask: any;
  resume: (() => void) | null = null;

  constructor(options: {
    eventBus: any;
    id: number;
    pageColors?: any;
    renderingQueue?: any;
    enableOptimizedPartialRendering?: boolean;
    imagesRightClickMinSize?: number;
    minDurationToUpdateCanvas?: number;
  }) {
    super();
    this.eventBus = options.eventBus;
    this.id = options.id;
    this.pageColors = options.pageColors || null;
    this.renderingQueue = options.renderingQueue;
    this.enableOptimizedPartialRendering =
      options.enableOptimizedPartialRendering ?? false;
    this.imagesRightClickMinSize = options.imagesRightClickMinSize ?? -1;
    this.minDurationToUpdateCanvas = options.minDurationToUpdateCanvas ?? 500;
  }

  get renderingState(): number {
    return this.#renderingState;
  }

  set renderingState(state: number) {
    if (state === this.#renderingState) {
      return;
    }
    this.#renderingState = state;

    if (this.#loadingId) {
      clearTimeout(this.#loadingId);
      this.#loadingId = null;
    }

    switch (state) {
      case RenderingStates.PAUSED:
        this.div!.classList.remove("loading");
        // Display the canvas as it has been drawn.
        this.#startTime = 0;
        this.#showCanvas?.(false);
        break;
      case RenderingStates.RUNNING:
        this.div!.classList.add("loadingIcon");
        this.#loadingId = setTimeout(() => {
          // Adding the loading class is slightly postponed in order to not have
          // it with loadingIcon.
          // If we don't do that the visibility of the background is changed but
          // the transition isn't triggered.
          this.div!.classList.add("loading");
          this.#loadingId = null;
        }, 0);
        this.#startTime = Date.now();
        break;
      case RenderingStates.INITIAL:
      case RenderingStates.FINISHED:
        this.div!.classList.remove("loadingIcon", "loading");
        this.#startTime = 0;
        break;
    }
  }

  _createCanvas(onShow: (canvas: HTMLCanvasElement) => void, hideUntilComplete = false): { canvas: HTMLCanvasElement; prevCanvas: HTMLCanvasElement | null } {
    const { pageColors } = this;
    const hasHCM = !!(pageColors?.background && pageColors?.foreground);
    const prevCanvas = this.canvas;

    // In HCM, a final filter is applied on the canvas which means that
    // before it's applied we've normal colors. Consequently, to avoid to
    // have a final flash we just display it once all the drawing is done.
    const updateOnFirstShow = !prevCanvas && !hasHCM && !hideUntilComplete;

    let canvas = (this.canvas = document.createElement("canvas"));

    this.#showCanvas = isLastShow => {
      if (updateOnFirstShow) {
        let tempCanvas = this.#tempCanvas;
        if (!isLastShow && this.minDurationToUpdateCanvas > 0) {
          // We draw on the canvas at 60fps (in using `requestAnimationFrame`),
          // so if the canvas is large, updating it at 60fps can be a way too
          // much and can cause some serious performance issues.
          // To avoid that we only update the canvas every
          // `this.#minDurationToUpdateCanvas` ms.

          if (Date.now() - this.#startTime < this.minDurationToUpdateCanvas) {
            return;
          }
          if (!tempCanvas) {
            tempCanvas = this.#tempCanvas = canvas;
            canvas = this.canvas = canvas.cloneNode(false) as HTMLCanvasElement;
            onShow(canvas);
          }
        }

        if (tempCanvas) {
          const ctx = canvas.getContext("2d", {
            alpha: false,
          });
          ctx!.drawImage(tempCanvas, 0, 0);
          if (isLastShow) {
            this.#resetTempCanvas();
          } else {
            this.#startTime = Date.now();
          }
          return;
        }

        // Don't add the canvas until the first draw callback, or until
        // drawing is complete when `!this.renderingQueue`, to prevent black
        // flickering.
        onShow(canvas);
        this.#showCanvas = null;
        return;
      }
      if (!isLastShow) {
        return;
      }

      if (prevCanvas) {
        prevCanvas.replaceWith(canvas);
        prevCanvas.width = prevCanvas.height = 0;
      } else {
        onShow(canvas);
      }
    };

    return { canvas, prevCanvas };
  }

  #renderContinueCallback = (cont: () => void) => {
    this.#showCanvas?.(false);
    if (this.renderingQueue && !this.renderingQueue.isHighestPriority(this)) {
      this.renderingState = RenderingStates.PAUSED;
      this.resume = () => {
        this.renderingState = RenderingStates.RUNNING;
        cont();
      };
      return;
    }
    cont();
  };

  _resetCanvas(): void {
    const { canvas } = this;
    if (!canvas) {
      return;
    }
    canvas.remove();
    canvas.width = canvas.height = 0;
    this.canvas = null;
    this.#resetTempCanvas();
  }

  #resetTempCanvas(): void {
    if (this.#tempCanvas) {
      this.#tempCanvas.width = this.#tempCanvas.height = 0;
      this.#tempCanvas = null;
    }
  }

  async _drawCanvas(options: any, onCancel: () => void, onFinish: (renderTask: any) => void): Promise<void> {
    const renderTask = (this.renderTask = this.pdfPage.render(options));
    renderTask.onContinue = this.#renderContinueCallback;
    renderTask.onError = (error: unknown) => {
      if (error instanceof RenderingCancelledException) {
        onCancel();
        this.#renderError = null;
      }
    };

    let error: unknown = null;
    try {
      await renderTask.promise;
      this.#showCanvas?.(true);
    } catch (e) {
      // When zooming with a `drawingDelay` set, avoid temporarily showing
      // a black canvas if rendering was cancelled before the `onContinue`-
      // callback had been invoked at least once.
      if (e instanceof RenderingCancelledException) {
        return;
      }
      error = e;

      this.#showCanvas?.(true);
    } finally {
      this.#renderError = error;

      // The renderTask may have been replaced by a new one, so only remove
      // the reference to the renderTask if it matches the one that is
      // triggering this callback.
      if (renderTask === this.renderTask) {
        this.renderTask = null;
        if (this.enableOptimizedPartialRendering) {
          this.recordedBBoxes ??= renderTask.recordedBBoxes;
        }
        if (this.imagesRightClickMinSize !== -1) {
          this.imageCoordinates ??= this.pdfPage.imageCoordinates;
        }
      }
    }
    this.renderingState = RenderingStates.FINISHED;

    onFinish(renderTask);

    if (error) {
      throw error;
    }
  }

  cancelRendering({ cancelExtraDelay = 0 } = {}): void {
    if (this.renderTask) {
      this.renderTask.cancel(cancelExtraDelay);
      this.renderTask = null;
    }
    this.resume = null;
  }

  dispatchPageRender(): void {
    this.eventBus.dispatch("pagerender", {
      source: this,
      pageNumber: this.id,
    });
  }

  dispatchPageRendered(cssTransform: boolean, isDetailView: boolean): void {
    this.eventBus.dispatch("pagerendered", {
      source: this,
      pageNumber: this.id,
      cssTransform,
      isDetailView,
      timestamp: performance.now(),
      error: this.#renderError,
    });
  }
}

export { BasePDFPageView };
