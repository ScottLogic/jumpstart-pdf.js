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

type EventBusListener = (data: unknown) => void;

type EventBusOnOptions = {
  once?: boolean;
  signal?: AbortSignal;
} | null;

type EventBusInternalOptions = {
  external?: boolean;
  once?: boolean;
  signal?: AbortSignal;
} | null;

type ListenerEntry = {
  listener: EventBusListener;
  external: boolean;
  once: boolean;
  rmAbort: (() => void) | null;
};

const WaitOnType = {
  EVENT: "event",
  TIMEOUT: "timeout",
} as const;

type WaitOnTypeValue = (typeof WaitOnType)[keyof typeof WaitOnType];

/**
 * Allows waiting for an event or a timeout, whichever occurs first.
 * Can be used to ensure that an action always occurs, even when an event
 * arrives late or not at all.
 */
async function waitOnEventOrTimeout({
  target,
  name,
  delay = 0,
}: {
  target: EventTarget | EventBus;
  name: string;
  delay?: number;
}): Promise<WaitOnTypeValue> {
  if (
    typeof target !== "object" ||
    !(name && typeof name === "string") ||
    !(Number.isInteger(delay) && delay >= 0)
  ) {
    throw new Error("waitOnEventOrTimeout - invalid parameters.");
  }
  const { promise, resolve } = Promise.withResolvers<WaitOnTypeValue>();
  const ac = new AbortController();

  function handler(type: WaitOnTypeValue) {
    ac.abort(); // Remove event listener.
    clearTimeout(timeout);
    resolve(type);
  }

  if (target instanceof EventBus) {
    target._on(name, handler.bind(null, WaitOnType.EVENT) as EventBusListener, {
      signal: ac.signal,
    });
  } else {
    (target as EventTarget).addEventListener(
      name,
      handler.bind(null, WaitOnType.EVENT) as EventListener,
      { signal: ac.signal }
    );
  }

  const timeout = setTimeout(handler.bind(null, WaitOnType.TIMEOUT), delay);

  return promise;
}

/**
 * Simple event bus for an application. Listeners are attached using the `on`
 * and `off` methods. To raise an event, the `dispatch` method shall be used.
 */
class EventBus {
  #listeners: Record<string, ListenerEntry[]> = Object.create(null);

  on(eventName: string, listener: EventBusListener, options: EventBusOnOptions = null): void {
    this._on(eventName, listener, {
      external: true,
      once: options?.once,
      signal: options?.signal,
    });
  }

  off(eventName: string, listener: EventBusListener, _options: EventBusOnOptions = null): void {
    this._off(eventName, listener);
  }

  dispatch(eventName: string, data?: unknown): void {
    const eventListeners = this.#listeners[eventName];
    if (!eventListeners || eventListeners.length === 0) {
      return;
    }
    let externalListeners: EventBusListener[] | undefined;
    // Making copy of the listeners array in case if it will be modified
    // during dispatch.
    for (const { listener, external, once } of eventListeners.slice(0)) {
      if (once) {
        this._off(eventName, listener);
      }
      if (external) {
        (externalListeners ||= []).push(listener);
        continue;
      }
      listener(data);
    }
    // Dispatch any "external" listeners *after* the internal ones, to give the
    // viewer components time to handle events and update their state first.
    if (externalListeners) {
      for (const listener of externalListeners) {
        listener(data);
      }
      externalListeners = undefined;
    }
  }

  /**
   * @ignore
   */
  _on(eventName: string, listener: EventBusListener, options: EventBusInternalOptions = null): void {
    let rmAbort: (() => void) | null = null;
    if (options?.signal instanceof AbortSignal) {
      const { signal } = options;
      if (signal.aborted) {
        console.error("Cannot use an `aborted` signal.");
        return;
      }
      const onAbort = () => this._off(eventName, listener);
      rmAbort = () => signal.removeEventListener("abort", onAbort);

      signal.addEventListener("abort", onAbort);
    }

    const eventListeners = (this.#listeners[eventName] ||= []);
    eventListeners.push({
      listener,
      external: options?.external === true,
      once: options?.once === true,
      rmAbort,
    });
  }

  /**
   * @ignore
   */
  _off(eventName: string, listener: EventBusListener, _options: EventBusOnOptions = null): void {
    const eventListeners = this.#listeners[eventName];
    if (!eventListeners) {
      return;
    }
    for (let i = 0, ii = eventListeners.length; i < ii; i++) {
      const evt = eventListeners[i];
      if (evt.listener === listener) {
        evt.rmAbort?.(); // Ensure that the `AbortSignal` listener is removed.
        eventListeners.splice(i, 1);
        return;
      }
    }
  }
}

interface ExternalServices {
  dispatchGlobalEvent(event: { eventName: string; detail: unknown }): void;
}

/**
 * NOTE: Only used in the Firefox built-in pdf viewer.
 */
class FirefoxEventBus extends EventBus {
  #externalServices: ExternalServices;

  #globalEventNames: Set<string>;

  #isInAutomation: boolean;

  constructor(
    globalEventNames: Set<string>,
    externalServices: ExternalServices,
    isInAutomation: boolean
  ) {
    super();
    this.#globalEventNames = globalEventNames;
    this.#externalServices = externalServices;
    this.#isInAutomation = isInAutomation;
  }

  dispatch(eventName: string, data?: unknown): void {
    if (typeof PDFJSDev !== "undefined" && !PDFJSDev.test("MOZCENTRAL")) {
      throw new Error("Not implemented: FirefoxEventBus.dispatch");
    }
    super.dispatch(eventName, data);

    if (this.#isInAutomation) {
      const detail = Object.create(null);
      if (data) {
        for (const key in data as Record<string, unknown>) {
          const value = (data as Record<string, unknown>)[key];
          if (key === "source") {
            if (value === window || value === document) {
              return; // No need to re-dispatch (already) global events.
            }
            continue; // Ignore the `source` property.
          }
          detail[key] = value;
        }
      }
      const event = new CustomEvent(eventName, {
        bubbles: true,
        cancelable: true,
        detail,
      });
      document.dispatchEvent(event);
    }

    if (this.#globalEventNames?.has(eventName)) {
      this.#externalServices.dispatchGlobalEvent({
        eventName,
        detail: data,
      });
    }
  }
}

export { EventBus, FirefoxEventBus, waitOnEventOrTimeout, WaitOnType };
