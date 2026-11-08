import ctypes as c
from ctypes import wintypes as w
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

# Windows x64 JobObject/atomic JOB_LIST layout.
GIB = 1024**3
DISK_RESERVE = int(os.environ.get('BOUNDED_DISK_RESERVE_GIB', '1')) * GIB
K = c.WinDLL('kernel32', use_last_error=True)
H, S = w.HANDLE, c.c_size_t


class Basic(c.Structure):
    _fields_ = [('processTime', c.c_longlong), ('jobTime', c.c_longlong), ('flags', w.DWORD), ('minWS', S), ('maxWS', S), ('activeLimit', w.DWORD), ('affinity', S), ('priority', w.DWORD), ('scheduling', w.DWORD)]


class IO(c.Structure):
    _fields_ = [(name, c.c_ulonglong) for name in ('readOps', 'writeOps', 'otherOps', 'readBytes', 'writeBytes', 'otherBytes')]


class Limits(c.Structure):
    _fields_ = [('basic', Basic), ('io', IO), ('processMemory', S), ('jobMemory', S), ('peakProcessMemory', S), ('peakJobMemory', S)]


class Memory(c.Structure):
    _fields_ = [('length', w.DWORD), ('load', w.DWORD)] + [(name, c.c_ulonglong) for name in ('totalPhysical', 'availablePhysical', 'totalPageFile', 'availablePageFile', 'totalVirtual', 'availableVirtual', 'extended')]


class Accounting(c.Structure):
    _fields_ = [(name, c.c_longlong) for name in ('userTime', 'kernelTime', 'periodUserTime', 'periodKernelTime')] + [(name, w.DWORD) for name in ('pageFaults', 'totalProcesses', 'activeProcesses', 'terminatedProcesses')]


class Startup(c.Structure):
    _fields_ = [('cb', w.DWORD), ('reserved', w.LPWSTR), ('desktop', w.LPWSTR), ('title', w.LPWSTR)] + [(name, w.DWORD) for name in ('x', 'y', 'xSize', 'ySize', 'xChars', 'yChars', 'fill', 'flags')] + [('show', w.WORD), ('reservedSize', w.WORD), ('reservedBytes', c.c_void_p), ('stdin', H), ('stdout', H), ('stderr', H)]


class StartupEx(c.Structure):
    _fields_ = [('startup', Startup), ('attributes', c.c_void_p)]


class ProcessInfo(c.Structure):
    _fields_ = [('process', H), ('thread', H), ('pid', w.DWORD), ('tid', w.DWORD)]


class Completion(c.Structure):
    _fields_ = [('key', c.c_void_p), ('port', H)]


def api(name, args, result):
    function = getattr(K, name)
    function.argtypes, function.restype = args, result
    return function


create_job = api('CreateJobObjectW', [c.c_void_p, w.LPCWSTR], H)
set_job = api('SetInformationJobObject', [H, c.c_int, c.c_void_p, w.DWORD], w.BOOL)
query_job = api('QueryInformationJobObject', [H, c.c_int, c.c_void_p, w.DWORD, c.c_void_p], w.BOOL)
close = api('CloseHandle', [H], w.BOOL)
terminate = api('TerminateJobObject', [H, w.UINT], w.BOOL)
mem_status = api('GlobalMemoryStatusEx', [c.POINTER(Memory)], w.BOOL)
current_process = api('GetCurrentProcess', [], H)
std_handle = api('GetStdHandle', [w.DWORD], H)
duplicate = api('DuplicateHandle', [H, H, H, c.POINTER(H), w.DWORD, w.BOOL, w.DWORD], w.BOOL)
create_port = api('CreateIoCompletionPort', [H, H, S, w.DWORD], H)
get_packet = api('GetQueuedCompletionStatus', [H, c.POINTER(w.DWORD), c.POINTER(S), c.POINTER(c.c_void_p), w.DWORD], w.BOOL)
init_attributes = api('InitializeProcThreadAttributeList', [c.c_void_p, w.DWORD, w.DWORD, c.POINTER(S)], w.BOOL)
update_attribute = api('UpdateProcThreadAttribute', [c.c_void_p, w.DWORD, S, c.c_void_p, S, c.c_void_p, c.c_void_p], w.BOOL)
delete_attributes = api('DeleteProcThreadAttributeList', [c.c_void_p], None)
create_process = api('CreateProcessW', [w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL, w.DWORD, c.c_void_p, w.LPCWSTR, c.POINTER(StartupEx), c.POINTER(ProcessInfo)], w.BOOL)
resume = api('ResumeThread', [H], w.DWORD)
wait = api('WaitForSingleObject', [H, w.DWORD], w.DWORD)
exit_code = api('GetExitCodeProcess', [H, c.POINTER(w.DWORD)], w.BOOL)
in_job = api('IsProcessInJob', [H, H, c.POINTER(w.BOOL)], w.BOOL)
open_process = api('OpenProcess', [w.DWORD, w.BOOL, w.DWORD], H)
query_image = api('QueryFullProcessImageNameW', [H, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)], w.BOOL)
terminate_process = api('TerminateProcess', [H, w.UINT], w.BOOL)


