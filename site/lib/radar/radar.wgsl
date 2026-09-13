// kern signal radar — instrument, not ornament.
//
// A fullscreen fragment shader: engraved rings of dots, a true trailing
// sweep (intensity falls off with modular angular distance behind the
// beam), tick marks, a pulsing core, film grain, scanlines, and a vignette.
// The pointer nudges the whole instrument a fraction; nothing whips around.

struct Params {
  time: f32,
  resolution: vec2f,
  pointer: vec2f, // normalized 0..1, smoothed by the JS side
  quality: f32,   // 1 = high, 0 = low
  sweepSpeed: f32,
  gain: f32,
};

@group(0) @binding(0) var<uniform> params: Params;

const TAU: f32 = 6.28318530718;

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q = q + dot(q, q + 45.32);
  return fract(q.x * q.y);
}

// modular angular distance of `a` behind `sweep`, in [0, TAU)
fn behind(a: f32, sweep: f32) -> f32 {
  var d = sweep - a;
  return d - TAU * floor(d / TAU);
}

// trailing sector (falloff) + bright leading edge
fn sweepEnergy(a: f32, sweep: f32) -> f32 {
  let d = behind(a, sweep);
  let trail = TAU * 0.35;
  var sector = 0.0;
  if (d < trail) {
    let k = 1.0 - d / trail;
    sector = k * k;
  }
  let beam = exp(-d * d * 260.0);
  return sector * 0.35 + beam * 0.9;
}

// brightness of the nearest dot on a ring at `radius`
fn ringDots(
  p: vec2f,
  radius: f32,
  count: f32,
  dotR: f32,
  brightness: f32,
  t: f32,
) -> f32 {
  let r = length(p);
  let a = atan2(p.y, p.x);
  let step = TAU / count;
  let k = round(a / step);
  let nearest = k * step;
  var dAng = a - nearest;
  dAng = dAng - TAU * round(dAng / TAU); // wrap to [-PI, PI]
  let d = length(vec2f(r - radius, dAng * radius));
  let dot = smoothstep(dotR, 0.0, d);
  let w = 0.5 + 0.5 * sin(k / count * TAU + t * 0.6);
  return dot * brightness * (0.25 + 0.75 * w);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let res = params.resolution;
  let aspect = res.x / max(res.y, 1.0);

  // centered coords, y down; pointer parallax shifts the instrument slightly
  var p = (uv - 0.5) * vec2f(aspect, 1.0);
  p += (params.pointer - vec2f(0.5, 0.5)) * vec2f(0.018, 0.010);

  let r = length(p);
  let a = atan2(p.y, p.x);
  let t = params.time;
  let sweep = t * params.sweepSpeed;
  let energy = sweepEnergy(a, sweep);

  // palette (#4cf5a0 signal, #1f3a2c dim) and base (#050506)
  let G = vec3f(0.298, 0.961, 0.627);
  let DIM = vec3f(0.122, 0.227, 0.173);
  var col = vec3f(0.0196, 0.0196, 0.0235);

  // ambient bloom
  col += G * exp(-r * 3.2) * 0.10;

  // concentric rings of dots; low quality keeps the inner three
  var dots = 0.0;
  dots += ringDots(p, 0.18, 6.0, 0.009, 0.50, t);
  dots += ringDots(p, 0.30, 10.0, 0.008, 0.44, t);
  dots += ringDots(p, 0.42, 14.0, 0.007, 0.38, t);
  if (params.quality > 0.5) {
    dots += ringDots(p, 0.55, 18.0, 0.006, 0.32, t);
    dots += ringDots(p, 0.68, 22.0, 0.005, 0.26, t);
    dots += ringDots(p, 0.82, 26.0, 0.004, 0.20, t);
  }
  col += mix(DIM, G, energy) * dots * (0.35 + 0.65 * energy);

  // sweep beam — a thin bright spoke bleeding into the trail
  let beam = exp(-behind(a, sweep) * behind(a, sweep) * 260.0);
  col += G * beam * 0.30 * (1.0 - smoothstep(0.86, 0.92, r));

  // engraved tick marks on the outer ring (every 6 degrees)
  let tickBand =
    smoothstep(0.870, 0.878, r) - smoothstep(0.888, 0.896, r);
  let step6 = TAU / 60.0;
  let kt = round(a / step6);
  var dt = a - kt * step6;
  dt = dt - TAU * round(dt / TAU);
  let major = select(0.45, 1.0, fract(kt / 5.0) < 0.05);
  col += G * tickBand * smoothstep(0.0045, 0.0, abs(dt) * r) * major * 0.35;

  // core: a small glowing emitter with a halo ring
  col += G * exp(-r * r * 3200.0) * (0.8 + 0.2 * sin(t * 2.0));
  col += G * smoothstep(0.006, 0.0, abs(r - 0.062)) * 0.25;

  // film grain + scanlines (high quality only)
  if (params.quality > 0.5) {
    let g = (hash21(uv * res + fract(t)) - 0.5) * 0.035;
    col += vec3f(g);
    col *= 1.0 - 0.025 * (0.5 + 0.5 * sin(uv.y * res.y * 1.5));
  }

  // vignette + gain
  col *= 1.0 - smoothstep(0.55, 1.05, r);
  col *= params.gain;

  return vec4f(col, 1.0);
}
