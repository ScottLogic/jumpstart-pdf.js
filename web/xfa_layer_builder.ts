/* Copyright 2021 Mozilla Foundation
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

import { XfaLayer } from "pdfjs-lib";

class XfaLayerBuilder {
  pdfPage: any;
  annotationStorage: any;
  linkService: any;
  xfaHtml: any;
  div: HTMLDivElement | null;
  _cancelled: boolean;

  constructor({
    pdfPage,
    annotationStorage = null,
    linkService,
    xfaHtml = null,
  }: {
    pdfPage: any;
    annotationStorage?: any;
    linkService: any;
    xfaHtml?: any;
  }) {
    this.pdfPage = pdfPage;
    this.annotationStorage = annotationStorage;
    this.linkService = linkService;
    this.xfaHtml = xfaHtml;

    this.div = null;
    this._cancelled = false;
  }

  async render({ viewport, intent = "display" }: { viewport: any; intent?: string }): Promise<any> {
    if (intent === "print") {
      const parameters = {
        viewport: viewport.clone({ dontFlip: true }),
        div: this.div,
        xfaHtml: this.xfaHtml,
        annotationStorage: this.annotationStorage,
        linkService: this.linkService,
        intent,
      };

      // Create an xfa layer div and render the form
      this.div = document.createElement("div");
      parameters.div = this.div;

      return XfaLayer.render(parameters);
    }

    // intent === "display"
    const xfaHtml = await this.pdfPage.getXfa();
    if (this._cancelled || !xfaHtml) {
      return { textDivs: [] };
    }

    const parameters = {
      viewport: viewport.clone({ dontFlip: true }),
      div: this.div,
      xfaHtml,
      annotationStorage: this.annotationStorage,
      linkService: this.linkService,
      intent,
    };

    if (this.div) {
      return XfaLayer.update(parameters);
    }
    // Create an xfa layer div and render the form
    this.div = document.createElement("div");
    parameters.div = this.div;

    return XfaLayer.render(parameters);
  }

  cancel(): void {
    this._cancelled = true;
  }

  hide(): void {
    if (!this.div) {
      return;
    }
    this.div.hidden = true;
  }
}

export { XfaLayerBuilder };
