import type { Plugin } from "rolldown";
import inlineClientHandlers, {
  type InlineClientPluginOptions,
} from "./rolldown/inline-client-rolldown.ts";

export type UseClientPluginOptions = InlineClientPluginOptions;

export default function useClient(
  options: UseClientPluginOptions = {},
): Plugin {
  return inlineClientHandlers(options);
}
