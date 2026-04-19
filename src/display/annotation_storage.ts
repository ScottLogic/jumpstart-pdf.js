/* Copyright 2020 Mozilla Foundation
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

import { makeMap, shadow, unreachable } from "../shared/util.js";
import { AnnotationEditor } from "./editor/editor.js";
import { MurmurHash3_64 } from "../shared/murmurhash3.js";

const SerializableEmpty = Object.freeze({
  map: null,
  hash: "",
  transfer: undefined,
});

/**
 * Key/value storage for annotation data in forms.
 */
class AnnotationStorage {
  #modified = false;

  #modifiedIds: { ids: Set<string>; hash: string } | null = null;

  #editorsMap: Map<string, AnnotationEditor> | null = null;

  #storage = new Map<string, Record<string, unknown> | AnnotationEditor>();

  // Callbacks to signal when the modification state is set or reset.
  // This is used by the viewer to only bind on `beforeunload` if forms
  // are actually edited to prevent doing so unconditionally since that
  // can have undesirable effects.
  onSetModified: (() => void) | null = null;

  onResetModified: (() => void) | null = null;

  onAnnotationEditor: ((type: string | null) => void) | null = null;

  constructor() {
    if (typeof PDFJSDev === "undefined" || PDFJSDev.test("TESTING")) {
      // For testing purposes.
      Object.defineProperty(this, "_setValues", {
        value: (obj: Record<string, unknown>) => {
          for (const [key, val] of Object.entries(obj)) {
            this.setValue(key, val as Record<string, unknown>);
          }
        },
      });
    }
  }

  /**
   * Get the value for a given key if it exists, or return the default value.
   * @param {string} key
   * @param {Object} defaultValue
   * @returns {Object}
   */
  getValue(key: string, defaultValue: Record<string, unknown>): Record<string, unknown> {
    const value = this.#storage.get(key);
    if (value === undefined) {
      return defaultValue;
    }

    return Object.assign(defaultValue, value);
  }

  /**
   * Get the value for a given key.
   * @param {string} key
   * @returns {Object}
   */
  getRawValue(key: string) {
    return this.#storage.get(key);
  }

  /**
   * Remove a value from the storage.
   * @param {string} key
   */
  remove(key: string) {
    const storedValue = this.#storage.get(key);
    if (storedValue === undefined) {
      return;
    }
    if (storedValue instanceof AnnotationEditor) {
      this.#editorsMap?.delete((storedValue as any).annotationElementId);
    }
    this.#storage.delete(key);

    if (this.#storage.size === 0) {
      this.resetModified();
    }

    if ([...this.#storage.values()].some(v => v instanceof AnnotationEditor)) {
      return;
    }
    this.onAnnotationEditor?.(null);
  }

  /**
   * Set the value for a given key
   * @param {string} key
   * @param {Object} value
   */
  setValue(key: string, value: Record<string, unknown> | AnnotationEditor) {
    const obj = this.#storage.get(key);
    let modified = false;
    if (obj !== undefined) {
      const objRecord = obj as Record<string, unknown>;
      for (const [entry, val] of Object.entries(value as Record<string, unknown>)) {
        if (objRecord[entry] !== val) {
          modified = true;
          objRecord[entry] = val;
        }
      }
    } else {
      modified = true;
      this.#storage.set(key, value);
    }
    if (modified) {
      this.#setModified();
    }

    if (value instanceof AnnotationEditor) {
      (this.#editorsMap ||= new Map()).set((value as any).annotationElementId, value);
      this.onAnnotationEditor?.((value.constructor as any)._type);
    }
  }

  /**
   * Check if the storage contains the given key.
   * @param {string} key
   * @returns {boolean}
   */
  has(key: string) {
    return this.#storage.has(key);
  }

  get size() {
    return this.#storage.size;
  }

  #setModified() {
    if (!this.#modified) {
      this.#modified = true;
      this.onSetModified?.();
    }
  }

  resetModified() {
    if (this.#modified) {
      this.#modified = false;
      this.onResetModified?.();
    }
  }

  /**
   * @returns {PrintAnnotationStorage}
   */
  get print(): PrintAnnotationStorage {
    return new PrintAnnotationStorage(this);
  }

  /**
   * PLEASE NOTE: Only intended for usage within the API itself.
   * @ignore
   */
  get serializable() {
    if (this.#storage.size === 0) {
      return SerializableEmpty;
    }
    const map = new Map<string, Record<string, unknown>>(),
      hash = new MurmurHash3_64(),
      transfer: unknown[] = [];
    const context = Object.create(null);
    let hasBitmap = false;

    for (const [key, val] of this.#storage) {
      const serialized = (
        val instanceof AnnotationEditor
          ? val.serialize(/* isForCopying = */ false, context)
          : val
      ) as Record<string, unknown> | null | undefined;
      const valRecord = val as Record<string, unknown>;
      if (valRecord.page) {
        valRecord.pageIndex = (valRecord.page as Record<string, unknown>)._pageIndex;
        delete valRecord.page;
      }
      if (serialized) {
        map.set(key, serialized);

        hash.update(`${key}:${JSON.stringify(serialized)}`);
        hasBitmap ||= !!serialized.bitmap;
      }
    }

    if (hasBitmap) {
      // We must transfer the bitmap data separately, since it can be changed
      // during serialization with SVG images.
      for (const value of map.values()) {
        if (value.bitmap) {
          transfer.push(value.bitmap);
        }
      }
    }

    return map.size > 0
      ? { map, hash: hash.hexdigest(), transfer }
      : SerializableEmpty;
  }

  get editorStats() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let stats: any = null;
    const typeToEditor = new Map<unknown, any>();
    let numberOfEditedComments = 0;
    let numberOfDeletedComments = 0;
    for (const value of this.#storage.values()) {
      if (!(value instanceof AnnotationEditor)) {
        const popup = (value as Record<string, any>).popup;
        if (popup) {
          if (popup.deleted) {
            numberOfDeletedComments += 1;
          } else {
            numberOfEditedComments += 1;
          }
        }
        continue;
      }
      if ((value as any).isCommentDeleted) {
        numberOfDeletedComments += 1;
      } else if ((value as any).hasEditedComment) {
        numberOfEditedComments += 1;
      }
      const editorStats = (value as any).telemetryFinalData;
      if (!editorStats) {
        continue;
      }
      const { type } = editorStats;
      if (!typeToEditor.has(type)) {
        typeToEditor.set(type, Object.getPrototypeOf(value).constructor);
      }
      stats ||= Object.create(null);
      const map = (stats[type as string] ||= new Map());
      for (const [key, val] of Object.entries(editorStats)) {
        if (key === "type") {
          continue;
        }
        const counters = map.getOrInsertComputed(key, makeMap);
        counters.set(val, (counters.get(val) ?? 0) + 1);
      }
    }
    if (numberOfDeletedComments > 0 || numberOfEditedComments > 0) {
      stats ||= Object.create(null);
      stats.comments = {
        deleted: numberOfDeletedComments,
        edited: numberOfEditedComments,
      };
    }
    if (!stats) {
      return null;
    }
    for (const [type, editor] of typeToEditor) {
      stats[type as string] = editor.computeTelemetryFinalData(stats[type as string]);
    }
    return stats;
  }

