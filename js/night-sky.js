/*
 * Night sky: a slowly turning star field with the Milky Way, softly
 * twinkling stars and the occasional meteor above a mountain horizon.
 * Everything is generated from a fixed seed, so the sky is the same on
 * every visit.
 *
 * Layers (see _includes/night-sky.html):
 *   .night-sky-bg     sky gradient and horizon glow, drawn on resize
 *   .night-sky-stars  Milky Way, stars and meteors, redrawn every frame
 *   .night-sky-land   mountain silhouettes, drawn on resize
 */
(function () {
    'use strict';

    var root = document.querySelector('[data-night-sky]');
    if (!root || !window.requestAnimationFrame) return;

    var bgCanvas = root.querySelector('.night-sky-bg');
    var starCanvas = root.querySelector('.night-sky-stars');
    var landCanvas = root.querySelector('.night-sky-land');
    var bgCtx = bgCanvas.getContext('2d');
    var starCtx = starCanvas.getContext('2d');
    var landCtx = landCanvas.getContext('2d');
    if (!bgCtx || !starCtx || !landCtx) return;

    var SEED = 20181214;
    var ROTATION_PERIOD = 3600;     // seconds per full turn of the sky
    var ADAPT_TIME = 5;             // seconds until the faintest stars have faded in
    var IDLE_FRAME = 1 / 30;        // redraw at ~30fps while no meteor is in flight
    var STAR_DENSITY = 1 / 1000;    // field stars per CSS px², before the small-screen boost
    var SPRITE_P = 0.62;            // stars brighter than this are drawn with a glow
    var LIVE_K = 0.45;              // fainter stars don't visibly twinkle and are cached
    var FIELD_MARGIN = 4;           // CSS px the cached stars may drift before a redraw
    var MW_TEXELS = 560;            // max resolution of the Milky Way texture
    var TRAIN_TIME = 0.6;           // seconds a meteor's train lingers after it burns out
    var MAX_PIXELS = 8.3e6;         // cap canvas backing stores at roughly 4K

    var STAR_COLORS = [
        { weight: 0.14, rgb: [175, 200, 255] },   // blue-white
        { weight: 0.40, rgb: [236, 241, 255] },   // white
        { weight: 0.28, rgb: [255, 246, 232] },   // warm white
        { weight: 0.12, rgb: [255, 226, 188] },   // yellow
        { weight: 0.06, rgb: [255, 198, 160] }    // orange
    ];

    var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var noise = createNoise(mulberry32(SEED));
    var mwCanvas = document.createElement('canvas');
    var fieldCanvas = document.createElement('canvas');
    var fieldCtx = fieldCanvas.getContext('2d');
    var mwGrid, mwSize, mwScale;
    var headSprite = makeHeadSprite();
    var starSprites = STAR_COLORS.map(function (c) {
        c.css = 'rgb(' + c.rgb.join(',') + ')';
        return makeStarSprite(c.rgb);
    });

    // Layout, rebuilt on resize. The sky turns around `pole`, which sits just
    // above the top edge; `R` is the radius the star field has to cover.
    var W = 0, H = 0, S, dpr, horizonY, skyFloor, pole, R, rMin, band, radiant, horizonFade;
    var faint = [], stars = [], sprites = [];
    var fieldPad, fieldAngle = null;

    var clock = reduceMotion ? 60 : 0;
    var angle = 0;
    var meteors = [];
    var nextMeteor = 2.5 + Math.random() * 2;

    /* ---------- helpers ---------- */

    function mulberry32(a) {
        return function () {
            a = (a + 0x6D2B79F5) | 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // 2D value noise in [0, 1].
    function createNoise(rand) {
        var perm = new Uint8Array(512);
        var values = new Float32Array(256);
        var i, j, t;
        for (i = 0; i < 256; i++) {
            perm[i] = i;
            values[i] = rand();
        }
        for (i = 255; i > 0; i--) {
            j = Math.floor(rand() * (i + 1));
            t = perm[i]; perm[i] = perm[j]; perm[j] = t;
        }
        for (i = 0; i < 256; i++) perm[i + 256] = perm[i];

        return function (x, y) {
            var xi = Math.floor(x), yi = Math.floor(y);
            var xf = x - xi, yf = y - yi;
            var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
            xi &= 255;
            yi &= 255;
            var a = values[perm[xi + perm[yi]]];
            var b = values[perm[xi + 1 + perm[yi]]];
            var c = values[perm[xi + perm[yi + 1]]];
            var d = values[perm[xi + 1 + perm[yi + 1]]];
            return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
        };
    }

    function fbm(x, y, octaves) {
        var sum = 0, amp = 0.5, norm = 0, t;
        for (var o = 0; o < octaves; o++) {
            sum += amp * noise(x, y);
            norm += amp;
            // rotate between octaves so the lattice doesn't show
            t = x;
            x = x * 1.6 - y * 1.2 + 17.3;
            y = t * 1.2 + y * 1.6 + 9.1;
            amp *= 0.5;
        }
        return sum / norm;
    }

    function clamp01(v) {
        return v < 0 ? 0 : v > 1 ? 1 : v;
    }

    function smooth(e0, e1, v) {
        var t = clamp01((v - e0) / (e1 - e0));
        return t * t * (3 - 2 * t);
    }

    function sq(v) {
        return v * v;
    }

    function rgba(rgb, a) {
        return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')';
    }

    function sizeCanvas(canvas, scale) {
        canvas.width = Math.round(W * scale);
        canvas.height = Math.round(H * scale);
    }

    /* ---------- sprites ---------- */

    // Pinpoint core with a soft halo, tinted by the star's colour.
    function makeStarSprite(rgb) {
        var size = 64, c = document.createElement('canvas');
        c.width = c.height = size;
        var ctx = c.getContext('2d');
        var img = ctx.createImageData(size, size), data = img.data;
        for (var y = 0; y < size; y++) {
            for (var x = 0; x < size; x++) {
                var d = Math.sqrt(sq(x + 0.5 - size / 2) + sq(y + 0.5 - size / 2)) / (size / 2);
                if (d >= 1) continue;
                var core = Math.exp(-sq(d / 0.09));
                var glow = 0.4 * Math.exp(-sq(d / 0.24));
                var halo = 0.1 * Math.pow(1 - d, 4);
                var i = (y * size + x) * 4;
                data[i] = rgb[0] + (255 - rgb[0]) * core;
                data[i + 1] = rgb[1] + (255 - rgb[1]) * core;
                data[i + 2] = rgb[2] + (255 - rgb[2]) * core;
                data[i + 3] = 255 * Math.min(1, core + glow + halo);
            }
        }
        ctx.putImageData(img, 0, 0);
        return c;
    }

    function makeHeadSprite() {
        var size = 32, c = document.createElement('canvas');
        c.width = c.height = size;
        var ctx = c.getContext('2d');
        var g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.18, 'rgba(225,235,255,0.75)');
        g.addColorStop(0.45, 'rgba(150,180,255,0.18)');
        g.addColorStop(1, 'rgba(120,150,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return c;
    }

    // A faint static grain over everything, which hides banding in the dark gradients.
    function makeGrain() {
        var size = 128, c = document.createElement('canvas');
        c.width = c.height = size;
        var ctx = c.getContext('2d');
        var img = ctx.createImageData(size, size), data = img.data;
        var rand = mulberry32(SEED + 1);
        for (var i = 0; i < data.length; i += 4) {
            var v = rand() < 0.5 ? 0 : 255;
            data[i] = data[i + 1] = data[i + 2] = v;
            data[i + 3] = rand() * 9;
        }
        ctx.putImageData(img, 0, 0);
        root.style.setProperty('--night-sky-grain', 'url(' + c.toDataURL() + ')');
    }

    /* ---------- layout ---------- */

    function build() {
        var w = root.clientWidth, h = root.clientHeight;
        if (!w || !h) return false;
        W = w;
        H = h;
        S = Math.max(W, H);
        dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (W * H)));
        horizonY = H * (W < H ? 0.84 : 0.8);

        sizeCanvas(bgCanvas, 1);
        sizeCanvas(starCanvas, dpr);
        sizeCanvas(landCanvas, dpr);
        root.style.setProperty('--night-sky-grain-size', (128 / Math.max(1, dpr)) + 'px');

        drawLand();
        drawBackground();

        // Only the part of the sky above the lowest gap in the mountains can
        // ever be seen, so the star field covers the ring between rMin and R.
        pole = { x: W * 0.78, y: -H * 0.12 };
        R = Math.max(
            Math.hypot(pole.x, skyFloor - pole.y),
            Math.hypot(W - pole.x, skyFloor - pole.y),
            Math.hypot(pole.x, pole.y),
            Math.hypot(W - pole.x, pole.y)
        );
        rMin = Math.hypot(
            Math.max(-pole.x, 0, pole.x - W),
            Math.max(-pole.y, 0, pole.y - skyFloor)
        );

        // The Milky Way rises from the horizon on the left, where its bright
        // core sits half hidden behind the mountains, and arcs up to the right.
        var a = { x: W * 0.16, y: horizonY * 1.02 };
        var b = { x: W * 0.92, y: -H * 0.05 };
        var len = Math.hypot(b.x - a.x, b.y - a.y);
        band = { x: a.x - pole.x, y: a.y - pole.y, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len };

        radiant = { x: -W * 0.1, y: -H * 0.45 };

        horizonFade = starCtx.createLinearGradient(0, horizonY * 0.45, 0, horizonY);
        horizonFade.addColorStop(0, 'rgba(0,0,0,0)');
        horizonFade.addColorStop(1, 'rgba(0,0,0,0.6)');

        fieldPad = Math.ceil(FIELD_MARGIN * dpr) / dpr;
        fieldCanvas.width = Math.round((W + 2 * fieldPad) * dpr);
        fieldCanvas.height = Math.round((skyFloor + 2 * fieldPad) * dpr);
        fieldAngle = null;

        buildMilkyWay();
        buildStars();
        return true;
    }

    function drawBackground() {
        var ctx = bgCtx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        var hz = horizonY / H;
        var g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, '#020309');
        g.addColorStop(hz * 0.45, '#060818');
        g.addColorStop(hz * 0.8, '#0d0f27');
        g.addColorStop(hz, '#1c1b3c');
        g.addColorStop(1, '#1c1b3c');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);

        // Airglow along the horizon, a little stronger to the right.
        glow(ctx, W * 0.64, horizonY, W * 0.75, 0.3, [84, 70, 150], 0.24);
        glow(ctx, W * 0.12, horizonY, W * 0.45, 0.28, [130, 84, 128], 0.12);
    }

    function glow(ctx, x, y, r, squash, rgb, a) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1, squash);
        var g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
        g.addColorStop(0, rgba(rgb, a));
        g.addColorStop(0.5, rgba(rgb, a * 0.35));
        g.addColorStop(1, rgba(rgb, 0));
        ctx.fillStyle = g;
        ctx.fillRect(-r, -r, 2 * r, 2 * r);
        ctx.restore();
    }

    function drawLand() {
        var ctx = landCtx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);

        var U = Math.min(H, W * 1.15);
        // A distant range with one lone volcano right of centre...
        var far = ridge(horizonY + U * 0.01, U * 0.13, 2.6, 13.7, function (t) {
            var d = t - 0.68;
            var cone = Math.exp(-Math.abs(d) / (d < 0 ? 0.1 : 0.075));
            return 0.3 + 0.25 * t + 0.95 * (0.65 * cone + 0.35 * Math.exp(-sq(d / 0.1)));
        });
        // ...and a nearer, darker one that rises towards both edges.
        var near = ridge(horizonY + U * 0.075, U * 0.09, 4.2, 71.3, function (t) {
            return 0.2 + 1.1 * Math.pow(Math.abs(2 * t - 1), 1.6);
        });

        skyFloor = 0;
        for (var i = 0; i < far.length; i++) {
            skyFloor = Math.max(skyFloor, Math.min(far[i], near[i]));
        }

        var top = horizonY - U * 0.13;
        var g = ctx.createLinearGradient(0, top, 0, horizonY + U * 0.08);
        g.addColorStop(0, '#0e0d20');
        g.addColorStop(1, '#1d1b38');
        fillRidge(ctx, far, g);

        g = ctx.createLinearGradient(0, horizonY, 0, H);
        g.addColorStop(0, '#07060f');
        g.addColorStop(1, '#030307');
        fillRidge(ctx, near, g);
        drawTrees(ctx, near, U);
    }

    // Clumps of small conifers along the near ridge, for a sense of scale.
    function drawTrees(ctx, ys, U) {
        var rand = mulberry32(SEED + 3);
        var unit = U / 900;
        ctx.fillStyle = '#07060f';
        ctx.beginPath();
        for (var x = 0; x < W; x += (2.5 + rand() * 4) * unit) {
            var clump = noise(x / S * 9 + 5.3, 41.7);
            if (clump < 0.52) continue;
            var y = ys[Math.round(x / 3)] + 1;
            var h = (4 + rand() * 9) * unit * (0.6 + clump);
            var w = h * (0.28 + rand() * 0.12);
            ctx.moveTo(x - w / 2, y);
            ctx.lineTo(x - w * 0.18, y - h * 0.45);
            ctx.lineTo(x - w * 0.34, y - h * 0.45);
            ctx.lineTo(x, y - h);
            ctx.lineTo(x + w * 0.34, y - h * 0.45);
            ctx.lineTo(x + w * 0.18, y - h * 0.45);
            ctx.lineTo(x + w / 2, y);
            ctx.closePath();
        }
        ctx.fill();
    }

    function ridge(base, amp, freq, offset, shape) {
        var n = Math.ceil(W / 3) + 1, ys = new Float32Array(n);
        for (var i = 0; i < n; i++) {
            var x = Math.min(i * 3, W);
            var h = 0, a = 0.5, norm = 0, f = freq;
            for (var o = 0; o < 8; o++) {
                // folded noise gives sharper crests than plain value noise
                h += a * (1 - Math.abs(2 * noise(x / S * f + offset, offset * 0.37 + o * 7.1) - 1));
                norm += a;
                a *= 0.55;
                f *= 2.03;
            }
            // plus fine crags that don't scale with the broad shape
            var crag = 1 - Math.abs(2 * noise(x / S * freq * 24 + offset, offset + 3.3) - 1);
            crag += 0.5 * (1 - Math.abs(2 * noise(x / S * freq * 61 + offset, offset + 8.8) - 1));
            ys[i] = base - amp * (shape(x / W) * (0.3 + 0.7 * smooth(0.25, 0.85, h / norm)) + 0.07 * crag);
        }
        return ys;
    }

    function fillRidge(ctx, ys, style) {
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (var i = 0; i < ys.length; i++) ctx.lineTo(Math.min(i * 3, W), ys[i]);
        ctx.lineTo(W, H);
        ctx.closePath();
        ctx.fillStyle = style;
        ctx.fill();
    }

    /* ---------- Milky Way ---------- */

    // Relative brightness of the Milky Way at (x, y), measured from the pole
    // in CSS px. Returns 0 well outside the band.
    function milkyWay(x, y) {
        var rx = x - band.x, ry = y - band.y;
        var along = (rx * band.dx + ry * band.dy) / S;
        var across = (ry * band.dx - rx * band.dy) / S;
        across += (noise(along * 1.4 + 3.7, 11.3) - 0.5) * 0.07;

        var core = Math.exp(-sq(along / 0.16));
        var width = 0.075 * (0.75 + 0.55 * noise(along * 1.1 + 8.2, 2.9)) * (1 + 0.7 * core);
        var profile = Math.exp(-0.5 * sq(across / width));
        if (profile < 0.005) return 0;

        var nx = x / S, ny = y / S;
        var clouds = smooth(0.25, 0.75, fbm(nx * 5 + 1.3, ny * 5 + 7.7, 5));
        var grain = fbm(nx * 22 + 4.1, ny * 22 + 2.2, 3);
        var glow = 0.35 + 0.65 * Math.exp(-sq(along / 0.75)) + 0.6 * core;

        // A dark rift of dust running along the band, strongest near the core.
        var riftAcross = across - width * 0.18 * (1 + noise(along * 2.3 + 1.1, 6.6));
        var rift = Math.exp(-0.5 * sq(riftAcross / (width * 0.32)));
        rift *= smooth(0.35, 0.62, fbm(nx * 7 + 2.2, ny * 7 + 5.5, 4));
        rift *= 0.35 + 0.65 * smooth(0.9, 0, along);

        return Math.max(0, profile * glow * (0.3 + 0.7 * clouds) * (0.75 + (grain - 0.5)) * (1 - 0.85 * rift));
    }

    function buildMilkyWay() {
        var size = Math.min(MW_TEXELS, Math.ceil(2 * R));
        var scale = size / (2 * R);
        var grid = new Float32Array(size * size);
        var max = 0, i, x, y;

        for (y = 0; y < size; y++) {
            for (x = 0; x < size; x++) {
                i = y * size + x;
                grid[i] = milkyWay((x + 0.5) / scale - R, (y + 0.5) / scale - R);
                if (grid[i] > max) max = grid[i];
            }
        }

        mwCanvas.width = mwCanvas.height = size;
        var ctx = mwCanvas.getContext('2d');
        var img = ctx.createImageData(size, size), data = img.data;
        for (i = 0; i < grid.length; i++) {
            var t = max ? grid[i] / max : 0;
            grid[i] = t;
            if (t <= 0) continue;
            // cool blue-grey at the edges, warmer towards the dense core
            var w = Math.pow(t, 1.4);
            data[i * 4] = 88 + 144 * w;
            data[i * 4 + 1] = 104 + 112 * w;
            data[i * 4 + 2] = 170 + 28 * w;
            data[i * 4 + 3] = 255 * 0.36 * Math.pow(t, 1.1);
        }
        ctx.putImageData(img, 0, 0);

        mwGrid = grid;
        mwSize = size;
        mwScale = scale;
    }

    /* ---------- stars ---------- */

    function buildStars() {
        var rand = mulberry32(SEED + 2);
        var ring = Math.PI * (R * R - rMin * rMin);
        var boost = Math.min(1.8, Math.max(1, Math.sqrt(2e6 / (W * skyFloor))));
        var count = Math.round(STAR_DENSITY * boost * ring);
        var i, r, t;

        faint = [];
        stars = [];
        sprites = [];

        for (i = 0; i < count; i++) {
            r = Math.sqrt(rMin * rMin + rand() * (R * R - rMin * rMin));
            t = rand() * Math.PI * 2;
            // Star counts grow roughly tenfold every two magnitudes, so
            // bright stars are rare and faint ones everywhere.
            addStar(r * Math.cos(t), r * Math.sin(t), Math.min(1, -Math.log(1 - rand()) / 6.735), rand);
        }

        // Faint stars crowding the Milky Way, sampled from its brightness.
        var extra = Math.round(count * 2), tries = extra * 80;
        while (extra > 0 && tries-- > 0) {
            var gx = Math.floor(rand() * mwSize), gy = Math.floor(rand() * mwSize);
            if (rand() >= mwGrid[gy * mwSize + gx]) continue;
            var x = (gx + rand()) / mwScale - R, y = (gy + rand()) / mwScale - R;
            var d = x * x + y * y;
            if (d > R * R || d < rMin * rMin) continue;
            addStar(x, y, rand() * rand() * 0.36, rand);
            extra--;
        }

        // Group by colour so drawing only switches fill style a few times a frame.
        faint.sort(byColor);
        stars.sort(byColor);
    }

    function byColor(a, b) {
        return a.c - b.c;
    }

    function addStar(x, y, p, rand) {
        var pick = rand(), c = 0;
        while (c < STAR_COLORS.length - 1 && pick > STAR_COLORS[c].weight) pick -= STAR_COLORS[c++].weight;

        var k = Math.min(p / SPRITE_P, 1);
        var star = {
            x: x,
            y: y,
            c: c,
            a: 0,
            s: 0,
            r: 0,
            delay: 0.2 + (1 - k) * 2.6 + rand() * 0.5,
            twinkle: 0.05 + 0.3 * k,
            f1: 1.1 + rand() * 2.2,
            f2: 3.5 + rand() * 5,
            p1: rand() * 6.283,
            p2: rand() * 6.283
        };

        if (p >= SPRITE_P) {
            var q = (p - SPRITE_P) / (1 - SPRITE_P);
            star.r = 3.5 + 8 * Math.pow(q, 1.3);
            star.a = 0.8 + 0.2 * q;
            sprites.push(star);
        } else {
            star.s = (1 + 1.2 * Math.pow(k, 1.6)) / dpr;
            star.a = 0.14 + 0.86 * Math.pow(k, 0.85);
            if (k < LIVE_K) {
                star.twinkle = 0;
                faint.push(star);
            } else {
                stars.push(star);
            }
        }
    }

    // Stars dim and twinkle more as they sink towards the horizon.
    function starAlpha(st, sy) {
        var alt = clamp01((horizonY - sy) / (horizonY * 0.45));
        var a = st.a * (0.3 + 0.7 * alt * (2 - alt));
        if (st.twinkle && !reduceMotion) {
            a *= 1 + st.twinkle * (1.5 - 0.7 * alt) * Math.sin(clock * st.f1 + st.p1) * Math.sin(clock * st.f2 + st.p2);
        }
        if (clock < ADAPT_TIME) a *= clamp01((clock - st.delay) / 1.4);
        return a > 1 ? 1 : a;
    }

    function drawDots(ctx, list, cos, sin, pad) {
        var group = -1, i, st, sx, sy, a;

        for (i = 0; i < list.length; i++) {
            st = list[i];
            sx = pole.x + st.x * cos - st.y * sin;
            if (sx < -pad || sx > W + pad) continue;
            sy = pole.y + st.x * sin + st.y * cos;
            if (sy < -pad || sy > skyFloor + pad) continue;
            a = starAlpha(st, sy);
            if (a < 0.01) continue;
            if (st.c !== group) {
                group = st.c;
                ctx.fillStyle = STAR_COLORS[group].css;
            }
            ctx.globalAlpha = a;
            ctx.fillRect(sx - st.s / 2, sy - st.s / 2, st.s, st.s);
        }
    }

    function drawSprites(ctx, cos, sin) {
        var i, st, sx, sy, a;

        for (i = 0; i < sprites.length; i++) {
            st = sprites[i];
            sx = pole.x + st.x * cos - st.y * sin;
            if (sx < -st.r || sx > W + st.r) continue;
            sy = pole.y + st.x * sin + st.y * cos;
            if (sy < -st.r || sy > skyFloor + st.r) continue;
            a = starAlpha(st, sy);
            if (a < 0.01) continue;
            ctx.globalAlpha = a;
            ctx.drawImage(starSprites[st.c], sx - st.r, sy - st.r, st.r * 2, st.r * 2);
        }
    }

    /* ---------- meteors ---------- */

    function spawnMeteor(delay) {
        var fireball = Math.random() < 0.06;
        var x = W * (0.08 + Math.random() * 0.84);
        var y = horizonY * (0.05 + Math.random() * 0.45);
        // Most meteors stream away from a common radiant, like a shower.
        var dir = Math.atan2(y - radiant.y, x - radiant.x) + (Math.random() - 0.5) * 0.35;

        meteors.push({
            x: x,
            y: y,
            dx: Math.cos(dir),
            dy: Math.sin(dir),
            age: -(delay || 0),
            dur: fireball ? 1.4 + Math.random() * 0.5 : 0.45 + Math.random() * 0.55,
            speed: S * (fireball ? 0.3 : 0.4 + Math.random() * 0.35),
            len: S * (fireball ? 0.16 : 0.07 + Math.random() * 0.06),
            peak: fireball ? 1 : 0.55 + Math.random() * 0.4,
            width: fireball ? 1.6 : 0.9 + Math.random() * 0.4,
            tint: fireball ? [185, 245, 220] : [185, 210, 255]
        });

        // Now and then a second one follows close behind.
        if (!delay && !fireball && Math.random() < 0.15) spawnMeteor(0.4 + Math.random() * 0.9);
    }

    function drawMeteor(ctx, m) {
        if (m.age < 0) return;
        var p = m.age / m.dur, env, dist, len, alpha, width;

        if (p < 1) {
            // flares up quickly, peaks late, then burns out
            env = p < 0.7 ? Math.sin(p / 0.7 * Math.PI / 2) : Math.cos((p - 0.7) / 0.3 * Math.PI / 2);
            dist = m.speed * m.age;
            len = Math.min(dist, m.len * (0.5 + 0.5 * env));
            alpha = env * m.peak;
            width = m.width * (0.5 + 0.5 * env);
        } else {
            // the faint ionised train left behind, fading in place
            var q = (m.age - m.dur) / TRAIN_TIME;
            env = 0;
            dist = m.speed * m.dur;
            len = m.len * 0.45;
            alpha = m.peak * 0.16 * sq(1 - q);
            width = m.width * 1.2;
        }
        if (alpha <= 0.005) return;

        var hx = m.x + m.dx * dist, hy = m.y + m.dy * dist;
        var tx = hx - m.dx * len, ty = hy - m.dy * len;

        ctx.globalAlpha = 1;
        taper(ctx, hx, hy, tx, ty, m.dx, m.dy, width * 3.5, m.tint, alpha * 0.12);
        taper(ctx, hx, hy, tx, ty, m.dx, m.dy, width, m.tint, alpha);

        if (env > 0) {
            var r = 2.5 + 3.5 * m.peak * env;
            ctx.globalAlpha = alpha;
            ctx.drawImage(headSprite, hx - r, hy - r, r * 2, r * 2);
        }
    }

    // A streak that narrows from the head to a point at the tail.
    function taper(ctx, hx, hy, tx, ty, dx, dy, w, rgb, a) {
        var g = ctx.createLinearGradient(hx, hy, tx, ty);
        g.addColorStop(0, rgba([245, 248, 255], a));
        g.addColorStop(0.2, rgba(rgb, a * 0.6));
        g.addColorStop(1, rgba(rgb, 0));
        var nx = -dy * w / 2, ny = dx * w / 2;
        ctx.beginPath();
        ctx.moveTo(hx + nx, hy + ny);
        ctx.lineTo(tx, ty);
        ctx.lineTo(hx - nx, hy - ny);
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();
    }

    /* ---------- frame ---------- */

    function render() {
        var ctx = starCtx;
        var cos = Math.cos(angle), sin = Math.sin(angle);

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, starCanvas.width, starCanvas.height);

        var mwAlpha = smooth(0.8, 4.5, clock);
        if (mwAlpha > 0) {
            ctx.globalAlpha = mwAlpha;
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.setTransform(dpr * cos, dpr * sin, -dpr * sin, dpr * cos, dpr * pole.x, dpr * pole.y);
            ctx.drawImage(mwCanvas, -R, -R, R * 2, R * 2);

            // thicker air near the horizon swallows the fainter light
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = horizonFade;
            ctx.fillRect(0, horizonY * 0.45, W, skyFloor - horizonY * 0.45);
            ctx.globalCompositeOperation = 'source-over';
        }

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (clock < ADAPT_TIME) {
            drawDots(ctx, faint, cos, sin, 2);
        } else {
            // The faint majority is drawn to a cached layer that is only
            // turned here, and redrawn once it has drifted a few pixels.
            if (fieldAngle === null || Math.abs(angle - fieldAngle) * R > FIELD_MARGIN) drawField();
            var d = angle - fieldAngle, dc = Math.cos(d), ds = Math.sin(d);
            ctx.globalAlpha = 1;
            ctx.setTransform(dpr * dc, dpr * ds, -dpr * ds, dpr * dc,
                dpr * (pole.x - pole.x * dc + pole.y * ds), dpr * (pole.y - pole.x * ds - pole.y * dc));
            ctx.drawImage(fieldCanvas, -fieldPad, -fieldPad, fieldCanvas.width / dpr, fieldCanvas.height / dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        drawDots(ctx, stars, cos, sin, 2);
        drawSprites(ctx, cos, sin);

        if (meteors.length) {
            ctx.globalCompositeOperation = 'lighter';
            for (var i = 0; i < meteors.length; i++) drawMeteor(ctx, meteors[i]);
            ctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = 1;
    }

    function drawField() {
        fieldCtx.setTransform(1, 0, 0, 1, 0, 0);
        fieldCtx.clearRect(0, 0, fieldCanvas.width, fieldCanvas.height);
        fieldCtx.setTransform(dpr, 0, 0, dpr, fieldPad * dpr, fieldPad * dpr);
        drawDots(fieldCtx, faint, Math.cos(angle), Math.sin(angle), fieldPad);
        fieldCtx.globalAlpha = 1;
        fieldAngle = angle;
    }

    function step(dt) {
        clock += dt;
        angle -= dt * 2 * Math.PI / ROTATION_PERIOD;

        if (clock >= nextMeteor) {
            spawnMeteor(0);
            nextMeteor = clock + 3 + Math.min(17, -Math.log(1 - Math.random()) * 7);
        }
        for (var i = meteors.length - 1; i >= 0; i--) {
            meteors[i].age += dt;
            if (meteors[i].age > meteors[i].dur + TRAIN_TIME) meteors.splice(i, 1);
        }
    }

    var last = 0, pending = 0;

    function frame(now) {
        requestAnimationFrame(frame);
        pending += last ? Math.min((now - last) / 1000, 0.1) : 0;
        last = now;
        // The sky itself moves slowly enough that 30fps is plenty.
        if (!meteors.length && clock > ADAPT_TIME && pending < IDLE_FRAME - 0.004) return;
        step(pending);
        pending = 0;
        render();
    }

    var resizeTimer;

    function onResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            if (root.clientWidth === W && root.clientHeight === H) return;
            if (build()) render();
        }, 150);
    }

    makeGrain();
    if (window.ResizeObserver) {
        new ResizeObserver(onResize).observe(root);
    } else {
        window.addEventListener('resize', onResize);
    }
    if (build()) {
        render();
        root.classList.add('is-ready');
        if (!reduceMotion) requestAnimationFrame(frame);
    }
})();
