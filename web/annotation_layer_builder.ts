/* Copyright 2014 Mozilla Foundation
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
  AnnotationLayer,
  AnnotationType,
  setLayerDimensions,
  Util,
} from "pdfjs-lib";
import { PresentationModeState } from "./ui_utils.js";

class AnnotationLayerBuilder {
  #annotations: any[] | null = null;
  #commentManager: any = null;
  #externalHide: boolean = false;
  #onAppend: ((div: HTMLDivElement) => void) | null = null;
  #eventAbortController: AbortController | null = null;
  #linksInjected: boolean = false;

  pdfPage: any;
  linkService: any;
  downloadManager: any;
  imageResourcesPath: string;
  renderForms: boolean;
  annotationStorage: any;
  enableComment: boolean;
  enableScripting: boolean;
  _hasJSActionsPromise: Promise<boolean>;
  _fieldObjectsPromise: Promise<any>;
  _annotationCanvasMap: any;
  _accessibilityManager: any;
  _annotationEditorUIManager: any;
  annotationLayer: any;
  div: HTMLDivElement | null;
  _cancelled: boolean;
  _eventBus: any;

  constructor({
    pdfPage,
    linkService,
    downloadManager,
    annotationStorage = null,
    imageResourcesPath = "",
    renderForms = true,
    enableComment = false,
    commentManager = null,
    enableScripting = false,
    hasJSActionsPromise = null,
    fieldObjectsPromise = null,
    annotationCanvasMap = null,
    accessibilityManager = null,
    annotationEditorUIManager = null,
    onAppend = null,
  }: {
    pdfPage: any;
    linkService: any;
    downloadManager?: any;
    annotationStorage?: any;
    imageResourcesPath?: string;
    renderForms?: boolean;
    enableComment?: boolean;
    commentManager?: any;
    enableScripting?: boolean;
    hasJSActionsPromise?: Promise<boolean> | null;
    fieldObjectsPromise?: Promise<any> | null;
    annotationCanvasMap?: any;
    accessibilityManager?: any;
    annotationEditorUIManager?: any;
    onAppend?: ((div: HTMLDivElement) => void) | null;
  }) {
    this.pdfPage = pdfPage;
    this.linkService = linkService;
    this.downloadManager = downloadManager;
    this.imageResourcesPath = imageResourcesPath;
    this.renderForms = renderForms;
    this.annotationStorage = annotationStorage;
    this.enableComment = enableComment;
    this.#commentManager = commentManager;
    this.enableScripting = enableScripting;
    this._hasJSActionsPromise = hasJSActionsPromise || Promise.resolve(false);
    this._fieldObjectsPromise = fieldObjectsPromise || Promise.resolve(null);
    this._annotationCanvasMap = annotationCanvasMap;
    this._accessibilityManager = accessibilityManager;
    this._annotationEditorUIManager = annotationEditorUIManager;
    this.#onAppend = onAppend;

    this.annotationLayer = null;
    this.div = null;
    this._cancelled = false;
    this._eventBus = linkService.eventBus;
  }

  async render({ viewport, intent = "display", structTreeLayer = null }: {
    viewport: any;
    intent?: string;
    structTreeLayer?: any;
  }): Promise<void> {
    if (this.div) {
      if (this._cancelled || !this.annotationLayer) {
        return;
      }
      // If an annotationLayer already exists, refresh its children's
      // transformation matrices.
      this.annotationLayer.update({
        viewport: viewport.clone({ dontFlip: true }),
      });
      return;
    }

    const [annotations, hasJSActions, fieldObjects] = await Promise.all([
      this.pdfPage.getAnnotations({ intent }),
      this._hasJSActionsPromise,
      this._fieldObjectsPromise,
    ]);
    if (this._cancelled) {
      return;
    }

    // Create an annotation layer div and render the annotations
    // if there is at least one annotation.
    const div = (this.div = document.createElement("div"));
    div.className = "annotationLayer";
    this.#onAppend?.(div);
    this.#initAnnotationLayer(viewport, structTreeLayer);

    if (annotations.length === 0) {
      this.#annotations = annotations;
      setLayerDimensions(this.div, viewport);
      return;
    }

    await this.annotationLayer.render({
      annotations,
      imageResourcesPath: this.imageResourcesPath,
      renderForms: this.renderForms,
      downloadManager: this.downloadManager,
      enableComment: this.enableComment,
      enableScripting: this.enableScripting,
      hasJSActions,
      fieldObjects,
    });

    this.#annotations = annotations;

    // Ensure that interactive form elements in the annotationLayer are
    // disabled while PresentationMode is active (see issue 12232).
    if (this.linkService.isInPresentationMode) {
      this.#updatePresentationModeState(PresentationModeState.FULLSCREEN);
    }
    if (!this.#eventAbortController) {
      this.#eventAbortController = new AbortController();

      this._eventBus?._on(
        "presentationmodechanged",
        (evt: unknown) => {
          this.#updatePresentationModeState((evt as { state: number }).state);
        },
        { signal: this.#eventAbortController.signal }
      );
    }
  }

  #initAnnotationLayer(viewport: any, structTreeLayer: any): void {
    this.annotationLayer = new AnnotationLayer({
      div: this.div,
      accessibilityManager: this._accessibilityManager,
      annotationCanvasMap: this._annotationCanvasMap,
      annotationEditorUIManager: this._annotationEditorUIManager,
      annotationStorage: this.annotationStorage,
      page: this.pdfPage,
      viewport: viewport.clone({ dontFlip: true }),
      structTreeLayer,
      commentManager: this.#commentManager,
      linkService: this.linkService,
    });
  }

  cancel(): void {
    this._cancelled = true;

    this.#eventAbortController?.abort();
    this.#eventAbortController = null;
  }

  hide(internal = false): void {
    this.#externalHide = !internal;
    if (!this.div) {
      return;
    }
    this.div.hidden = true;
  }

  hasEditableAnnotations(): boolean {
    return !!this.annotationLayer?.hasEditableAnnotations();
  }

  async injectLinkAnnotations(inferredLinks: any[]): Promise<void> {
    if (this.#annotations === null) {
      throw new Error(
        "`render` method must be called before `injectLinkAnnotations`."
      );
    }
    if (this._cancelled || this.#linksInjected) {
      return;
    }
    this.#linksInjected = true;

    const newLinks = this.#annotations.length
      ? this.#checkInferredLinks(inferredLinks)
      : inferredLinks;

    if (!newLinks.length) {
      return;
    }

    await this.annotationLayer.addLinkAnnotations(newLinks);
    // Don't show the annotation layer if it was explicitly hidden previously.
    if (!this.#externalHide) {
      this.div!.hidden = false;
    }
  }

  #updatePresentationModeState(state: number): void {
    if (!this.div) {
      return;
    }
    let disableFormElements = false;

    switch (state) {
      case PresentationModeState.FULLSCREEN:
        disableFormElements = true;
        break;
      case PresentationModeState.NORMAL:
        break;
      default:
        return;
    }
    for (const section of this.div.childNodes) {
      const el = section as HTMLElement;
      if (el.hasAttribute("data-internal-link")) {
        continue;
      }
      el.inert = disableFormElements;
    }
  }

  #checkInferredLinks(inferredLinks: any[]): any[] {
    function annotationRects(annot: any): number[][] {
      if (!annot.quadPoints) {
        return [annot.rect];
      }
      const rects: number[][] = [];
      for (let i = 2, ii = annot.quadPoints.length; i < ii; i += 8) {
        const trX = annot.quadPoints[i];
        const trY = annot.quadPoints[i + 1];
        const blX = annot.quadPoints[i + 2];
        const blY = annot.quadPoints[i + 3];
        rects.push([blX, blY, trX, trY]);
      }
      return rects;
    }

    function intersectAnnotations(annot1: any, annot2: any): number[][] {
      const intersections: number[][] = [];
      const annot1Rects = annotationRects(annot1);
      const annot2Rects = annotationRects(annot2);
      for (const rect1 of annot1Rects) {
        for (const rect2 of annot2Rects) {
          const intersection = Util.intersect(rect1, rect2);
          if (intersection) {
            intersections.push(intersection);
          }
        }
      }
      return intersections;
    }

    function areaRects(rects: number[][]): number {
      let totalArea = 0;
      for (const rect of rects) {
        totalArea += Math.abs((rect[2] - rect[0]) * (rect[3] - rect[1]));
      }
      return totalArea;
    }

    return inferredLinks.filter(link => {
      let linkAreaRects: number | undefined;

      for (const annotation of this.#annotations!) {
        if (
          annotation.annotationType !== AnnotationType.LINK ||
          !annotation.url
        ) {
          continue;
        }
        // TODO: Add a test case to verify that we can find the intersection
        //       between two annotations with quadPoints properly.
        const intersections = intersectAnnotations(annotation, link);

        if (intersections.length === 0) {
          continue;
        }
        linkAreaRects ??= areaRects(annotationRects(link));

        if (
          areaRects(intersections) / linkAreaRects >
          0.5 /* If the overlap is more than 50%. */
        ) {
          return false;
        }
      }
      return true;
    });
  }
}

export { AnnotationLayerBuilder };