  resetModifiedIds() {
    this.#modifiedIds = null;
  }

  updateEditor(annotationId: string, data: Record<string, unknown>) {
    const value = this.#editorsMap?.get(annotationId);
    if (value) {
      value.updateFromAnnotationLayer(data as any);
      return true;
    }
    return false;
  }

  getEditor(annotationId: string) {
    return this.#editorsMap?.get(annotationId) || null;
  }

  /**
   * @returns {{ids: Set<string>, hash: string}}
   */
  get modifiedIds() {
    if (this.#modifiedIds) {
      return this.#modifiedIds;
    }
    const ids = [];
    if (this.#editorsMap) {
      for (const value of this.#editorsMap.values()) {
        if (!value.serialize()) {
          continue;
        }
        ids.push((value as any).annotationElementId);
      }
    }
    return (this.#modifiedIds = {
      ids: new Set(ids),
      hash: ids.join(","),
    });
  }

  [Symbol.iterator]() {
    return this.#storage.entries();
  }
}

/**
 * A special `AnnotationStorage` for use during printing, where the serializable
 * data is *frozen* upon initialization, to prevent scripting from modifying its
 * contents. (Necessary since printing is triggered synchronously in browsers.)
 */
type SerializableResult =
  | typeof SerializableEmpty
  | { map: Map<string, Record<string, unknown>>; hash: string; transfer: unknown[] };

class PrintAnnotationStorage extends AnnotationStorage {
  #serializable: SerializableResult = SerializableEmpty;

  constructor(parent: AnnotationStorage) {
    super();

    const { serializable } = parent;
    if (serializable === SerializableEmpty) {
      return;
    }
    const { map, hash, transfer } = serializable;
    // Create a *copy* of the data, since Objects are passed by reference in JS.
    const clone = structuredClone(map, transfer ? { transfer: transfer as Transferable[] } : undefined);
    // The `PrintAnnotationStorage` instance is re-used for all pages,
    // hence we cannot transfer the data since that breaks printing.
    this.#serializable = { map: clone as Map<string, Record<string, unknown>>, hash, transfer: [] };
  }

  /**
   * @returns {PrintAnnotationStorage}
   */

  get print(): PrintAnnotationStorage {
    return unreachable("Should not call PrintAnnotationStorage.print");
  }

  /**
   * PLEASE NOTE: Only intended for usage within the API itself.
   * @ignore
   */
  get serializable() {
    return this.#serializable;
  }

  get modifiedIds() {
    return shadow(this, "modifiedIds", {
      ids: new Set(),
      hash: "",
    });
  }
}

export { AnnotationStorage, PrintAnnotationStorage, SerializableEmpty };
