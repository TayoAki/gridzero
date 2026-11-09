"""Confine this process with Landlock and seccomp, for hosts where namespaces are
not allowed (Railway). Neither needs privileges, and neither can be undone.

Landlock limits files to the system libraries, the sandbox code and the workbook's
own folder, and blocks TCP. Seccomp refuses every other kind of network socket,
starting programs, and the calls that could get around Landlock. Any failure here
stops the process: running unconfined is never the fallback.
"""

import ctypes
import os
import platform
import struct

_libc = ctypes.CDLL(None, use_errno=True)
_libc.syscall.restype = ctypes.c_long

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
SYS_SECCOMP = 317

# Landlock filesystem rights, in the order the kernel added them.
EXECUTE, WRITE_FILE, READ_FILE, READ_DIR, REMOVE_DIR, REMOVE_FILE = 1, 2, 4, 8, 16, 32
MAKE_CHAR, MAKE_DIR, MAKE_REG, MAKE_SOCK, MAKE_FIFO, MAKE_BLOCK, MAKE_SYM = 64, 128, 256, 512, 1024, 2048, 4096
REFER, TRUNCATE, IOCTL_DEV = 8192, 16384, 32768

READ_ONLY = EXECUTE | READ_FILE | READ_DIR
READ_WRITE = READ_FILE | READ_DIR | WRITE_FILE | REMOVE_DIR | REMOVE_FILE | MAKE_DIR | MAKE_REG | TRUNCATE
FILE_RIGHTS = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV

# x86-64 calls that are refused outright.
DENIED = [
    59, 322,  # execve, execveat
    101, 310, 311, 440, 438,  # ptrace, process_vm_*, process_madvise, pidfd_getfd
    165, 166, 155, 161, 272, 308,  # mount, umount2, pivot_root, chroot, unshare, setns
    175, 176, 313, 246, 320, 169, 167, 168,  # modules, kexec, reboot, swap
    321, 298, 323,  # bpf, perf_event_open, userfaultfd
    425, 426, 427,  # io_uring, which would bypass these filters
    248, 249, 250,  # kernel keyring
    303, 304,  # file handles, which would bypass Landlock
]
SYS_SOCKET = 41
AF_UNIX = 1
ARCH_X86_64 = 0xC000003E
EPERM = 1


def _call(*args):
    result = _libc.syscall(*args)
    if result < 0:
        raise OSError(ctypes.get_errno(), f"syscall {args[0]} failed")
    return result


def _allow(ruleset, path, rights):
    try:
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    except FileNotFoundError:
        return
    try:
        if not os.path.isdir(path):
            rights &= FILE_RIGHTS
        # struct landlock_path_beneath_attr is packed: u64 rights, s32 fd.
        attr = ctypes.create_string_buffer(struct.pack("=Qi", rights, fd))
        _call(SYS_LANDLOCK_ADD_RULE, ruleset, 1, attr, 0)
    finally:
        os.close(fd)


def _landlock(work_dir):
    abi = _call(SYS_LANDLOCK_CREATE_RULESET, None, 0, 1)
    if abi < 4:
        raise OSError(f"Landlock version {abi} cannot restrict networking")
    handled = (1 << 14) - 1  # through REFER (version 2)
    handled |= TRUNCATE
    if abi >= 5:
        handled |= IOCTL_DEV
    # Handled with no rules means nothing is allowed: no TCP at all.
    fields = [handled, 1 | 2]
    if abi >= 6:
        fields.append(1 | 2)  # no abstract sockets or signals outside this process
    attr = ctypes.create_string_buffer(struct.pack(f"={len(fields)}Q", *fields))
    ruleset = _call(SYS_LANDLOCK_CREATE_RULESET, attr, len(attr.raw), 0)
    here = os.path.dirname(os.path.abspath(__file__))
    for path in ("/usr", "/bin", "/lib", "/lib64", "/etc/ssl", here, os.path.realpath(here), f"/proc/{os.getpid()}"):
        _allow(ruleset, path, READ_ONLY)
    for path in ("/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"):
        _allow(ruleset, path, READ_FILE | WRITE_FILE)
    _allow(ruleset, work_dir, READ_WRITE)
    _call(SYS_LANDLOCK_RESTRICT_SELF, ruleset, 0)
    os.close(ruleset)


def _filter(code, jt=0, jf=0, k=0):
    return struct.pack("=HBBI", code, jt, jf, k)


def _seccomp():
    if platform.machine() != "x86_64":
        raise OSError("The sandbox filter is only defined for x86-64")
    load = 0x20  # BPF_LD | BPF_W | BPF_ABS
    jeq = 0x15  # BPF_JMP | BPF_JEQ | BPF_K
    jge = 0x35  # BPF_JMP | BPF_JGE | BPF_K
    ret = 0x06  # BPF_RET | BPF_K
    allow = _filter(ret, k=0x7FFF0000)
    refuse = _filter(ret, k=0x00050000 | EPERM)
    kill = _filter(ret, k=0x80000000)
    program = [
        _filter(load, k=4),  # architecture
        _filter(jeq, 1, 0, ARCH_X86_64),
        kill,
        _filter(load, k=0),  # call number
        _filter(jge, 0, 1, 0x40000000),  # the x32 numbering
        refuse,
    ]
    for number in DENIED:
        program += [_filter(jeq, 0, 1, number), refuse]
    program += [
        _filter(jeq, 0, 4, SYS_SOCKET),
        _filter(load, k=16),  # first argument: the address family
        _filter(jeq, 0, 1, AF_UNIX),
        allow,
        refuse,
        allow,
    ]
    code = b"".join(program)

    class Program(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_char_p)]

    prog = Program(len(program), code)
    _call(SYS_SECCOMP, 1, 0, ctypes.byref(prog))


def apply(work_dir):
    PR_SET_DUMPABLE, PR_SET_NO_NEW_PRIVS = 4, 38
    if _libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 or _libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise OSError("prctl failed")
    _landlock(work_dir)
    _seccomp()
