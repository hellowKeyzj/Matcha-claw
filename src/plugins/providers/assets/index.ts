import anthropic from './anthropic.svg';
import openai from './openai.svg';
import google from './google.svg';
import openrouter from './openrouter.svg';
import ark from './ark.svg';
import zai from './zai.svg';
import moonshot from './moonshot.svg';
import siliconflow from './siliconflow.svg';
import deepseek from './deepseek.svg';
import minimaxPortal from './minimax.svg';
import qwenPortal from './qwen.svg';
import ollama from './ollama.svg';
import custom from './custom.svg';
import qianfan from './qianfan.svg';
import stepfun from './stepfun.svg';
import tencent from './tencent.svg';
import xiaomi from './xiaomi.svg';
import opencode from './opencode.svg';
import githubCopilot from './github-copilot.svg';

export const providerIcons: Record<string, string> = {
    anthropic,
    openai,
    google,
    openrouter,
    ark,
    zai,
    'zai-global': zai,
    moonshot,
    'moonshot-global': moonshot,
    siliconflow,
    deepseek,
    'minimax-portal': minimaxPortal,
    'minimax-portal-cn': minimaxPortal,
    'qwen-portal': qwenPortal,
    qianfan,
    stepfun,
    'tencent-tokenhub': tencent,
    'tencent-tokenplan': tencent,
    xiaomi,
    'xiaomi-token-plan': xiaomi,
    qwen: qwenPortal,
    'qwen-token-plan': qwenPortal,
    kimi: moonshot,
    'volcengine-plan': ark,
    opencode,
    'opencode-go': opencode,
    'github-copilot': githubCopilot,
    ollama,
    custom,
};
