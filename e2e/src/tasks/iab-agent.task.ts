import { Task } from '@serenity-js/core';
import { ExerciseIabAgent } from '../interactions/iab-agent.interaction.js';
import { EnterChat } from './chat.task.js';

export const VerifyAgentBrowser = (scenario: 'multi-step' | 'simple' | 'complex' | 'parallel' | 'subagents' | 'stress' = 'multi-step') => Task.where(`#actor verifies ${scenario} Agent browser tools against independent page results`,
  EnterChat(),
  ExerciseIabAgent(scenario),
);
