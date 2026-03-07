/**
 * Rolldown plugin exports for compiling and optimizing Tailwind CSS files
 * during a build.
 */

import tailwindcss from "./tailwindcss-rolldown.ts";
import type { TailwindPluginOptions } from "./tailwindcss-rolldown.ts";

/** Creates the Rolldown plugin that compiles Tailwind CSS sources. */
export default tailwindcss;

/** Configuration options for the default `tailwindcss()` export. */
export type { TailwindPluginOptions };
