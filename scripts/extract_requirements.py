"""Read the Word 97 piece table; leave the supplied .doc untouched."""
from pathlib import Path
import struct
import sys
import olefile

root = Path(__file__).resolve().parents[1]
source = next(root.glob('*.doc'))
with olefile.OleFileIO(source) as ole:
    word = ole.openstream('WordDocument').read()
    flags = struct.unpack_from('<H', word, 10)[0]
    table = ole.openstream('1Table' if flags & 0x200 else '0Table').read()
    offset, size = struct.unpack_from('<II', word, 0x1A2)
    clx = table[offset:offset + size]
    cursor = 0
    while clx[cursor] == 1:
        cursor += 3 + struct.unpack_from('<H', clx, cursor + 1)[0]
    assert clx[cursor] == 2, 'Unsupported Word piece table'
    length = struct.unpack_from('<I', clx, cursor + 1)[0]
    pieces = clx[cursor + 5:cursor + 5 + length]
    count = (length - 4) // 12
    positions = struct.unpack_from(f'<{count + 1}I', pieces)
    result = []
    for i in range(count):
        fc = struct.unpack_from('<I', pieces, 4 * (count + 1) + i * 8 + 2)[0]
        compressed = bool(fc & 0x40000000)
        start = fc & 0x3FFFFFFF
        n = positions[i + 1] - positions[i]
        if compressed:
            start //= 2
            result.append(word[start:start + n].decode('cp1252', errors='replace'))
        else:
            result.append(word[start:start + n * 2].decode('utf-16-le', errors='replace'))
text = ''.join(result).replace('\r', '\n').replace('\x07', '\t')
(root / 'docs' / '需求原文.txt').write_text(text, encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
print(text)