def check(value, operation):
    if not value:
        raise OSError(c.get_last_error(), operation)
    return value


def emit(event, **fields):
    print(json.dumps({'boundedRun': event, **fields}), file=sys.stderr, flush=True)


def active(job):
    accounting = Accounting()
    check(query_job(job, 1, c.byref(accounting), c.sizeof(accounting), None), 'Query owned Job accounting')
    return accounting.activeProcesses


def reap_msvc_telemetry(job, authorized):
    storage = c.create_string_buffer(8 + (active(job) + 16) * c.sizeof(S))
    if not query_job(job, 3, storage, c.sizeof(storage), None):
        if c.get_last_error() == 234:  # Job grew; retry under the normal resource/timeout loop.
            return
        raise OSError(c.get_last_error(), 'List private Job processes')
    count = w.DWORD.from_buffer(storage, 4).value
    reaped = False
    for pid in (S * count).from_buffer(storage, 8):
        process = open_process(0x101001, False, pid)  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION | TERMINATE
        if not process:
            if c.get_last_error() == 87:  # Process exited between enumeration and OpenProcess.
                continue
            raise OSError(c.get_last_error(), 'Open private Job process')
        try:
            if wait(process, 0) == 0:
                continue
            owned = w.BOOL()
            check(in_job(process, job, c.byref(owned)), 'Verify telemetry process Job ownership')
            if not owned.value:
                continue
            image, size = c.create_unicode_buffer(32768), w.DWORD(32768)
            check(query_image(process, 0, image, c.byref(size)), 'Read private Job process image')
            if os.path.normcase(os.path.normpath(image.value)) == authorized:
                check(terminate_process(process, 0), 'Terminate exact authorized MSVC telemetry')
                if wait(process, 1000) != 0:
                    raise RuntimeError('Authorized MSVC telemetry did not exit')
                reaped = True
                emit('msvc-telemetry-reaped', pid=pid, exe=image.value)
        finally:
            check(close(process), 'Close private Job process handle')
    return reaped


