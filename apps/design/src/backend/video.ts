import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Asset } from '../document';
import type { Assets } from './assets';
import { DesignError } from './files';
import { dimensions } from './validation';

async function run(executable: string, args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal: bounded });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8000); });
    let failure: Error | undefined;
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => {
      if (failure) reject(failure);
      else if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

export async function requireFfmpeg(packagePath: string, signal: AbortSignal): Promise<string> {
  const executable = join(packagePath, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  try {
    signal.throwIfAborted();
    if (process.platform !== 'win32') await chmod(executable, 0o700);
    await run(executable, ['-version'], signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new DesignError('ffmpeg_unavailable', `The design package must include a working bin/ffmpeg${process.platform === 'win32' ? '.exe' : ''} for video processing. ${error instanceof Error ? error.message : String(error)}`);
  }
  return executable;
}

export async function composeStoryboard(
  executable: string, storagePath: string, assets: Assets, scenes: Asset[], size: string | undefined, signal: AbortSignal,
): Promise<Buffer> {
  const selectedSize = size && /^(\d+)x(\d+)$/.exec(size);
  const width = selectedSize ? Number(selectedSize[1]) : scenes[0]?.width;
  const height = selectedSize ? Number(selectedSize[2]) : scenes[0]?.height;
  if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) throw new DesignError('invalid_video_size', 'Storyboard composition requires the selected pixel size or measured dimensions of the first scene.');
  dimensions(width, height);
  if (width % 2 || height % 2) throw new DesignError('unsupported_target_size', 'Storyboard composition requires even pixel dimensions. Saved scenes were retained without rounding the requested size.');
  const directory = await mkdtemp(join(storagePath, '.storyboard-'));
  try {
    for (let index = 0; index < scenes.length; index++) {
      const source = scenes[index];
      if (!source.mimeType.startsWith('video/')) throw new Error(`Storyboard scene ${index + 1} is not a video.`);
      const description = await run(executable, ['-nostdin', '-i', assets.path(source.id), '-map', '0:v:0', '-map', '0:a:0?', '-t', '0', '-f', 'null', '-'], signal);
      const hasAudio = /Stream #[^\r\n]*Audio:/.test(description);
      await run(executable, ['-nostdin', '-y', '-i', assets.path(source.id),
        ...(hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']),
        '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0', '-af', 'apad', '-shortest',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`,
        '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
        join(directory, `${index}.mp4`)], signal);
    }
    await writeFile(join(directory, 'scenes.txt'), scenes.map((_, index) => `file '${index}.mp4'`).join('\n'), 'utf8');
    const output = join(directory, 'storyboard.mp4');
    await run(executable, ['-nostdin', '-y', '-f', 'concat', '-safe', '1', '-i', join(directory, 'scenes.txt'), '-c', 'copy', '-movflags', '+faststart', output], signal);
    signal.throwIfAborted();
    return await readFile(output);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
