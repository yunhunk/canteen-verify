"""验证 APK 内 arm64-v8a so 的 ELF LOAD 段 16KB 页对齐。
Android 15+ 要求 p_align >= 16384 (0x4000)。
"""
import struct
import sys
import zipfile


def check(apk_path: str) -> int:
    bad = 0
    print(f"== {apk_path}")
    with zipfile.ZipFile(apk_path) as z:
        # 压缩方式检查：useLegacyPackaging=false 时 so 应为 stored（未压缩）
        for info in z.infolist():
            if info.filename.endswith(".so") and "arm64-v8a" in info.filename:
                data = z.read(info.filename)
                if data[:4] != b"\x7fELF":
                    print(f"  {info.filename}: 非ELF，跳过")
                    continue
                phoff = struct.unpack_from("<Q", data, 0x20)[0]
                phentsize = struct.unpack_from("<H", data, 0x36)[0]
                phnum = struct.unpack_from("<H", data, 0x38)[0]
                load_aligns = []
                for i in range(phnum):
                    off = phoff + i * phentsize
                    p_type = struct.unpack_from("<I", data, off)[0]
                    p_align = struct.unpack_from("<Q", data, off + 0x30)[0]
                    if p_type == 1:  # PT_LOAD
                        load_aligns.append(p_align)
                ok = bool(load_aligns) and all(a >= 16384 for a in load_aligns)
                compress = "stored" if info.compress_type == 0 else "deflated"
                status = "16KB-ALIGNED" if ok else "UNALIGNED"
                if not ok:
                    bad += 1
                print(f"  {info.filename}: {status} load_align={[hex(a) for a in load_aligns]} pack={compress}")
    return bad


if __name__ == "__main__":
    total = 0
    for p in sys.argv[1:]:
        total += check(p)
    print(f"\nRESULT: {'ALL ALIGNED' if total == 0 else f'{total} UNALIGNED'}")
