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

import { normalizeUnicode, stopEvent, TextLayer } from "pdfjs-lib";
import { removeNullCharacters } from "./ui_utils.js";

class TextLayerBuilder {
  #abortSignal: AbortSignal | null = null;
  #enablePermissions: boolean = false;
  #onAppend: ((div: HTMLDivElement) => void) | null = null;
  #renderingDone: boolean = false;
  #textLayer: any = null;

  static #textLayers: Map<HTMLDivElement, HTMLDivElement> = new Map();
  static #selectionChangeAbortController: AbortController | null = null;

  pdfPage: any;
  highlighter: any;
  accessibilityManager: any;
  div: HTMLDivElement;

  constructor({
    pdfPage,
    highlighter = null,
    accessibilityManager = null,
    enablePermissions = false,
    onAppend = null,
    abortSignal = null,
  }: {
    pdfPage: any;
    highlighter?: any;
    accessibilityManager?: any;
    enablePermissions?: boolean;
    onAppend?: ((div: HTMLDivElement) => void) | null;
    abortSignal?: AbortSignal | null;
  }) {
    this.pdfPage = pdfPage;
    this.highlighter = highlighter;
    this.accessibilityManager = accessibilityManager;
    this.#enablePermissions = enablePermissions === true;
    this.#onAppend = onAppend;
    this.#abortSignal = abortSignal;

    this.div = document.createElement("div");
    this.div.tabIndex = 0;
    this.div.className = "textLayer";
  }

