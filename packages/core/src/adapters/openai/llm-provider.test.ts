import { describeLlmProviderContract } from "../../ports/llm-provider.contract.js";
import { OpenAILlmProvider } from "./llm-provider.js";

describeLlmProviderContract({
  name: "OpenAILlmProvider",
  make: () => new OpenAILlmProvider(),
  modelPattern: /^gpt-/,
  apiKeyEnv: "OPENAI_API_KEY",
});
