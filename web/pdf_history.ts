/* Copyright 2017 Mozilla Foundation
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

import { isValidRotation, parseQueryString } from "./ui_utils.js";
import { updateUrlHash } from "pdfjs-lib";
import { waitOnEventOrTimeout } from "./event_utils.js";

// Heuristic value used when force-resetting `this._blockHashChange`.
const HASH_CHANGE_TIMEOUT = 1000; // milliseconds
// Heuristic value used when adding the current position to the browser history.
const POSITION_UPDATED_THRESHOLD = 50;
// Heuristic value used when adding a temporary position to the browser history.
const UPDATE_VIEWAREA_TIMEOUT = 1000; // milliseconds

type HistoryDestinationObj = {
  hash?: string;
  page?: number | null;
  rotation?: number;
  dest?: unknown[] | null;
  temporary?: boolean;
  first?: number;
};

type HistoryDestination = HistoryDestinationObj | null;

type ViewPosition = {
  hash: string;
  page: number;
  first: number;
  rotation: number;
  temporary?: boolean;
};

type HistoryState = {
  fingerprint: string;
  uid: number;
  destination: HistoryDestinationObj;
  chromecomState?: unknown;
};

function getCurrentHash(): string {
  return document.location.hash;
}

class PDFHistory {
  #eventAbortController: AbortController | null = null;

  linkService: any;
  eventBus: any;
  _initialized: boolean;
  _fingerprint: string;
  _updateUrl: boolean = false;
  _popStateInProgress: boolean = false;
  _blockHashChange: number = 0;
  _currentHash: string = "";
  _numPositionUpdates: number = 0;
  _uid: number = 0;
  _maxUid: number = 0;
  _destination: HistoryDestination = null;
  _position: ViewPosition | null = null;
  _isPagesLoaded: boolean = false;
  _updateViewareaTimeout: ReturnType<typeof setTimeout> | null = null;
  _initialBookmark: string | null = null;
  _initialRotation: number | null = null;

  constructor({ linkService, eventBus }: { linkService: any; eventBus: any }) {
    this.linkService = linkService;
    this.eventBus = eventBus;

    this._initialized = false;
    this._fingerprint = "";
    this.reset();

    // Ensure that we don't miss a "pagesinit" event,
    // by registering the listener immediately.
    this.eventBus._on("pagesinit", () => {
      this._isPagesLoaded = false;

      this.eventBus._on(
        "pagesloaded",
        (evt: unknown) => {
          this._isPagesLoaded = !!(evt as { pagesCount: number }).pagesCount;
        },
        { once: true }
      );
    });
  }

  /**
   * Initialize the history for the PDF document, using either the current
   * browser history entry or the document hash, whichever is present.
   * @param {InitializeParameters} params
   */
  initialize({ fingerprint, resetHistory = false, updateUrl = false }: {
    fingerprint: string;
    resetHistory?: boolean;
    updateUrl?: boolean;
  }): void {
    if (!fingerprint || typeof fingerprint !== "string") {
      console.error(
        'PDFHistory.initialize: The "fingerprint" must be a non-empty string.'
      );
      return;
    }
    // Ensure that any old state is always reset upon initialization.
    if (this._initialized) {
      this.reset();
    }
    const reInitialized =
      this._fingerprint !== "" && this._fingerprint !== fingerprint;
    this._fingerprint = fingerprint;
    this._updateUrl = updateUrl === true;

    this._initialized = true;
    this.#bindEvents();
    const state = window.history.state;

    this._popStateInProgress = false;
    this._blockHashChange = 0;
    this._currentHash = getCurrentHash();
    this._numPositionUpdates = 0;

    this._uid = this._maxUid = 0;
    this._destination = null;
    this._position = null;

    if (!this.#isValidState(state, /* checkReload = */ true) || resetHistory) {
      const { hash, page, rotation } = this.#parseCurrentHash(
        /* checkNameddest = */ true
      );

      if (!hash || reInitialized || resetHistory) {
        // Ensure that the browser history is reset on PDF document load.
        this.#pushOrReplaceState(null, /* forceReplace = */ true);
        return;
      }
      // Ensure that the browser history is initialized correctly when
      // the document hash is present on PDF document load.
      this.#pushOrReplaceState(
        { hash, page, rotation },
        /* forceReplace = */ true
      );
      return;
    }

    // The browser history contains a valid entry, ensure that the history is
    // initialized correctly on PDF document load.
    const destination = state.destination;
    this.#updateInternalState(
      destination,
      state.uid,
      /* removeTemporary = */ true
    );

    if (destination.rotation !== undefined) {
      this._initialRotation = destination.rotation;
    }
    if (destination.dest) {
      this._initialBookmark = JSON.stringify(destination.dest);

      // If the history is updated, e.g. through the user changing the hash,
      // before the initial destination has become visible, then we do *not*
      // want to potentially add `this._position` to the browser history.
      this._destination!.page = null;
    } else if (destination.hash) {
      this._initialBookmark = destination.hash;
    } else if (destination.page) {
      // Fallback case; shouldn't be necessary, but better safe than sorry.
      this._initialBookmark = `page=${destination.page}`;
    }
  }

  /**
   * Reset the current `PDFHistory` instance, and consequently prevent any
   * further updates and/or navigation of the browser history.
   */
  reset(): void {
    if (this._initialized) {
      this.#pageHide(); // Simulate a 'pagehide' event when resetting.

      this._initialized = false;
      this.#unbindEvents();
    }
    if (this._updateViewareaTimeout) {
      clearTimeout(this._updateViewareaTimeout);
      this._updateViewareaTimeout = null;
    }
    this._initialBookmark = null;
    this._initialRotation = null;
  }

  /**
   * Push an internal destination to the browser history.
   * @param {PushParameters}
   */
  push({ namedDest = null, explicitDest, pageNumber }: {
    namedDest?: string | null;
    explicitDest: unknown[];
    pageNumber: number | null;
  }): void {
    if (!this._initialized) {
      return;
    }
    if (namedDest && typeof namedDest !== "string") {
      console.error(
        "PDFHistory.push: " +
          `"${namedDest}" is not a valid namedDest parameter.`
      );
      return;
    } else if (!Array.isArray(explicitDest)) {
      console.error(
        "PDFHistory.push: " +
          `"${explicitDest}" is not a valid explicitDest parameter.`
      );
      return;
    } else if (!this.#isValidPage(pageNumber)) {
      // Allow an unset `pageNumber` if and only if the history is still empty;
      // please refer to the `this._destination.page = null;` comment above.
      if (pageNumber !== null || this._destination) {
        console.error(
          "PDFHistory.push: " +
            `"${pageNumber}" is not a valid pageNumber parameter.`
        );
        return;
      }
    }

    const hash = namedDest || JSON.stringify(explicitDest);
    if (!hash) {
      // The hash *should* never be undefined, but if that were to occur,
      // avoid any possible issues by not updating the browser history.
      return;
    }

    let forceReplace = false;
    if (
      this._destination &&
      (isDestHashesEqual(this._destination.hash, hash) ||
        isDestArraysEqual(this._destination.dest, explicitDest))
    ) {
      // When the new destination is identical to `this._destination`, and
      // its `page` is undefined, replace the current browser history entry.
      // NOTE: This can only occur if `this._destination` was set either:
      //  - through the document hash being specified on load.
      //  - through the user changing the hash of the document.
      if (this._destination.page) {
        return;
      }
      forceReplace = true;
    }
    if (this._popStateInProgress && !forceReplace) {
      return;
    }

    this.#pushOrReplaceState(
      {
        dest: explicitDest,
        hash,
        page: pageNumber,
        rotation: this.linkService.rotation,
      },
      forceReplace
    );

    if (!this._popStateInProgress) {
      // Prevent the browser history from updating while the new destination is
      // being scrolled into view, to avoid potentially inconsistent state.
      this._popStateInProgress = true;
      // We defer the resetting of `this._popStateInProgress`, to account for
      // e.g. zooming occurring when the new destination is being navigated to.
      Promise.resolve().then(() => {
        this._popStateInProgress = false;
      });
    }
  }

  /**
   * Push a page to the browser history; generally the `push` method should be
   * used instead.
   * @param {number} pageNumber
   */
  pushPage(pageNumber: number): void {
    if (!this._initialized) {
      return;
    }
    if (!this.#isValidPage(pageNumber)) {
      console.error(
        `PDFHistory.pushPage: "${pageNumber}" is not a valid page number.`
      );
      return;
    }

    if (this._destination?.page === pageNumber) {
      // When the new page is identical to the one in `this._destination`, we
      // don't want to add a potential duplicate entry in the browser history.
      return;
    }
    if (this._popStateInProgress) {
      return;
    }

    this.#pushOrReplaceState({
      // Simulate an internal destination, for `this.#tryPushCurrentPosition`:
      dest: null,
      hash: `page=${pageNumber}`,
      page: pageNumber,
      rotation: this.linkService.rotation,
    });

    if (!this._popStateInProgress) {
      // Prevent the browser history from updating while the new page is
      // being scrolled into view, to avoid potentially inconsistent state.
      this._popStateInProgress = true;
      // We defer the resetting of `this._popStateInProgress`, to account for
      // e.g. zooming occurring when the new page is being navigated to.
      Promise.resolve().then(() => {
        this._popStateInProgress = false;
      });
    }
  }

  /**
   * Push the current position to the browser history.
   */
  pushCurrentPosition(): void {
    if (!this._initialized || this._popStateInProgress) {
      return;
    }
    this.#tryPushCurrentPosition();
  }

  /**
   * Go back one step in the browser history.
   * NOTE: Avoids navigating away from the document, useful for "named actions".
   */
  back(): void {
    if (!this._initialized || this._popStateInProgress) {
      return;
    }
    const state = window.history.state;
    if (this.#isValidState(state) && state.uid > 0) {
      window.history.back();
    }
  }

  /**
   * Go forward one step in the browser history.
   * NOTE: Avoids navigating away from the document, useful for "named actions".
   */
  forward(): void {
    if (!this._initialized || this._popStateInProgress) {
      return;
    }
    const state = window.history.state;
    if (this.#isValidState(state) && state.uid < this._maxUid) {
      window.history.forward();
    }
  }

  /**
   * @type {boolean} Indicating if the user is currently moving through the
   *   browser history, useful e.g. for skipping the next 'hashchange' event.
   */
  get popStateInProgress(): boolean {
    return (
      this._initialized &&
      (this._popStateInProgress || this._blockHashChange > 0)
    );
  }

  get initialBookmark(): string | null {
    return this._initialized ? this._initialBookmark : null;
  }

  get initialRotation(): number | null {
    return this._initialized ? this._initialRotation : null;
  }

  #pushOrReplaceState(destination: HistoryDestination, forceReplace = false): void {
    const shouldReplace = forceReplace || !this._destination;
    const newState: {
      fingerprint: string;
      uid: number;
      destination: HistoryDestination;
      chromecomState?: unknown;
    } = {
      fingerprint: this._fingerprint,
      uid: shouldReplace ? this._uid : this._uid + 1,
      destination,
    };

    if (
      typeof PDFJSDev !== "undefined" &&
      PDFJSDev!.test("CHROME") &&
      window.history.state?.chromecomState
    ) {
      // history.state.chromecomState is managed by chromecom.js.
      newState.chromecomState = window.history.state.chromecomState;
    }
    this.#updateInternalState(destination, newState.uid);

    let newUrl: string | undefined;
    if (this._updateUrl && destination?.hash) {
      const { href, protocol } = document.location;
      if (protocol !== "file:") {
        newUrl = updateUrlHash(href, destination.hash);
      }
    }
    if (shouldReplace) {
      window.history.replaceState(newState, "", newUrl);
    } else {
      window.history.pushState(newState, "", newUrl);
    }
  }

  #tryPushCurrentPosition(temporary = false): void {
    const currentPosition = this._position;
    if (!currentPosition) {
      return;
    }
    let position: ViewPosition = currentPosition;
    if (temporary) {
      position = Object.assign(Object.create(null), currentPosition) as ViewPosition;
      position.temporary = true;
    }

    const dest = this._destination;
    if (!dest) {
      this.#pushOrReplaceState(position);
      return;
    }
    if (dest.temporary) {
      // Always replace a previous *temporary* position.
      this.#pushOrReplaceState(position, /* forceReplace = */ true);
      return;
    }
    if (dest.hash === position.hash) {
      return; // The current document position has not changed.
    }
    if (
      !dest.page &&
      (POSITION_UPDATED_THRESHOLD <= 0 ||
        this._numPositionUpdates <= POSITION_UPDATED_THRESHOLD)
    ) {
      // `this._destination` was set through the user changing the hash of
      // the document. Do not add `this._position` to the browser history,
      // to avoid "flooding" it with lots of (nearly) identical entries,
      // since we cannot ensure that the document position has changed.
      return;
    }

    let forceReplace = false;
    if (
      (dest.page ?? 0) >= position.first &&
      (dest.page ?? 0) <= position.page
    ) {
      // When the `page` of `this._destination` is still visible, do not
      // update the browsing history when `this._destination` either:
      //  - contains an internal destination, since in this case we
      //    cannot ensure that the document position has actually changed.
      //  - was set through the user changing the hash of the document.
      if (dest.dest !== undefined || !dest.first) {
        return;
      }
      // To avoid "flooding" the browser history, replace the current entry.
      forceReplace = true;
    }
    this.#pushOrReplaceState(position, forceReplace);
  }

  #isValidPage(val: unknown): val is number {
    return (
      Number.isInteger(val) && (val as number) > 0 && (val as number) <= this.linkService.pagesCount
    );
  }

  #isValidState(state: unknown, checkReload = false): state is HistoryState {
    if (!state) {
      return false;
    }
    const s = state as any;
    if (s.fingerprint !== this._fingerprint) {
      if (checkReload) {
        // Potentially accept the history entry, even if the fingerprints don't
        // match, when the viewer was reloaded (see issue 6847).
        if (
          typeof s.fingerprint !== "string" ||
          s.fingerprint.length !== this._fingerprint.length
        ) {
          return false;
        }
        const [perfEntry] = performance.getEntriesByType("navigation");
        if ((perfEntry as PerformanceNavigationTiming)?.type !== "reload") {
          return false;
        }
      } else {
        // This should only occur in viewers with support for opening more than
        // one PDF document, e.g. the GENERIC viewer.
        return false;
      }
    }
    if (!Number.isInteger(s.uid) || s.uid < 0) {
      return false;
    }
    if (s.destination === null || typeof s.destination !== "object") {
      return false;
    }
    return true;
  }

  #updateInternalState(destination: HistoryDestination, uid: number, removeTemporary = false): void {
    if (this._updateViewareaTimeout) {
      // When updating `this._destination`, make sure that we always wait for
      // the next 'updateviewarea' event before (potentially) attempting to
      // push the current position to the browser history.
      clearTimeout(this._updateViewareaTimeout);
      this._updateViewareaTimeout = null;
    }
    if (removeTemporary && destination?.temporary) {
      // When the `destination` comes from the browser history,
      // we no longer treat it as a *temporary* position.
      delete destination.temporary;
    }
    this._destination = destination;
    this._uid = uid;
    this._maxUid = Math.max(this._maxUid, uid);
    // This should always be reset when `this._destination` is updated.
    this._numPositionUpdates = 0;
  }

  #parseCurrentHash(checkNameddest = false): { hash: string; page: number | null; rotation: number } {
    const hash = unescape(getCurrentHash()).substring(1);
    const params = parseQueryString(hash);

    const nameddest = params.get("nameddest") || "";
    let page: number | null = Number(params.get("page")) | 0;

    if (!this.#isValidPage(page) || (checkNameddest && nameddest.length > 0)) {
      page = null;
    }
    return { hash, page, rotation: this.linkService.rotation };
  }

  #updateViewarea(evt: unknown): void {
    const { location } = evt as { location: { pdfOpenParams: string; pageNumber: number; rotation: number } };

    if (this._updateViewareaTimeout) {
      clearTimeout(this._updateViewareaTimeout);
      this._updateViewareaTimeout = null;
    }

    this._position = {
      hash: location.pdfOpenParams.substring(1),
      page: this.linkService.page,
      first: location.pageNumber,
      rotation: location.rotation,
    };

    if (this._popStateInProgress) {
      return;
    }

    if (
      POSITION_UPDATED_THRESHOLD > 0 &&
      this._isPagesLoaded &&
      this._destination &&
      !this._destination.page
    ) {
      // If the current destination was set through the user changing the hash
      // of the document, we will usually not try to push the current position
      // to the browser history; see `this.#tryPushCurrentPosition()`.
      //
      // To prevent `this.#tryPushCurrentPosition()` from effectively being
      // reduced to a no-op in this case, we will assume that the position
      // *did* in fact change if the 'updateviewarea' event was dispatched
      // more than `POSITION_UPDATED_THRESHOLD` times.
      this._numPositionUpdates++;
    }

    if (UPDATE_VIEWAREA_TIMEOUT > 0) {
      // When closing the browser, a 'pagehide' event will be dispatched which
      // *should* allow us to push the current position to the browser history.
      // In practice, it seems that the event is arriving too late in order for
      // the session history to be successfully updated.
      // (For additional details, please refer to the discussion in
      //  https://bugzilla.mozilla.org/show_bug.cgi?id=1153393.)
      //
      // To workaround this we attempt to *temporarily* add the current position
      // to the browser history only when the viewer is *idle*,
      // i.e. when scrolling and/or zooming does not occur.
      //
      // PLEASE NOTE: It's absolutely imperative that the browser history is
      // *not* updated too often, since that would render the viewer more or
      // less unusable. Hence the use of a timeout to delay the update until
      // the viewer has been idle for `UPDATE_VIEWAREA_TIMEOUT` milliseconds.
      this._updateViewareaTimeout = setTimeout(() => {
        if (!this._popStateInProgress) {
          this.#tryPushCurrentPosition(/* temporary = */ true);
        }
        this._updateViewareaTimeout = null;
      }, UPDATE_VIEWAREA_TIMEOUT);
    }
  }

  #popState(evt: unknown): void {
    const { state } = evt as { state: unknown };
    const newHash = getCurrentHash(),
      hashChanged = this._currentHash !== newHash;
    this._currentHash = newHash;

    if (
      (typeof PDFJSDev !== "undefined" &&
        PDFJSDev!.test("CHROME") &&
        (state as any)?.chromecomState &&
        !this.#isValidState(state)) ||
      !state
    ) {
      // This case corresponds to the user changing the hash of the document.
      this._uid++;

      const { hash, page, rotation } = this.#parseCurrentHash();
      this.#pushOrReplaceState(
        { hash, page, rotation },
        /* forceReplace = */ true
      );
      return;
    }
    if (!this.#isValidState(state)) {
      // This should only occur in viewers with support for opening more than
      // one PDF document, e.g. the GENERIC viewer.
      return;
    }

    // Prevent the browser history from updating until the new destination,
    // as stored in the browser history, has been scrolled into view.
    this._popStateInProgress = true;

    if (hashChanged) {
      // When the hash changed, implying that the 'popstate' event will be
      // followed by a 'hashchange' event, then we do *not* want to update the
      // browser history when handling the 'hashchange' event (in web/app.js)
      // since that would *overwrite* the new destination navigated to below.
      //
      // To avoid accidentally disabling all future user-initiated hash changes,
      // if there's e.g. another 'hashchange' listener that stops the event
      // propagation, we make sure to always force-reset `this._blockHashChange`
      // after `HASH_CHANGE_TIMEOUT` milliseconds have passed.
      this._blockHashChange++;
      waitOnEventOrTimeout({
        target: window,
        name: "hashchange",
        delay: HASH_CHANGE_TIMEOUT,
      }).then(() => {
        this._blockHashChange--;
      });
    }

    // Navigate to the new destination.
    const destination = state.destination;
    this.#updateInternalState(
      destination,
      state.uid,
      /* removeTemporary = */ true
    );

    if (isValidRotation(destination.rotation)) {
      this.linkService.rotation = destination.rotation;
    }
    if (destination.dest) {
      this.linkService.goToDestination(destination.dest);
    } else if (destination.hash) {
      this.linkService.setHash(destination.hash);
    } else if (destination.page) {
      // Fallback case; shouldn't be necessary, but better safe than sorry.
      this.linkService.page = destination.page;
    }

    // Since `PDFLinkService.goToDestination` is asynchronous, we thus defer the
    // resetting of `this._popStateInProgress` slightly.
    Promise.resolve().then(() => {
      this._popStateInProgress = false;
    });
  }

  #pageHide(): void {
    // Attempt to push the `this._position` into the browser history when
    // navigating away from the document. This is *only* done if the history
    // is empty/temporary, since otherwise an existing browser history entry
    // will end up being overwritten (given that new entries cannot be pushed
    // into the browser history when the 'unload' event has already fired).
    if (!this._destination || this._destination.temporary) {
      this.#tryPushCurrentPosition();
    }
  }

  #bindEvents(): void {
    if (this.#eventAbortController) {
      return; // The event listeners were already added.
    }
    this.#eventAbortController = new AbortController();
    const { signal } = this.#eventAbortController;

    this.eventBus._on("updateviewarea", this.#updateViewarea.bind(this), {
      signal,
    });
    window.addEventListener("popstate", this.#popState.bind(this), { signal });
    window.addEventListener("pagehide", this.#pageHide.bind(this), { signal });
  }

  #unbindEvents(): void {
    this.#eventAbortController?.abort();
    this.#eventAbortController = null;
  }
}

