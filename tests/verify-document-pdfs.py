"""Inspect generated UI downloads; never opens a real user workspace."""
from pathlib import Path
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pypdf import PdfReader

root = Path(sys.argv[1])
expected = {'A4': (595.2756, 841.8898), 'A3': (841.8898, 1190.5512), 'A5': (419.5276, 595.2756), 'Letter': (612, 792)}
results = []
for file in sorted(root.glob('*.pdf')):
    text = subprocess.check_output(['pdftotext', '-layout', str(file), '-'], stderr=subprocess.DEVNULL).decode('utf-8')
    compact = re.sub(r'\s+', '', text)
    reader = PdfReader(file)
    sizes = [(float(page.mediabox.width), float(page.mediabox.height)) for page in reader.pages]
    # A positioned ink/image page legitimately has no text. Inspect its graphics
    # as well, and render every page for the separate visual check.
    assert all((page.extract_text() or '').strip() or len(page.images) > 0 for page in reader.pages), (file.name, 'page has neither text nor an image')
    paper = next((paper for paper in expected if f'Rich-{paper}' in file.name), None)
    if paper:
        assert all(abs(w - expected[paper][0]) < .01 and abs(h - expected[paper][1]) < .01 for w, h in sizes), (file.name, sizes)
    if any(f'Rich-{paper}' in file.name for paper in ['A3', 'A5', 'Letter']):
        # The inline formula is a/b + sqrt(x). A missing SVG radical still
        # leaves searchable prose and an otherwise nonblank math PNG.
        atom = reader.pages[0].images[0].image.convert('RGBA')
        aw, ah = atom.size
        radical_ink = sum(1 for y in range(round(ah * .3), round(ah * .95))
                          for x in range(round(aw * .6), round(aw * .8))
                          if atom.getpixel((x, y))[3] > 128 and max(atom.getpixel((x, y))[:3]) < 180)
        assert radical_ink >= 15, (file.name, 'inline sqrt radical omitted', radical_ink)
        for row in range(1, 16):
            for col in range(1, 4):
                token = f'Row{row}column{col}:'
                assert compact.count(token) == 1, (file.name, token, compact.count(token))
        for line in range(1, 15):
            assert compact.count(f'constline{line}=') == 1, (file.name, line)
        assert compact.count(f'{paper}finalsentinel') == 1
        assert 'Hiddentogglecontentisincludedinexport.' in compact
    assert 'Taskitemcheckboxfor' not in compact, (file.name, 'accessibility-only label was painted')
    if 'Infinite-proof' in file.name or 'Infinite-wide' in file.name:
        assert len(reader.pages) >= 2 and all(abs(w - expected['A4'][0]) < .01 and abs(h - expected['A4'][1]) < .01 for w, h in sizes)
        for i in range(1, 46):
            assert compact.count(f'Infiniteparagraph{i}:') == 1, (file.name, i)
    if 'Rich-A4' in file.name:
        for i in range(1, 25):
            assert compact.count(f'A4continuation{i}:') == 1, (file.name, i)
    if 'Portable-research' in file.name:
        assert 'OriginalPDFpageone' in compact and 'OriginalPDFpagetwo' in compact
    bbox = ET.fromstring(subprocess.check_output(['pdftotext', '-bbox', str(file), '-'], stderr=subprocess.DEVNULL))
    ns = {'x': 'http://www.w3.org/1999/xhtml'}
    for page in bbox.findall('.//x:page', ns):
        width, height = float(page.attrib['width']), float(page.attrib['height'])
        for word in page.findall('.//x:word', ns):
            bounds = {key: float(value) for key, value in word.attrib.items()}
            assert bounds['xMin'] >= -.8 and bounds['yMin'] >= -.8 and bounds['xMax'] <= width + .8 and bounds['yMax'] <= height + .8, (file.name, word.text, bounds)
    results.append({'file': file.name, 'pages': len(reader.pages), 'dimensions': sizes,
                    'images': sum(len(page.images) for page in reader.pages), 'links': sum(len(page.get('/Annots', [])) for page in reader.pages),
                    'textCharacters': len(text), 'contentAssertions': True, 'allTextWithinPage': True})
    (root / (file.stem + '.txt')).write_text(text, encoding='utf-8')
(root / 'structural-results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print(json.dumps(results, indent=2))
