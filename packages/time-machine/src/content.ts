/**
 * The one content block this plugin emits.
 *
 * Declared locally instead of imported from `@deepseek-ai/dsh-llm` so the tool
 * definitions type-check against the published `dsh-tools` declarations without
 * taking a direct dependency on the LLM package. The shape is structurally
 * identical to that package's `TextBlock` (`{ type: 'text'; text: string }`),
 * which is what makes it a valid `ContentBlock`.
 *
 * @module @harness-ext/time-machine/content
 */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** Everything this plugin can return to the model. */
export type ContentBlock = TextBlock;
