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

import { ScrollMode, SpreadMode } from "./ui_utils.js";
import { PDFViewer } from "./pdf_viewer.js";

class PDFSinglePageViewer extends PDFViewer {
  override _resetView(): void {
    super._resetView();
    (this as any)._scrollMode = ScrollMode.PAGE;
    (this as any)._spreadMode = SpreadMode.NONE;
  }

  set scrollMode(_mode: number) {}

  override _updateScrollMode(): void {}

  set spreadMode(_mode: number) {}

  override _updateSpreadMode(): void {}
}

export { PDFSinglePageViewer };
