"""Build-only workaround for two missing qDNGUseXMP guards in pinned DNG SDK 1.7.1."""
import hashlib
from pathlib import Path
import sys

source, output = map(Path, sys.argv[1:])
data = source.read_bytes()
if hashlib.sha256(data).hexdigest() != '951cec3b4c9d903f140f298d782850e833b41527675743e68d35b01a03e8af64':
    raise RuntimeError('DNG SDK workaround requires the reviewed upstream source.')
text = data.decode()
start = text.index('\t\t// XMP.\n')
end = text.index('\t\t// IPTC.\n', start)
text = text[:start] + '#if qDNGUseXMP\n' + text[start:end] + '#endif\n' + text[end:]
start = text.index('void dng_jxl_decoder::ProcessXMPBox (')
end = text.index('void dng_jxl_decoder::ProcessBox (', start)
text = text[:start] + '#if qDNGUseXMP\n' + text[start:end] + '''#else
void dng_jxl_decoder::ProcessXMPBox (dng_host &, const std::vector<uint8> &) {}
#endif
''' + text[end:]
output.write_text(text)
