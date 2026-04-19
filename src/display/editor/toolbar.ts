/* Copyright 2023 Mozilla Foundation
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



import { noContextMenu, stopEvent } from "../display_utils.js";

class EditorToolbar {
  #toolbar: any = null;

  #colorPicker: any = null;

  #editor: any;

  #buttons: any = null;

  #altText: any = null;

  #comment: any = null;

  #commentButtonDivider: any = null;

  #signatureDescriptionButton: any = null;

  static #l10nRemove: any = null;

  constructor(editor: any) {
    this.#editor = editor;

    EditorToolbar.#l10nRemove ||= Object.freeze({
      freetext: "pdfjs-editor-remove-freetext-button",
      highlight: "pdfjs-editor-remove-highlight-button",
      ink: "pdfjs-editor-remove-ink-button",
      stamp: "pdfjs-editor-remove-stamp-button",
      signature: "pdfjs-editor-remove-signature-button",
    });
  }

  render() {
    const editToolbar = (this.#toolbar = document.createElement("div"));
    editToolbar.classList.add("editToolbar", "hidden");
    editToolbar.setAttribute("role", "toolbar");

    const signal = this.#editor._uiManager._signal;
    if (signal instanceof AbortSignal && !signal.aborted) {
      editToolbar.addEventListener("contextmenu", noContextMenu, { signal });
      editToolbar.addEventListener("pointerdown", EditorToolbar.#pointerDown, {
        signal,
      });
    }

    const buttons = (this.#buttons = document.createElement("div"));
    buttons.className = "buttons";
    editToolbar.append(buttons);

    const position = this.#editor.toolbarPosition;
    if (position) {
      const { style } = editToolbar;
      const x =
        this.#editor._uiManager.direction === "ltr"
          ? 1 - position[0]
          : position[0];
      style.insetInlineEnd = `${100 * x}%`;
      style.top = `calc(${
        100 * position[1]
      }% + var(--editor-toolbar-vert-offset))`;
    }

    return editToolbar;
  }

  get div() {
    return this.#toolbar;
  }

  static #pointerDown(e: any) {
    e.stopPropagation();
  }

  #focusIn(e: any) {
    this.#editor._focusEventsAllowed = false;
    stopEvent(e);
  }

  #focusOut(e: any) {
    this.#editor._focusEventsAllowed = true;
    stopEvent(e);
  }

  #addListenersToElement(element: any) {
    // If we're clicking on a button with the keyboard or with
    // the mouse, we don't want to trigger any focus events on
    // the editor.
    const signal = this.#editor._uiManager._signal;
    if (!(signal instanceof AbortSignal) || signal.aborted) {
      return false;
    }
    element.addEventListener("focusin", this.#focusIn.bind(this), {
      capture: true,
      signal,
    });
    element.addEventListener("focusout", this.#focusOut.bind(this), {
      capture: true,
      signal,
    });
    element.addEventListener("contextmenu", noContextMenu, { signal });
    return true;
  }

  hide() {
    this.#toolbar.classList.add("hidden");
    this.#colorPicker?.hideDropdown();
  }

  show() {
    this.#toolbar.classList.remove("hidden");
    this.#altText?.shown();
    this.#comment?.shown();
  }

  addDeleteButton() {
    const { editorType, _uiManager } = this.#editor;

    const button = document.createElement("button");
    button.classList.add("basic", "deleteButton");
    button.tabIndex = 0;
    button.setAttribute("data-l10n-id", EditorToolbar.#l10nRemove[editorType]);
    if (this.#addListenersToElement(button)) {
      button.addEventListener(
        "click",
        e => {
          _uiManager.delete();
        },
        { signal: _uiManager._signal }
      );
    }
    this.#buttons.append(button);
  }

  get #divider() {
    const divider = document.createElement("div");
    divider.className = "divider";
    return divider;
  }

  async addAltText(altText: any) {
    const button = await altText.render();
    this.#addListenersToElement(button);
    this.#buttons.append(button, this.#divider);
    this.#altText = altText;
  }

  addComment(comment: any, beforeElement: any = null) {
    if (this.#comment) {
      return;
    }
    const button = comment.renderForToolbar();
    if (!button) {
      return;
    }
    this.#addListenersToElement(button);
    const divider = (this.#commentButtonDivider = this.#divider);
    if (!beforeElement) {
      this.#buttons.append(button, divider);
    } else {
      this.#buttons.insertBefore(button, beforeElement);
      this.#buttons.insertBefore(divider, beforeElement);
    }
    this.#comment = comment;
    comment.toolbar = this;
  }

  addColorPicker(colorPicker: any) {
    if (this.#colorPicker) {
      return;
    }
    this.#colorPicker = colorPicker;
    const button = colorPicker.renderButton();
    this.#addListenersToElement(button);
    this.#buttons.append(button, this.#divider);
  }

  async addEditSignatureButton(signatureManager: any) {
    const button = (this.#signatureDescriptionButton =
      await signatureManager.renderEditButton(this.#editor));
    this.#addListenersToElement(button);
    this.#buttons.append(button, this.#divider);
  }

  removeButton(name: any) {
    switch (name) {
      case "comment":
        this.#comment?.removeToolbarCommentButton();
        this.#comment = null;
        this.#commentButtonDivider?.remove();
        this.#commentButtonDivider = null;
        break;
    }
  }

  async addButton(name: any, tool: any) {
    switch (name) {
      case "colorPicker":
        if (tool) {
          this.addColorPicker(tool);
        }
        break;
      case "altText":
        if (tool) {
          await this.addAltText(tool);
        }
        break;
      case "editSignature":
        if (tool) {
          await this.addEditSignatureButton(tool);
        }
        break;
      case "delete":
        this.addDeleteButton();
        break;
      case "comment":
        if (tool) {
          this.addComment(tool);
        }
        break;
    }
  }

  async addButtonBefore(name: any, tool: any, beforeSelector: any) {
    if (!tool && name === "comment") {
      return;
    }
    const beforeElement = this.#buttons.querySelector(beforeSelector);
    if (!beforeElement) {
      return;
    }
    if (name === "comment") {
      this.addComment(tool, beforeElement);
    }
  }

  updateEditSignatureButton(description: any) {
    if (this.#signatureDescriptionButton) {
      this.#signatureDescriptionButton.title = description;
    }
  }

  remove() {
    this.#toolbar.remove();
    this.#colorPicker?.destroy();
    this.#colorPicker = null;
  }
}

class FloatingToolbar {
  #buttons: any = null;

  #toolbar: any = null;

  #uiManager: any;

  constructor(uiManager: any) {
    this.#uiManager = uiManager;
  }

  #render() {
    const editToolbar = (this.#toolbar = document.createElement("div"));
    editToolbar.className = "editToolbar";
    editToolbar.setAttribute("role", "toolbar");

    const signal = this.#uiManager._signal;
    if (signal instanceof AbortSignal && !signal.aborted) {
      editToolbar.addEventListener("contextmenu", noContextMenu, {
        signal,
      });
    }

    const buttons = (this.#buttons = document.createElement("div"));
    buttons.className = "buttons";
    editToolbar.append(buttons);

    if (this.#uiManager.hasCommentManager()) {
      this.#makeButton(
        "commentButton",
        `pdfjs-comment-floating-button`,
        "pdfjs-comment-floating-button-label",
        () => {
          this.#uiManager.commentSelection("floating_button");
        }
      );
    }

    this.#makeButton(
      "highlightButton",
      `pdfjs-highlight-floating-button1`,
      "pdfjs-highlight-floating-button-label",
      () => {
        this.#uiManager.highlightSelection("floating_button");
      }
    );

    return editToolbar;
  }

  #getLastPoint(boxes: any, isLTR: any) {
    let lastY = 0;
    let lastX = 0;
    for (const box of boxes) {
      const y = box.y + box.height;
      if (y < lastY) {
        continue;
      }
      const x = box.x + (isLTR ? box.width : 0);
      if (y > lastY) {
        lastX = x;
        lastY = y;
        continue;
      }
      if (isLTR) {
        if (x > lastX) {
          lastX = x;
        }
      } else if (x < lastX) {
        lastX = x;
      }
    }
    return [isLTR ? 1 - lastX : lastX, lastY];
  }

  show(parent: any, boxes: any, isLTR: any) {
    const [x, y] = this.#getLastPoint(boxes, isLTR);
    const { style } = (this.#toolbar ||= this.#render());
    parent.append(this.#toolbar);
    style.insetInlineEnd = `${100 * x}%`;
    style.top = `calc(${100 * y}% + var(--editor-toolbar-vert-offset))`;
  }

  hide() {
    this.#toolbar.remove();
  }

  #makeButton(buttonClass: any, l10nId: any, labelL10nId: any, clickHandler: any) {
    const button = document.createElement("button");
    button.classList.add("basic", buttonClass);
    button.tabIndex = 0;
    button.setAttribute("data-l10n-id", l10nId);
    const span = document.createElement("span");
    button.append(span);
    span.className = "visuallyHidden";
    span.setAttribute("data-l10n-id", labelL10nId);
    const signal = this.#uiManager._signal;
    if (signal instanceof AbortSignal && !signal.aborted) {
      button.addEventListener("contextmenu", noContextMenu, { signal });
      button.addEventListener("click", clickHandler, { signal });
    }
    this.#buttons.append(button);
  }
}

export { EditorToolbar, FloatingToolbar };
