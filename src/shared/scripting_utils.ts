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

/**
 * PLEASE NOTE: This file is currently imported in both the `../display/` and
 *              `../scripting_api/` folders, hence be EXTREMELY careful about
 *              introducing any dependencies here since that can lead to an
 *              unexpected/unnecessary size increase of the *built* files.
 */

import { MathClamp } from "../shared/math_clamp.js";

function makeColorComp(n: number): string {
  return Math.floor(MathClamp(n, 0, 1) * 255)
    .toString(16)
    .padStart(2, "0");
}

function scaleAndClamp(x: number): number {
  return MathClamp(x, 0, 1) * 255;
}

// PDF specifications section 10.3
class ColorConverters {
  static CMYK_G([c, y, m, k]: number[]) {
    return ["G", 1 - Math.min(1, 0.3 * c + 0.59 * m + 0.11 * y + k)];
  }

  static G_CMYK([g]: number[]) {
    return ["CMYK", 0, 0, 0, 1 - g];
  }

  static G_RGB([g]: number[]) {
    return ["RGB", g, g, g];
  }

  static G_rgb([g]: number[]) {
    g = scaleAndClamp(g);
    return [g, g, g];
  }

  static G_HTML([g]: number[]) {
    const G = makeColorComp(g);
    return `#${G}${G}${G}`;
  }

  static RGB_G([r, g, b]: number[]) {
    return ["G", 0.3 * r + 0.59 * g + 0.11 * b];
  }

  static RGB_rgb(color: number[]) {
    return color.map(scaleAndClamp);
  }

  static RGB_HTML(color: number[]) {
    return `#${color.map(makeColorComp).join("")}`;
  }

  static T_HTML() {
    return "#00000000";
  }

  static T_rgb() {
    return [null];
  }

  static CMYK_RGB([c, y, m, k]: number[]) {
    return [
      "RGB",
      1 - Math.min(1, c + k),
      1 - Math.min(1, m + k),
      1 - Math.min(1, y + k),
    ];
  }

  static CMYK_rgb([c, y, m, k]: number[]) {
    return [
      scaleAndClamp(1 - Math.min(1, c + k)),
      scaleAndClamp(1 - Math.min(1, m + k)),
      scaleAndClamp(1 - Math.min(1, y + k)),
    ];
  }

  static CMYK_HTML(components: number[]) {
    const rgb = this.CMYK_RGB(components).slice(1) as number[];
    return this.RGB_HTML(rgb);
  }

  static RGB_CMYK([r, g, b]: number[]) {
    const c = 1 - r;
    const m = 1 - g;
    const y = 1 - b;
    const k = Math.min(c, m, y);
    return ["CMYK", c, m, y, k];
  }
}

const DateFormats = [
  "m/d",
  "m/d/yy",
  "mm/dd/yy",
  "mm/yy",
  "d-mmm",
  "d-mmm-yy",
  "dd-mmm-yy",
  "yy-mm-dd",
  "mmm-yy",
  "mmmm-yy",
  "mmm d, yyyy",
  "mmmm d, yyyy",
  "m/d/yy h:MM tt",
  "m/d/yy HH:MM",
];
const TimeFormats = ["HH:MM", "h:MM tt", "HH:MM:ss", "h:MM:ss tt"];

export { ColorConverters, DateFormats, TimeFormats };
