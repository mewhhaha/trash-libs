/**
 * @module
 * Public entrypoint for the use-client Rolldown plugin.
 */

import type { Plugin } from "rolldown";
import inlineClientHandlers, {
  type InlineClientPluginOptions,
} from "./rolldown/inline-client-rolldown.ts";

/** Options for configuring inline client handler extraction. */
export type UseClientPluginOptions = InlineClientPluginOptions;

/** Returns the Rolldown plugin that extracts inline `"use client"` handlers. */
export default function useClient(
  options: UseClientPluginOptions = {},
): Plugin {
  return inlineClientHandlers(options);
}