function isDestHashesEqual(destHash: unknown, pushHash: unknown): boolean {
  if (typeof destHash !== "string" || typeof pushHash !== "string") {
    return false;
  }
  if (destHash === pushHash) {
    return true;
  }
  const nameddest = parseQueryString(destHash).get("nameddest");
  if (nameddest === pushHash) {
    return true;
  }
  return false;
}

function isDestArraysEqual(firstDest: unknown, secondDest: unknown): boolean {
  function isEntryEqual(first: unknown, second: unknown): boolean {
    if (typeof first !== typeof second) {
      return false;
    }
    if (Array.isArray(first) || Array.isArray(second)) {
      return false;
    }
    if (first !== null && typeof first === "object" && second !== null) {
      const firstObj = first as Record<string, unknown>;
      const secondObj = second as Record<string, unknown>;
      if (Object.keys(firstObj).length !== Object.keys(secondObj).length) {
        return false;
      }
      for (const key in firstObj) {
        if (!isEntryEqual(firstObj[key], secondObj[key])) {
          return false;
        }
      }
      return true;
    }
    return first === second || (Number.isNaN(first) && Number.isNaN(second));
  }

  if (!(Array.isArray(firstDest) && Array.isArray(secondDest))) {
    return false;
  }
  if (firstDest.length !== secondDest.length) {
    return false;
  }
  for (let i = 0, ii = firstDest.length; i < ii; i++) {
    if (!isEntryEqual(firstDest[i], secondDest[i])) {
      return false;
    }
  }
  return true;
}

export { isDestArraysEqual, isDestHashesEqual, PDFHistory };
