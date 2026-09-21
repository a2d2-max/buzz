"""Read the approved Notion credential into the parent process's private pipe."""
import ctypes
import sys

service = b"a2d2-notion-docs-sync"
account = b"notion-db-3ad62a7535ba8028935cde50d43e47a4"
security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
security.SecKeychainFindGenericPassword.argtypes = [
    ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32,
    ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32),
    ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
]
size, pointer = ctypes.c_uint32(), ctypes.c_void_p()
status = security.SecKeychainFindGenericPassword(
    None, len(service), service, len(account), account,
    ctypes.byref(size), ctypes.byref(pointer), None,
)
if status:
    sys.exit("Notion keychain read failed: " + str(status))
try:
    sys.stdout.buffer.write(ctypes.string_at(pointer, size.value))
finally:
    security.SecKeychainItemFreeContent(None, pointer)
