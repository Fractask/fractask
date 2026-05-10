// Web's LLM helper is now just a re-export from @getshit/core/llm so the CLI
// and web share the same provider abstraction, model list, and streaming code.
export {
  MODELS,
  DEFAULT_MODEL_ID,
  findModel,
  availableProviders,
  generate,
  streamChat,
} from '@getshit/core/llm';
export type { ModelOption, Provider, ChatMessage } from '@getshit/core/llm';
