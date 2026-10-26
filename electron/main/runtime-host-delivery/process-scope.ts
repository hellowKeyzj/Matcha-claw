import { createRequire } from 'node:module';
import { win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface RuntimeHostProcessScope {
  terminate(): Promise<void>;
  close(): Promise<void>;
}

function scopeError(stage: string, win32ErrorCode: number | null, cause?: unknown): Error {
  return Object.assign(
    new Error(`runtime-host process scope ${stage} failed (Win32 ${win32ErrorCode ?? 'unavailable'})`, { cause }),
    { stage, win32ErrorCode },
  );
}

function loadKernel32() {
  try {
    const koffi = createRequire(__filename)('koffi') as typeof import('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    return {
      createJob: kernel32.func('void * __stdcall CreateJobObjectW(void *attributes, const char16_t *name)'),
      setJobInformation: kernel32.func('int __stdcall SetInformationJobObject(void *job, int informationClass, void *information, uint32_t length)'),
      openProcess: kernel32.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
      queryImage: kernel32.func('int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *image, void *length)'),
      assignProcess: kernel32.func('int __stdcall AssignProcessToJobObject(void *job, void *process)'),
      terminateJob: kernel32.func('int __stdcall TerminateJobObject(void *job, uint32_t exitCode)'),
      queryJobInformation: kernel32.func('int __stdcall QueryInformationJobObject(void *job, int informationClass, void *information, uint32_t length, void *returnedLength)'),
      closeHandle: kernel32.func('int __stdcall CloseHandle(void *handle)'),
      getLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
    };
  } catch (cause) {
    throw scopeError('LoadKernel32', null, cause);
  }
}

export function createRuntimeHostProcessScope(pid: number, executablePath: string): RuntimeHostProcessScope {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
    throw scopeError('ValidatePlatform', 50); // ERROR_NOT_SUPPORTED: buffers below use the Win64 ABI.
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff || !win32.isAbsolute(executablePath)) {
    throw scopeError('ValidateProcess', 87); // ERROR_INVALID_PARAMETER
  }
  const native = loadKernel32();
  const check = (result: number, stage: string): void => {
    if (result === 0) throw scopeError(stage, native.getLastError());
  };
  let job: bigint | null = null;
  let processHandle: bigint | null = null;
  try {
    // Null SECURITY_ATTRIBUTES and name: private, non-inheritable Job handle.
    job = native.createJob(null, null) as bigint | null;
    if (!job) throw scopeError('CreateJobObject', native.getLastError());
    const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Win64.
    limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
    check(native.setJobInformation(job, 9, limits, limits.length), 'SetJobLimits');
    // PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE.
    processHandle = native.openProcess(0x1101, 0, pid) as bigint | null;
    if (!processHandle) throw scopeError('OpenProcess', native.getLastError());
    const image = Buffer.alloc(32_768 * 2);
    const imageLength = Buffer.alloc(4);
    imageLength.writeUInt32LE(image.length / 2);
    check(native.queryImage(processHandle, 0, image, imageLength), 'QueryProcessImage');
    const actualImage = image.toString('utf16le', 0, imageLength.readUInt32LE() * 2);
    if (win32.normalize(actualImage).toLowerCase() !== win32.normalize(executablePath).toLowerCase()) {
      throw scopeError('VerifyProcessImage', 13); // ERROR_INVALID_DATA; never kill by a mismatched PID.
    }
    // The caller must not write bootstrap until this assignment succeeds.
    check(native.assignProcess(job, processHandle), 'AssignProcessToJob');
    check(native.closeHandle(processHandle), 'CloseProcessHandle');
    processHandle = null;
  } catch (error) {
    const failures: unknown[] = [error];
    for (const [handle, stage] of [[processHandle, 'CloseProcessHandle'], [job, 'CloseJobHandle']] as const) {
      if (handle && native.closeHandle(handle) === 0) {
        failures.push(scopeError(stage, native.getLastError()));
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'runtime-host process scope SetupCleanup failed', { cause: error });
    throw error;
  }

  let closing: Promise<void> | undefined;
  let terminating: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const accounting = Buffer.alloc(48); // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.
      for (;;) {
        check(native.queryJobInformation(job, 1, accounting, accounting.length, null), 'QueryJobAccounting');
        if (accounting.readUInt32LE(40) === 0) break; // ActiveProcesses, not merely root exit.
        await delay(25);
      }
      check(native.closeHandle(job), 'CloseJobHandle');
      job = null;
    })();
    return closing;
  };
  return {
    close,
    terminate(): Promise<void> {
      terminating ??= (async () => {
        if (job === null) return;
        check(native.terminateJob(job, 1), 'TerminateJob');
        await close();
      })();
      return terminating;
    },
  };
}
