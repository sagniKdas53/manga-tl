"""The E0 angle rule, shared by the scripts here (E2 ports it into the worker).

A region's angle is the length-weighted angle of its OCR line pieces. A piece shorter than
`min_chars` line-thicknesses doesn't vote. If the voters still disagree by more than `agree` degrees
once the one farthest from the rest is dropped, the region stays level; under `dead` degrees it
stays level. Angles are positive clockwise on the page (y runs down).
"""
import math

SETTLED = (5.0, 1.5, 6.0)  # dead band, minimum line in thicknesses, agreement (owner, 2026-10-09)


def fold90(a):
    """A line's direction, in [-90, 90)."""
    return ((a + 90) % 180) - 90


def axis_dev(a):
    """Deviation of a line direction from the nearest axis (0 or 90), in [-45, 45)."""
    return ((a + 45) % 90) - 45


def pieces(prov):
    """The OCR pieces of a region's ownership provenance, which comes in two shapes."""
    if not prov:
        return []
    if "fragments" in prov:
        return [f.get("provenance", f) for f in prov["fragments"]]
    return [prov]


def lines(prov):
    """Each piece's long edge: (direction in degrees, length, thickness, quad)."""
    out = []
    for f in pieces(prov):
        q = f.get("sourceQuad")
        if not q or len(q) != 4:
            continue
        e0 = (q[1][0] - q[0][0], q[1][1] - q[0][1])
        e1 = (q[2][0] - q[1][0], q[2][1] - q[1][1])
        l0, l1 = math.hypot(*e0), math.hypot(*e1)
        e, long_l, short_l = (e0, l0, l1) if l0 >= l1 else (e1, l1, l0)
        out.append((math.degrees(math.atan2(e[1], e[0])), long_l, max(short_l, 1e-6), q))
    return out


def votes(prov, min_chars):
    """(angle off level, length) for each piece long enough to vote."""
    ls = [(a, l) for a, l, t, _ in lines(prov) if l >= min_chars * t]
    devs = [axis_dev(a) for a, _ in ls]
    # A piece's angle off the nearest axis lies in [-45, 45), so text near 45° reads +44 on one
    # piece and -44 on the next, and the region stayed level (#265). Past 35° every piece is read
    # as a line of text along its long edge instead. That assumes horizontal lines: a vertical
    # column tilted this far would read about 90° off, and E2 has to keep that in mind.
    if any(abs(d) > 35 for d in devs):
        devs = [fold90(a) for a, _ in ls]
    return [(d, l) for d, (_, l) in zip(devs, ls)]


def rule(prov, dead=SETTLED[0], min_chars=SETTLED[1], agree=SETTLED[2]):
    """(angle, why): the angle to set, 0.0 when the region stays level."""
    vs = votes(prov, min_chars)
    if not vs:
        return 0.0, "no long piece"
    # Line directions wrap at ±90 (−89° and +89° are 2° apart): unwrap them around the voter
    # closest, by length, to all the others before comparing or averaging (CodeRabbit on #255).
    gap = lambda a, b: abs(((a - b + 90) % 180) - 90)
    centre = min(vs, key=lambda c: sum(l * gap(c[0], d) for d, l in vs))[0]
    vs = [(centre + ((d - centre + 90) % 180) - 90, l) for d, l in vs]
    spread =lambda v: max(d for d, _ in v) - min(d for d, _ in v)
    if spread(vs) > agree and len(vs) >= 3:
        # One stray piece (a short column, a misread) kept a whole tilted bubble level (#266):
        # drop the piece farthest from the length-weighted median, once, and check again.
        total, acc = sum(l for _, l in vs), 0.0
        for d, l in sorted(vs):
            acc += l
            if acc >= total / 2:
                median = d
                break
        far = max(vs, key=lambda v: abs(v[0] - median))
        vs = [v for v in vs if v is not far]
    if spread(vs) > agree:
        return 0.0, "pieces disagree"
    a = fold90(sum(d * l for d, l in vs) / sum(l for _, l in vs))
    return (0.0, "dead band") if abs(a) < dead else (a, "turned")
