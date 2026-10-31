import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DesignError } from './files';
import { dimensions } from './validation';
import { requireFfmpeg } from './video';

export async function readVideoMetadata(
  packagePath: string, storagePath: string, bytes: Buffer, signal?: AbortSignal,
): Promise<{ width: number; height: number; durationSeconds: number; poster: Buffer }> {
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
  bounded.throwIfAborted();
  await mkdir(storagePath, { recursive: true });
  const directory = await mkdtemp(join(storagePath, '.video-metadata-'));
  try {
    const source = join(directory, 'source.bin');
    const posterPath = join(directory, 'poster.png');
    await writeFile(source, bytes, { flag: 'wx', mode: 0o600 });
    const executable = await requireFfmpeg(packagePath, bounded);
    let durationSeconds: number | undefined;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ['-nostdin', '-hide_banner', '-nostats', '-protocol_whitelist', 'file,pipe',
        '-i', source, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-update', '1', posterPath],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal: bounded });
      let stderr = '';
      let failure: Error | undefined;
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8000);
        const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
        if (duration) durationSeconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
      });
      child.once('error', (error) => { failure = error; });
      child.once('close', (code) => {
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new Error(`FFmpeg could not decode the video (exit ${code}).`));
      });
    });
    bounded.throwIfAborted();
    if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('The video does not contain a finite positive duration.');
    }
    const poster = await readFile(posterPath);
    const { loadImage } = await import('skia-canvas');
    const image = await loadImage(poster);
    dimensions(image.width, image.height);
    return { width: image.width, height: image.height, durationSeconds, poster };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new DesignError('video_metadata_failed', 'Could not read video dimensions, duration and a displayable poster. Check the video and the packaged FFmpeg executable.',
      { reason: bounded.aborted ? 'timeout' : error instanceof Error && 'code' in error ? String(error.code) : 'decode_failed' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
