from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
SIZE = 512
WHITE = (255, 255, 255, 255)


def canvas():
    return Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))


def save(im, name):
    im.resize((128, 128), Image.Resampling.LANCZOS).save(OUT / f"{name}.png")


def round_rect(draw, box, radius):
    draw.rounded_rectangle(box, radius=radius, fill=WHITE)


def triangle(draw, points):
    draw.polygon(points, fill=WHITE)


def play(im):
    d = ImageDraw.Draw(im)
    triangle(d, [(168, 96), (168, 416), (424, 256)])


def pause(im):
    d = ImageDraw.Draw(im)
    round_rect(d, (144, 96, 228, 416), 36)
    round_rect(d, (284, 96, 368, 416), 36)


def prev(im):
    d = ImageDraw.Draw(im)
    round_rect(d, (108, 96, 176, 416), 28)
    triangle(d, [(400, 96), (400, 416), (188, 256)])


def skip(im):
    d = ImageDraw.Draw(im)
    triangle(d, [(112, 96), (112, 416), (324, 256)])
    round_rect(d, (336, 96, 404, 416), 28)


def stop(im):
    d = ImageDraw.Draw(im)
    round_rect(d, (128, 128, 384, 384), 56)


def queue(im):
    d = ImageDraw.Draw(im)
    round_rect(d, (112, 132, 400, 188), 30)
    round_rect(d, (112, 226, 400, 282), 30)
    round_rect(d, (112, 320, 400, 376), 30)


def thick_line(draw, a, b, width):
    draw.line([a, b], fill=WHITE, width=width)


def arrow_head(draw, tip, direction, size=70):
    if direction == "up-right":
        triangle(draw, [tip, (tip[0] - size, tip[1] + 8), (tip[0] - 8, tip[1] + size)])
    elif direction == "down-right":
        triangle(draw, [tip, (tip[0] - size, tip[1] - 8), (tip[0] - 8, tip[1] - size)])


def shuffle(im):
    d = ImageDraw.Draw(im)
    w = 48
    thick_line(d, (96, 160), (230, 160), w)
    thick_line(d, (230, 160), (400, 360), w)
    arrow_head(d, (416, 376), "down-right")
    thick_line(d, (96, 352), (230, 352), w)
    thick_line(d, (230, 352), (400, 152), w)
    arrow_head(d, (416, 136), "up-right")


for name, fn in {
    "play": play,
    "pause": pause,
    "prev": prev,
    "skip": skip,
    "stop": stop,
    "queue": queue,
    "shuffle": shuffle,
}.items():
    im = canvas()
    fn(im)
    save(im, name)
    print("wrote", name)
