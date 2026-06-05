import { describe, expect, it } from 'vitest';
import { iterateTranscriptMessagesFromChunksAsync } from '../../runtime-host/application/sessions/transcript-parser';

async function* chunks(values: string[]): AsyncIterable<string> {
  for (const value of values) {
    yield value;
  }
}

function transcriptLine(id: string, content: string): string {
  return JSON.stringify({
    id,
    timestamp: 1,
    message: {
      role: 'user',
      content,
    },
  });
}

describe('transcript parser', () => {
  it('streams JSONL messages across arbitrary chunk boundaries without materializing the transcript', async () => {
    const first = transcriptLine('msg-1', 'hello');
    const second = transcriptLine('msg-2', 'world');
    const split = `${first}\n${second}\r\n`;
    const messages = [];

    for await (const message of iterateTranscriptMessagesFromChunksAsync(chunks([
      split.slice(0, 7),
      split.slice(7, 19),
      split.slice(19, 55),
      split.slice(55),
    ]))) {
      messages.push(message);
    }

    expect(messages.map((message) => message.id)).toEqual(['msg-1', 'msg-2']);
    expect(messages.map((message) => message.content)).toEqual(['hello', 'world']);
  });

  it('emits the final unterminated JSONL record from async chunks', async () => {
    const messages = [];

    for await (const message of iterateTranscriptMessagesFromChunksAsync(chunks([
      transcriptLine('msg-1', 'unterminated').slice(0, 20),
      transcriptLine('msg-1', 'unterminated').slice(20),
    ]))) {
      messages.push(message);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('unterminated');
  });
});
