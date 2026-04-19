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

import { makeArr } from "../shared/util.js";
import { MathClamp } from "../shared/math_clamp.js";

/**
 * Maps between page IDs and page numbers, allowing bidirectional conversion
 * between the two representations. This is useful when the page numbering
 * in the PDF document doesn't match the default sequential ordering.
 *
 * When #pageNumberToId is null the mapping is the identity (page N has ID N).
 */
class PagesMapper {
  /**
   * Maps page positions (0-indexed) to their page IDs (1-indexed).
   * Null when the mapping is the identity.
   */
  #pageNumberToId: Uint32Array | null = null;

  /**
   * Previous page number for each position, used to track what happened to
   * each page after a mutation. Negative values indicate copied pages.
   */
  #prevPageNumbers: Int32Array | null = null;

  #pagesNumber: number = 0;

  /**
   * Clipboard state for copy/paste operations.
   */
  #clipboard: { pageNumbers: Uint32Array; pageIds: Uint32Array } | null = null;

  #savedData: {
    pageNumberToId: Uint32Array;
    pagesNumber: number;
    prevPageNumbers: Int32Array;
  } | null = null;

  get pagesNumber(): number {
    return this.#pagesNumber;
  }

  set pagesNumber(n: number) {
    if (this.#pagesNumber === n) {
      return;
    }
    this.#pagesNumber = n;
    this.#pageNumberToId = null;
    this.#prevPageNumbers = null;
  }

  /**
   * Ensures the identity mapping is initialized.
   * Must be called before any mutation or before reading #pageNumberToId.
   */
  #ensureInit() {
    if (this.#pageNumberToId) {
      return;
    }
    const n = this.#pagesNumber;
    const pageNumberToId = (this.#pageNumberToId = new Uint32Array(n));
    for (let i = 0; i < n; i++) {
      pageNumberToId[i] = i + 1;
    }
    this.#prevPageNumbers = new Int32Array(pageNumberToId);
  }

  /**
   * Builds and returns the inverse map (id to page numbers) from
   * #pageNumberToId.
   * Since a page ID can appear multiple times (after a copy), the value is an
   * array of all page numbers that share that ID.
   * @returns {Map<number, Array<number>>}
   */
  #buildIdToPageNumber(): Map<number, number[]> {
    const idToPageNumber = new Map<number, number[]>();
    const pageNumberToId = this.#pageNumberToId!;
    for (let i = 0, ii = this.#pagesNumber; i < ii; i++) {
      const id = pageNumberToId[i];
      const pageNumbers = idToPageNumber.get(id);
      if (pageNumbers) {
        pageNumbers.push(i + 1);
      } else {
        idToPageNumber.set(id, [i + 1]);
      }
    }
    return idToPageNumber;
  }

  /**
   * Move a set of pages to a new position.
   *
   * @param {Set<number>} selectedPages - Page numbers being moved (1-indexed).
   * @param {number[]} pagesToMove - Ordered list of page numbers to move.
   * @param {number} index - Zero-based insertion index in the page-number list.
   */
  movePages(selectedPages: Set<number>, pagesToMove: number[], index: number): void {
    this.#ensureInit();
    const pageNumberToId = this.#pageNumberToId!;
    const prevIdToPageNumber = this.#buildIdToPageNumber();
    const movedCount = pagesToMove.length;
    const mappedPagesToMove = new Uint32Array(movedCount);
    let removedBeforeTarget = 0;

    for (let i = 0; i < movedCount; i++) {
      const pageIndex = pagesToMove[i] - 1;
      mappedPagesToMove[i] = pageNumberToId[pageIndex];
      if (pageIndex < index) {
        removedBeforeTarget++;
      }
    }

    const pagesNumber = this.#pagesNumber;
    const remainingLen = pagesNumber - movedCount;
    const adjustedTarget = MathClamp(
      index - removedBeforeTarget,
      0,
      remainingLen
    );

    // Compact: keep only non-moved pages.
    for (let i = 0, r = 0; i < pagesNumber; i++) {
      if (!selectedPages.has(i + 1)) {
        pageNumberToId[r++] = pageNumberToId[i];
      }
    }

    // Make room at the target and insert.
    pageNumberToId.copyWithin(
      adjustedTarget + movedCount,
      adjustedTarget,
      remainingLen
    );
    pageNumberToId.set(mappedPagesToMove, adjustedTarget);

    this.#updatePrevPageNumbers(prevIdToPageNumber);

    if (pageNumberToId.every((id, i) => id === i + 1)) {
      this.#pageNumberToId = null;
    }
  }

  /**
   * Deletes a set of pages.
   * @param {Array<number>} pagesToDelete - Page numbers to delete (1-indexed),
   *   unique and sorted ascending.
   */
  deletePages(pagesToDelete: number[]): void {
    this.#ensureInit();
    const pageNumberToId = this.#pageNumberToId!;
    const prevIdToPageNumber = this.#buildIdToPageNumber();

    this.#savedData = {
      pageNumberToId: pageNumberToId.slice(),
      pagesNumber: this.#pagesNumber,
      prevPageNumbers: this.#prevPageNumbers!.slice(),
    };

    const newN = this.#pagesNumber - pagesToDelete.length;
    this.#pagesNumber = newN;
    const newPageNumberToId = (this.#pageNumberToId = new Uint32Array(newN));
    this.#prevPageNumbers = new Int32Array(newN);

    let sourceIndex = 0;
    let destIndex = 0;
    for (const pageNumber of pagesToDelete) {
      const pageIndex = pageNumber - 1;
      if (pageIndex !== sourceIndex) {
        newPageNumberToId.set(
          pageNumberToId.subarray(sourceIndex, pageIndex),
          destIndex
        );
        destIndex += pageIndex - sourceIndex;
      }
      sourceIndex = pageIndex + 1;
    }
    if (sourceIndex < pageNumberToId.length) {
      newPageNumberToId.set(pageNumberToId.subarray(sourceIndex), destIndex);
    }

    this.#updatePrevPageNumbers(prevIdToPageNumber, new Set(pagesToDelete));
  }

  cancelDelete(): void {
    if (this.#savedData) {
      this.#pageNumberToId = this.#savedData.pageNumberToId;
      this.#pagesNumber = this.#savedData.pagesNumber;
      this.#prevPageNumbers = this.#savedData.prevPageNumbers;
      this.#savedData = null;
    }
  }

  cleanSavedData(): void {
    this.#savedData = null;
  }

  /**
   * Records which pages are being copied so that pastePages can insert them.
   * @param {Uint32Array} pagesToCopy - Page numbers to copy (1-indexed).
   */
  copyPages(pagesToCopy: Uint32Array): void {
    this.#ensureInit();
    this.#clipboard = {
      pageNumbers: pagesToCopy,
      pageIds: pagesToCopy.map(n => this.#pageNumberToId![n - 1]),
    };
  }

  cancelCopy(): void {
    this.#clipboard = null;
  }

  /**
   * Inserts the previously copied pages at the given position.
   * @param {number} index - Zero-based insertion index in the page-number list.
   */
  pastePages(index: number): void {
    this.#ensureInit();
    const pageNumberToId = this.#pageNumberToId!;
    const prevIdToPageNumber = this.#buildIdToPageNumber();
    const { pageNumbers: copiedPageNumbers, pageIds: copiedPageIds } =
      this.#clipboard!;

    const newN = this.#pagesNumber + copiedPageNumbers.length;
    this.#pagesNumber = newN;
    const newPageNumberToId = (this.#pageNumberToId = new Uint32Array(newN));
    this.#prevPageNumbers = new Int32Array(newN);

    newPageNumberToId.set(pageNumberToId.subarray(0, index), 0);
    newPageNumberToId.set(copiedPageIds, index);
    newPageNumberToId.set(
      pageNumberToId.subarray(index),
      index + copiedPageNumbers.length
    );

    this.#updatePrevPageNumbers(
      prevIdToPageNumber,
      null,
      index,
      copiedPageNumbers
    );
    this.#clipboard = null;
  }

  /**
   * Recomputes #prevPageNumbers after a mutation, using the pre-mutation
   * id to pageNumbers map to track where each page came from.
   *
   * @param {Map<number, Array<number>>} prevIdToPageNumber - Id to pageNumbers
   *   before the mutation.
   * @param {Set<number>|null} [deletedPageNumbers] - Page numbers that were
   *   deleted (so their old positions are skipped).
   * @param {number} [pasteIndex] - If this is a paste, the zero-based
   *   insertion index; paired with copiedPageNumbers.
   * @param {Uint32Array} [copiedPageNumbers] - Source page numbers of the
   *   pasted pages; paired with pasteIndex.
   */
  #updatePrevPageNumbers(
    prevIdToPageNumber: Map<number, number[]>,
    deletedPageNumbers: Set<number> | null = null,
    pasteIndex: number = -1,
    copiedPageNumbers: Uint32Array | null = null
  ): void {
    const prevPageNumbers = this.#prevPageNumbers!;
    const newPageNumberToId = this.#pageNumberToId!;
    const pasteEnd = pasteIndex + (copiedPageNumbers?.length ?? 0);
    const idsIndices = new Map<number, number>();

    for (let i = 0, ii = this.#pagesNumber; i < ii; i++) {
      if (i >= pasteIndex && i < pasteEnd) {
        // Negative value signals this page is a copy; encodes its source.
        prevPageNumbers[i] = -copiedPageNumbers![i - pasteIndex];
        continue;
      }
      const id = newPageNumberToId[i];
      const oldPositions = prevIdToPageNumber.get(id);
      let j = idsIndices.get(id) || 0;
      if (deletedPageNumbers && oldPositions) {
        while (
          j < oldPositions.length &&
          deletedPageNumbers.has(oldPositions[j])
        ) {
          j++;
        }
      }
      prevPageNumbers[i] = oldPositions?.[j] ?? 0;
      idsIndices.set(id, j + 1);
    }
  }

  /**
   * Checks if the page mappings have been altered from their initial state.
   * @returns {boolean}
   */
  hasBeenAltered(): boolean {
    return this.#pageNumberToId !== null;
  }

  /**
   * Gets the current page mapping suitable for saving.
   * @param {Map<number, Array<number>>} [idToPageNumber]
   * @returns {Array<Object>}
   */
  getPageMappingForSaving(idToPageNumber: Map<number, number[]> | null = null): Array<{ document: null; pageIndices: number[]; includePages: any[] }> {
    idToPageNumber ??= this.#buildIdToPageNumber();
    // idToPageNumber maps used 1-based IDs to 1-based page numbers.
    // For example if the final pdf contains page 3 twice and they are moved at
    // page 1 and 4, then it contains:
    //   pageNumberToId = [3, ., ., 3, ...,]
    //   idToPageNumber = {3: [1, 4], ...}
    // In such a case we need to take a page 3 from the original pdf and take
    // page 3 from a "copy".
    // So we need to pass to the api something like:
    // [ {
    //   document: null // this pdf
    //   includePages: [ 2, ... ], // page 3 is at index 2
    //   pageIndices: [0, ...], // page 3 will be at index 0 in the new pdf
    // }, {
    //   document: null // this pdf
    //   includePages: [ 2, ... ], // page 3 is at index 2
    //   pageIndices: [3, ...], // page 3 will be at index 3 in the new pdf
    // }
    // ]

    let nCopy = 0;
    for (const pageNumbers of idToPageNumber.values()) {
      nCopy = Math.max(nCopy, pageNumbers.length);
    }

    const extractParams = new Array(nCopy);
    for (let i = 0; i < nCopy; i++) {
      extractParams[i] = {
        document: null,
        pageIndices: [],
        includePages: [],
      };
    }

    for (const [id, pageNumbers] of idToPageNumber) {
      for (let i = 0, ii = pageNumbers.length; i < ii; i++) {
        extractParams[i].includePages.push([id - 1, pageNumbers[i] - 1]);
      }
    }

    for (const { includePages, pageIndices } of extractParams) {
      includePages.sort((a: number[], b: number[]) => a[0] - b[0]);
      for (let i = 0, ii = includePages.length; i < ii; i++) {
        pageIndices.push(includePages[i][1]);
        includePages[i] = includePages[i][0];
      }
    }

    return extractParams;
  }

  extractPages(extractedPageNumbers: Iterable<number>): Array<{ document: null; pageIndices: number[]; includePages: number[] }> {
    const sorted = Array.from(extractedPageNumbers).sort(
      (a, b) => a - b
    );
    const usedIds = new Map<number, number[]>();
    for (let i = 0, ii = sorted.length; i < ii; i++) {
      const id = this.getPageId(sorted[i]);
      const usedPageNumbers = (usedIds as any).getOrInsertComputed(id, makeArr) as number[];
      usedPageNumbers.push(i + 1);
    }
    return this.getPageMappingForSaving(usedIds);
  }

  /**
   * Gets the previous page number for a given page number.
   * Negative values indicate a copied page (the absolute value is the source).
   * @param {number} pageNumber
   * @returns {number}
   */
  getPrevPageNumber(pageNumber: number): number {
    return this.#prevPageNumbers?.[pageNumber - 1] ?? 0;
  }

  /**
   * Gets the first page number that currently maps to the given page ID.
   * @param {number} id - The page ID (1-indexed).
   * @returns {number} The page number, or 0 if not found.
   */
  getPageNumber(id: number): number {
    if (!this.#pageNumberToId) {
      return id; // identity mapping
    }
    const pageNumberToId = this.#pageNumberToId;
    for (let i = 0, ii = this.#pagesNumber; i < ii; i++) {
      if (pageNumberToId[i] === id) {
        return i + 1;
      }
    }
    return 0;
  }

  /**
   * Gets the page ID for a given page number.
   * @param {number} pageNumber - The page number (1-indexed).
   * @returns {number} The page ID, or the page number itself if no mapping
   *   exists.
   */
  getPageId(pageNumber: number): number {
    return this.#pageNumberToId?.[pageNumber - 1] ?? pageNumber;
  }

  getMapping(): Uint32Array | undefined {
    return this.#pageNumberToId?.subarray(0, this.pagesNumber);
  }
}

export { PagesMapper };
