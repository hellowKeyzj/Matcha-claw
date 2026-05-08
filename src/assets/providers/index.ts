import anthropic from './anthropic.svg';
import openai from './openai.svg';
import google from './google.svg';
import openrouter from './openrouter.svg';
import ark from './ark.svg';
import moonshot from './moonshot.svg';
import siliconflow from './siliconflow.svg';
import deepseek from './deepseek.svg';
import minimaxPortal from './minimax.svg';
import qwenPortal from './qwen.svg';
import ollama from './ollama.svg';
import custom from './custom.svg';

export const providerIcons: Record<string, string> = {
    anthropic,
    openai,
    google,
    openrouter,
    ark,
    moonshot,
    'moonshot-global': moonshot,
    siliconflow,
    deepseek,
    'minimax-portal': minimaxPortal,
    'minimax-portal-cn': minimaxPortal,
    'qwen-portal': qwenPortal,
    ollama,
    custom,
};
