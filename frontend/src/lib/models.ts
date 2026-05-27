// Provider values mirror the Prisma `Provider` enum on the API side.
export type ProviderValue = "openai" | "anthropic" | "gemini" | "deepseek";

export type ModelOption = {
  id: string;
  name: string;
};

export type ProviderModels = {
  provider: ProviderValue;
  label: string;
  models: ModelOption[];
};

// Models the orchestrator can be set to, grouped by provider.
export const AVAILABLE_MODELS: ProviderModels[] = [
  {
    provider: "openai",
    label: "OpenAI",
    models: [
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4o-mini", name: "GPT-4o-mini" },
    ],
  },
  {
    provider: "anthropic",
    label: "Anthropic",
    models: [
      { id: "claude-opus", name: "Claude Opus" },
      { id: "claude-sonnet", name: "Claude Sonnet" },
    ],
  },
  {
    provider: "gemini",
    label: "Gemini",
    models: [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
  },
  {
    provider: "deepseek",
    label: "DeepSeek",
    models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
  },
];

// Flat lookup for resolving a model id back to its display name + provider.
export function findModel(
  modelId: string,
): { provider: ProviderValue; providerLabel: string; name: string } | null {
  for (const group of AVAILABLE_MODELS) {
    const model = group.models.find((m) => m.id === modelId);
    if (model) {
      return {
        provider: group.provider,
        providerLabel: group.label,
        name: model.name,
      };
    }
  }
  return null;
}
