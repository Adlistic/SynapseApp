import sys, os
from PIL import Image
here = os.path.dirname(os.path.abspath(__file__))
names = sys.argv[1:]
cols = 2 if len(names) > 1 else 1
rows = (len(names) + cols - 1) // cols
W, H = 800, 450
sheet = Image.new("RGB", (W * cols, H * rows), "white")
for i, n in enumerate(names):
    im = Image.open(os.path.join(here, "raw", n + ".png")).convert("RGB").resize((W, H), Image.LANCZOS)
    sheet.paste(im, ((i % cols) * W, (i // cols) * H))
sheet.save(os.path.join(here, "raw", "_sheet.png"))