  async render({ viewport, images, textContentParams = null }: {
    viewport: any;
    images: any;
    textContentParams?: any;
  }): Promise<void> {
    if (this.#renderingDone && this.#textLayer) {
      this.#textLayer.update({
        viewport,
        onBefore: this.hide.bind(this),
      });
      this.show();
      return;
    }

    this.cancel();
    this.#textLayer = new TextLayer({
      textContentSource: this.pdfPage.streamTextContent(
        textContentParams || {
          includeMarkedContent: true,
          disableNormalization: true,
        }
      ),
      images,
      container: this.div,
      viewport,
    });

    const { textDivs, textContentItemsStr } = this.#textLayer;
    this.highlighter?.setTextMapping(textDivs, textContentItemsStr);
    this.accessibilityManager?.setTextMapping(textDivs);

    await this.#textLayer.render();
    this.#renderingDone = true;

    const endOfContent = document.createElement("div");
    endOfContent.className = "endOfContent";
    this.div.append(endOfContent);

    this.#bindMouse(endOfContent);
    // Ensure that the textLayer is appended to the DOM *before* handling
    // e.g. a pending search operation.
    this.#onAppend?.(this.div);
    this.highlighter?.enable();
    this.accessibilityManager?.enable();
  }

  hide(): void {
    if (!this.div.hidden && this.#renderingDone) {
      // We turn off the highlighter in order to avoid to scroll into view an
      // element of the text layer which could be hidden.
      this.highlighter?.disable();
      this.div.hidden = true;
    }
  }

  show(): void {
    if (this.div.hidden && this.#renderingDone) {
      this.div.hidden = false;
      this.highlighter?.enable();
    }
  }

  /**
   * Cancel rendering of the text layer.
   */
  cancel(): void {
    this.#textLayer?.cancel();
    this.#textLayer = null;

    this.highlighter?.disable();
    this.accessibilityManager?.disable();
    TextLayerBuilder.#removeGlobalSelectionListener(this.div);
  }

  /**
   * Improves text selection by adding an additional div where the mouse was
   * clicked. This reduces flickering of the content if the mouse is slowly
   * dragged up or down.
   */
  #bindMouse(end: HTMLDivElement): void {
    const { div } = this;
    const abortSignal = this.#abortSignal;
    const opts: AddEventListenerOptions | undefined = abortSignal ? { signal: abortSignal } : undefined;

    div.addEventListener(
      "mousedown",
      () => {
        div.classList.add("selecting");
      },
      opts
    );

    div.addEventListener(
      "copy",
      event => {
        if (!this.#enablePermissions) {
          const selection = document.getSelection();
          (event as ClipboardEvent).clipboardData!.setData(
            "text/plain",
            removeNullCharacters(normalizeUnicode(selection!.toString()))
          );
        }
        stopEvent(event);
      },
      opts
    );

    TextLayerBuilder.#textLayers.set(div, end);
    TextLayerBuilder.#enableGlobalSelectionListener(abortSignal);
  }

  static #removeGlobalSelectionListener(textLayerDiv: HTMLDivElement): void {
    this.#textLayers.delete(textLayerDiv);

    if (this.#textLayers.size === 0) {
      this.#selectionChangeAbortController?.abort();
      this.#selectionChangeAbortController = null;
    }
  }

  static #enableGlobalSelectionListener(globalAbortSignal: AbortSignal | null): void {
    if (this.#selectionChangeAbortController) {
      // document-level event listeners already installed
      return;
    }
    this.#selectionChangeAbortController = new AbortController();
    const signal = globalAbortSignal
      ? AbortSignal.any([
          this.#selectionChangeAbortController.signal,
          globalAbortSignal,
        ])
      : this.#selectionChangeAbortController.signal;

    const reset = (end: HTMLDivElement, textLayer: HTMLDivElement) => {
      if (typeof PDFJSDev === "undefined" || !PDFJSDev!.test("MOZCENTRAL")) {
        textLayer.append(end);
        end.style.width = "";
        end.style.height = "";
      }
      textLayer.classList.remove("selecting");
    };

    let isPointerDown = false;
    document.addEventListener(
      "pointerdown",
      () => {
        isPointerDown = true;
      },
      { signal }
    );
    document.addEventListener(
      "pointerup",
      () => {
        isPointerDown = false;
        this.#textLayers.forEach(reset);
      },
      { signal }
    );
    window.addEventListener(
      "blur",
      () => {
        isPointerDown = false;
        this.#textLayers.forEach(reset);
      },
      { signal }
    );
    document.addEventListener(
      "keyup",
      () => {
        if (!isPointerDown) {
          this.#textLayers.forEach(reset);
        }
      },
      { signal }
    );

    let isFirefox: boolean | undefined, prevRange: Range | undefined;

    document.addEventListener(
      "selectionchange",
      () => {
        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0) {
          this.#textLayers.forEach(reset);
          return;
        }

        // Even though the spec says that .rangeCount should be 0 or 1, Firefox
        // creates multiple ranges when selecting across multiple pages.
        // Make sure to collect all the .textLayer elements where the selection
        // is happening.
        const activeTextLayers = new Set<HTMLDivElement>();
        for (let i = 0; i < selection.rangeCount; i++) {
          const range = selection.getRangeAt(i);
          for (const textLayerDiv of this.#textLayers.keys()) {
            if (
              !activeTextLayers.has(textLayerDiv) &&
              range.intersectsNode(textLayerDiv)
            ) {
              activeTextLayers.add(textLayerDiv);
            }
          }
        }

        for (const [textLayerDiv, endDiv] of this.#textLayers) {
          if (activeTextLayers.has(textLayerDiv)) {
            textLayerDiv.classList.add("selecting");
          } else {
            reset(endDiv, textLayerDiv);
          }
        }

        if (typeof PDFJSDev !== "undefined" && PDFJSDev!.test("MOZCENTRAL")) {
          return;
        }
        if (typeof PDFJSDev === "undefined" || !PDFJSDev!.test("CHROME")) {
          isFirefox ??=
            getComputedStyle(
              this.#textLayers.values().next().value!
            ).getPropertyValue("-moz-user-select") === "none";

          if (isFirefox) {
            return;
          }
        }
        // In non-Firefox browsers, when hovering over an empty space (thus,
        // on .endOfContent), the selection will expand to cover all the
        // text between the current selection and .endOfContent. By moving
        // .endOfContent to right after (or before, depending on which side
        // of the selection the user is moving), we limit the selection jump
        // to at most cover the enteirety of the <span> where the selection
        // is being modified.
        const range = selection.getRangeAt(0);
        const modifyStart =
          prevRange &&
          (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
            range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
        let anchor: Node = modifyStart ? range.startContainer : range.endContainer;
        if (anchor.nodeType === Node.TEXT_NODE) {
          anchor = anchor.parentNode!;
        }
        if ((anchor as Element).classList?.contains("highlight")) {
          anchor = anchor.parentNode!;
        }
        if (!modifyStart && range.endOffset === 0) {
          do {
            while (!anchor.previousSibling) {
              anchor = anchor.parentNode!;
            }
            anchor = anchor.previousSibling;
          } while (!anchor.childNodes.length);
        }

        const parentTextLayer = (anchor as Element).parentElement?.closest(".textLayer") as HTMLDivElement | null;
        const endDiv = parentTextLayer ? this.#textLayers.get(parentTextLayer) : undefined;
        if (endDiv) {
          endDiv.style.width = parentTextLayer!.style.width;
          endDiv.style.height = parentTextLayer!.style.height;
          endDiv.style.userSelect = "text";
          (anchor as Element).parentElement!.insertBefore(
            endDiv,
            modifyStart ? anchor : anchor.nextSibling
          );
        }

        prevRange = range.cloneRange();
      },
      { signal }
    );
  }
}

export { TextLayerBuilder };