def run():
    handles, attributes, job = [], None, None
    result = {'status': 'refused', 'started': False, 'forcedTermination': False, 'jobActive': None}
    code, minimum_free, minimum_disk = 125, None, None

    def resources(root):
        nonlocal minimum_free, minimum_disk
        memory = Memory()
        memory.length = c.sizeof(memory)
        check(mem_status(c.byref(memory)), 'GlobalMemoryStatusEx')
        free, disk = memory.availablePhysical, shutil.disk_usage(root).free
        minimum_free = free if minimum_free is None else min(minimum_free, free)
        minimum_disk = disk if minimum_disk is None else min(minimum_disk, disk)
        return free, disk

    try:
        if len(sys.argv) < 5:
            raise ValueError('Usage: python -I windows-bounded-run.py <workdir> <capGiB|none> <timeoutSeconds> <command...>')
        if S(-1).value != 2**64 - 1 or c.sizeof(Limits) != 144 or c.sizeof(StartupEx) != 112 or c.sizeof(Accounting) != 48:
            raise RuntimeError('Win64 ABI mismatch; no command started')
        root = Path(sys.argv[1]).resolve(strict=True)
        if not root.is_dir():
            raise ValueError('workdir must be a directory')
        cap_gib = None if sys.argv[2] == 'none' else float(sys.argv[2])
        timeout = float(sys.argv[3])
        if (cap_gib is not None and (not math.isfinite(cap_gib) or not 0 < cap_gib < 2**34)) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError('capGiB must be none or finite positive; timeoutSeconds must be finite positive')
        cap = None if cap_gib is None else int(cap_gib * GIB)
        if cap is not None and cap < 1:
            raise ValueError('capGiB must represent at least one byte')
        argv = sys.argv[4:]
        target = str(root / argv[0]) if '/' in argv[0] or '\\' in argv[0] else argv[0]
        executable = shutil.which(target)
        if not executable or Path(executable).suffix.lower() in ('.bat', '.cmd'):
            raise ValueError('Native executable required; use node.exe plus the tsc/vitest/vite entrypoint, or an explicit cmd.exe command')
        executable = str(Path(executable).resolve())
        telemetry = os.environ.get('BOUNDED_MSVC_TELEMETRY_EXE')
        if telemetry is not None:
            path = Path(telemetry)
            if not path.is_absolute() or path.name.lower() != 'vctip.exe' or not path.is_file():
                raise ValueError('MSVC telemetry authorization must be an existing absolute vctip.exe path')
            telemetry = os.path.normcase(os.path.normpath(str(path)))
        free, disk = resources(root)
        allowed = disk >= DISK_RESERVE
        emit('gate', allowed=allowed, capGiB=cap_gib, timeoutSeconds=timeout, freeGiB=round(free / GIB, 3), diskFreeGiB=round(disk / GIB, 3), diskFloorGiB=DISK_RESERVE / GIB)
        if not allowed:
            raise RuntimeError('Startup disk gate refused; no retry or unbounded fallback')

        job = check(create_job(None, None), 'Create private non-inheritable Job')
        handles.append(job)
        limits = Limits()
        flags = 0x2000 | (0x200 if cap is not None else 0)  # KILL_ON_JOB_CLOSE, optional JOB_MEMORY; no breakaway.
        limits.basic.flags, limits.jobMemory = flags, cap or 0
        check(set_job(job, 9, c.byref(limits), c.sizeof(limits)), 'Set whole-Job custody and memory policy')
        check(query_job(job, 9, c.byref(limits), c.sizeof(limits), None), 'Verify Job custody and memory policy')
        if limits.basic.flags != flags or limits.jobMemory != (cap or 0):
            raise RuntimeError('Job commit/custody policy verification failed')
        port = check(create_port(H(-1), None, 0, 1), 'Create Job completion port')
        handles.append(port)
        completion = Completion(1, port)
        check(set_job(job, 7, c.byref(completion), c.sizeof(completion)), 'Associate Job completion port')

        # Duplicate only standard streams; never inherit the Job or inspect argv/env secrets.
        stdio = []
        for number in (-10, -11, -12):
            handle = H()
            check(duplicate(current_process(), std_handle(number), current_process(), c.byref(handle), 0, True, 2), 'Duplicate inherited standard stream')
            handles.append(handle.value)
            stdio.append(handle.value)
        size = S()
        init_attributes(None, 2, 0, c.byref(size))
        if not size.value:
            raise OSError(c.get_last_error(), 'Size process attributes')
        storage = c.create_string_buffer(size.value)
        check(init_attributes(storage, 2, 0, c.byref(size)), 'Initialize process attributes')
        attributes = storage
        jobs, streams = (H * 1)(job), (H * 3)(*stdio)
        check(update_attribute(storage, 0, 0x2000D, jobs, c.sizeof(jobs), None, None), 'Atomic JOB_LIST')
        check(update_attribute(storage, 0, 0x20002, streams, c.sizeof(streams), None, None), 'Standard-stream HANDLE_LIST')
        startup = StartupEx()
        startup.startup.cb, startup.startup.flags = c.sizeof(startup), 0x100
        startup.startup.stdin, startup.startup.stdout, startup.startup.stderr = stdio
        startup.attributes = c.cast(storage, c.c_void_p)
        command = c.create_unicode_buffer(subprocess.list2cmdline([executable, *argv[1:]]))
        info = ProcessInfo()
        check(create_process(executable, command, None, None, True, 0x4 | 0x80000, None, str(root), c.byref(startup), c.byref(info)), 'Create suspended, atomically Job-bound command')
        handles.extend([info.process, info.thread])
        result['rootPid'] = info.pid
        owned = w.BOOL()
        check(in_job(info.process, job, c.byref(owned)), 'Verify exact suspended root Job ownership')
        if not owned.value or active(job) != 1:
            raise RuntimeError('Suspended root custody verification failed')
        free, disk = resources(root)
        if disk < DISK_RESERVE:
            raise RuntimeError('Pre-resume disk gate refused')
        if resume(info.thread) == 0xffffffff:
            raise OSError(c.get_last_error(), 'Resume owned command')
        result.update(status='running', started=True, rootJobOwned=True)
        emit('started', rootPid=info.pid, rootJobOwned=True, atomicJobList=True, commitHardLimitBytes=cap)
        started = time.monotonic()
        drained = False
        while True:
            free, disk = resources(root)
            reason = None
            while True:
                message, key, data = w.DWORD(), S(), c.c_void_p()
                if not get_packet(port, c.byref(message), c.byref(key), c.byref(data), 0):
                    if c.get_last_error() == 258:
                        break
                    raise OSError(c.get_last_error(), 'Observe Job limit notifications')
                if message.value in (9, 10):
                    reason = 'job-commit-limit'
            if disk < DISK_RESERVE:
                reason = 'disk-free-floor'
            if time.monotonic() - started >= timeout:
                reason = 'timeout'
            if reason:
                result['status'] = reason
                code = 124 if reason == 'timeout' else 125
                break
            if drained:
                break
            state = wait(info.process, 0)
            if state == 0:
                if 'commandExitCode' not in result:
                    terminal = w.DWORD()
                    check(exit_code(info.process, c.byref(terminal)), 'Read owned root exit code')
                    result.update(status='process-exit', commandExitCode=terminal.value)
                    code = terminal.value
                    emit('root-exit', rootPid=info.pid, commandExitCode=terminal.value, jobActive=active(job))
                if telemetry and reap_msvc_telemetry(job, telemetry):
                    continue  # Recheck resource/timeout notifications before accepting completion.
                if active(job) == 0:
                    drained = True
                    continue
            elif state != 258:
                raise OSError(c.get_last_error(), 'Wait owned root')
            time.sleep(0.25)
    except KeyboardInterrupt:
        result.update(status='interrupted')
        code = 130
    except Exception as error:
        if result['started']:
            result['status'] = 'guard-failure'
        result['error'] = f'{type(error).__name__}: {error}'
        code = 125
    finally:
        if job:
            try:
                if active(job):
                    check(terminate(job, 125), 'Terminate only this private Job')
                    result['forcedTermination'] = True
                    if result['status'] == 'process-exit' and code == 0:
                        result['status'], code = 'owned-descendants-stopped', 125
                deadline = time.monotonic() + 10
                result['jobActive'] = active(job)
                while result['jobActive'] and time.monotonic() < deadline:
                    time.sleep(0.05)
                    result['jobActive'] = active(job)
                if result['jobActive'] != 0:
                    raise RuntimeError('Owned Job did not drain; active=0 not proven')
                final_limits = Limits()
                check(query_job(job, 9, c.byref(final_limits), c.sizeof(final_limits), None), 'Read final Job commit peak')
                result['peakJobCommitGiB'] = round(final_limits.peakJobMemory / GIB, 3)
            except Exception as error:
                result.update(status='cleanup-failure', cleanupError=f'{type(error).__name__}: {error}')
                code = 125
        if attributes is not None:
            delete_attributes(attributes)
        for handle in reversed(handles):
            if not close(handle):
                result.update(status='cleanup-failure', closeError=c.get_last_error())
                code = 125
        if minimum_free is not None:
            result.update(minFreeGiB=round(minimum_free / GIB, 3), minDiskFreeGiB=round(minimum_disk / GIB, 3))
        result['exitCode'] = code
        emit('finish', **result)
    return code


if __name__ == '__main__':
    raise SystemExit(run())
