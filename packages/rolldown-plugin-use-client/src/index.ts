/**
 * Rolldown plugin and ESLint companion exports for extracting inline
 * `"use client"` handlers into standalone client chunks.
 */

import useClient from "./use-client-rolldown.ts";
import type { UseClientPluginOptions } from "./use-client-rolldown.ts";

/** Creates the Rolldown plugin that extracts inline `"use client"` handlers. */
export default useClient;

/** Configuration options for the default `useClient()` export. */
export type { UseClientPluginOptions };
