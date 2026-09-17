#!/usr/bin/env python3
"""Hourly host-side memory sync. Never force push or discard conflicts."""
import datetime
import fcntl
import os
from pathlib import Path
import subprocess
import sys

repo = Path(sys.argv[1])
state = Path(sys.argv[2])
state.mkdir(parents=True, exist_ok=True)
os.environ['GIT_TERMINAL_PROMPT'] = '0'
os.environ['GIT_EDITOR'] = 'true'
os.environ['GIT_MERGE_AUTOEDIT'] = 'no'


def log(message):
    stamp = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
    with (state / 'sync.log').open('a') as file:
        file.write(f'{stamp} {message}\n')
    print(message, flush=True)


def git(*args, check=True):
    result = subprocess.run(['/usr/bin/git', '-C', str(repo), *args],
                            capture_output=True, text=True, timeout=180)
    if check and result.returncode:
        # Do not write raw remote/authentication output to logs.
        raise RuntimeError(f'git {args[0]} failed (exit {result.returncode}); inspect repository manually')
    return result


def conflicts():
    return bool(git('ls-files', '-u').stdout.strip()) or any(
        Path(git('rev-parse', '--git-path', name).stdout.strip()).exists()
        for name in ('MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD')
    )


def stop(reason):
    (state / 'STOPPED').write_text(reason + '\n')
    log('STOPPED: ' + reason)
    return 2


def sync():
    if (state / 'STOPPED').exists():
        log('STOPPED: manual resolution required; no Git changes attempted')
        return 2
    os.chdir(repo)
    if conflicts():
        return stop('Unresolved Git operation/conflict. Preserve files and resolve manually.')
    stash_before = git('rev-parse', '--verify', 'refs/stash', check=False).stdout.strip()
    # Autostash protects dirty working files while pulling. On conflict Git
    # retains the stash; never pop/drop/reset automatically.
    pulled = git('pull', '--no-rebase', '--no-edit', '--autostash', check=False)
    stash_after = git('rev-parse', '--verify', 'refs/stash', check=False).stdout.strip()
    if conflicts() or stash_after != stash_before:
        return stop('Pull/autostash conflict; local files and Git stash preserved. Do not rerun until resolved.')
    if pulled.returncode:
        raise RuntimeError(f'git pull failed (exit {pulled.returncode}); no commit or push attempted')
    git('add', '-A')
    diff = git('diff', '--cached', '--quiet', check=False)
    if diff.returncode == 1:
        git('commit', '-m', 'Sync personal assistant memory')
    elif diff.returncode:
        raise RuntimeError('Could not inspect staged changes; no commit or push attempted')
    git('push')  # normal push; a concurrent remote update safely rejects it
    log('OK: pull, commit if needed, push completed; HEAD=' + git('rev-parse', '--short', 'HEAD').stdout.strip())
    return 0


if __name__ == '__main__':
    with (state / 'sync.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log('SKIP: another sync is running')
            sys.exit(0)
        try:
            sys.exit(sync())
        except (RuntimeError, subprocess.TimeoutExpired, OSError) as exc:
            log('ERROR: ' + (str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__))
            sys.exit(1)
