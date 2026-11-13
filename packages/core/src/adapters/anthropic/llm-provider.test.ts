import { describeLlmProviderContract } from "../../ports/llm-provider.contract.js";
import { AnthropicLlmProvider } from "./llm-provider.js";

describeLlmProviderContract({
  name: "AnthropicLlmProvider",
  make: () => new AnthropicLlmProvider(),
  modelPattern: /^claude-/,
  apiKeyEnv: "ANTHROPIC_API_KEY",
});
