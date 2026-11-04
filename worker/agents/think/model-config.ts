import { ModelSize, type AIModelConfig } from '../inferutils/config.types';

// Compat id: provider/model. The account's only AI Gateway provider key is
// DeepSeek (Secrets Store name `unitoken_deepseek_default`), so Gemini requests
// fail before the model runs.
export const THINK_MODEL_ID = 'deepseek/deepseek-chat';

export const THINK_MODEL_CONFIG: AIModelConfig = {
	name: 'DeepSeek Chat',
	size: ModelSize.REGULAR,
	provider: 'deepseek',
	creditCost: 1,
	contextSize: 128_000,
};
