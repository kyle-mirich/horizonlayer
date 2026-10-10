"""Render captured demo stdout with reading pauses; never synthesize demo results."""

from pathlib import Path
import textwrap

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'docs' / 'assets'
transcript = (ASSETS / 'session-handoff.txt').read_text()
lines = transcript.strip().splitlines()
if not lines or not lines[0].startswith('HorizonLayer / recorded'):
    raise SystemExit('Capture npm run --silent demo:handoff before rendering')
if not lines[-1].startswith('PASS /'):
    raise SystemExit('Refusing to render an incomplete or failed demo')

font = None
for candidate in (
    '/System/Library/Fonts/Menlo.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
    'C:/Windows/Fonts/consola.ttf',
):
    if Path(candidate).exists():
        font = ImageFont.truetype(candidate, 22)
        break
if font is None:
    font = ImageFont.load_default(size=22)

session_a = lines.index('SESSION A / capture a decision')
session_b = lines.index('SESSION B / retrieve context in a fresh MCP process')
panels = [
    lines[session_a:session_a + 2],
    lines[session_a:session_b],
    lines[session_b:session_b + 3],
    lines[session_b:],
]
frames = []
for index, panel in enumerate(panels):
    frame = Image.new('RGB', (1200, 520), '#171d20')
    draw = ImageDraw.Draw(frame)
    draw.rounded_rectangle((18, 18, 1182, 502), radius=18, outline='#4c5557', width=2)
    draw.text((48, 44), 'HorizonLayer / session handoff', font=font, fill='#f0e7d6')
    draw.text((48, 82), 'Captured MCP output / reading pauses added', font=font, fill='#a5b0b0')
    draw.line((48, 125, 1152, 125), fill='#4c5557', width=1)
    y = 156
    for line in panel:
        color = '#d9b181' if line.startswith('SESSION') else '#e9e4da'
        if line.startswith('PASS /'):
            color = '#a9d7b9'
        for wrapped in textwrap.wrap(line, width=79) or ['']:
            draw.text((48, y), wrapped, font=font, fill=color)
            y += 31
    if y > 455:
        raise SystemExit('Transcript exceeds the frame: adjust layout before publishing')
    draw.text((48, 463), 'PostgreSQL 17 / scripted clients / no LLM', font=font, fill='#a5b0b0')
    draw.text((1080, 463), f'{index + 1}/4', font=font, fill='#a5b0b0')
    frames.append(frame)

frames[0].save(
    ASSETS / 'session-handoff.gif',
    save_all=True,
    append_images=frames[1:],
    duration=[2500, 4000, 4500, 6500],
    loop=0,
    optimize=True,
)

# Keep the accessible transcript next to the animation in sync with its source.
guide = ROOT / 'docs' / 'session-handoff.md'
before, rest = guide.read_text().split('```text\n', 1)
_, after = rest.split('```', 1)
guide.write_text(before + '```text\n' + transcript.rstrip() + '\n```' + after)
print('Rendered docs/assets/session-handoff.gif and refreshed the guide transcript')
