// @ts-check
/**
 * 内置 GLSL 壁纸预设（WebGL 1 / GLSL ES 1.00，不依赖纹理或外部资源）。
 *
 * uniform 是固定白名单：u_time / u_resolution / u_brightness / u_speed /
 * u_intensity / u_depth / u_mouse。片元着色器本身没有文件、网络能力，
 * 用户自定义源码只在本机桌面层窗口里编译，编译失败会如实显示日志。
 */
export const VERTEX_SHADER = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const COMMON = `
precision mediump float;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_time;
uniform float u_brightness;
uniform float u_speed;
uniform float u_intensity;
uniform float u_depth;
`;

/** 预设 id 必须稳定：用户的壁纸配置里存的是 id，不能随版本改名 */
export const SHADER_PRESETS = [
  {
    id: 'plasma',
    name: '等离子（经典彩色流动）',
    source: COMMON + `
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * (0.25 + u_speed * 0.35);
  float v = sin(uv.x * 8.0 + t)
          + sin(uv.y * 7.0 - t * 1.3)
          + sin((uv.x + uv.y) * 9.0 + t * 0.7)
          + sin(length(uv - 0.5) * 14.0 - t * 1.7);
  v *= 0.25 * u_intensity;
  vec3 col = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + v * 3.14159 + u_mouse.x);
  col = mix(col, vec3(dot(col, vec3(0.3333))), u_depth * 0.45);
  gl_FragColor = vec4(col * u_brightness, 1.0);
}
`,
  },
  {
    id: 'waves',
    name: '水波（层叠水平条纹）',
    source: COMMON + `
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * (0.2 + u_speed * 0.4);
  float acc = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float y = uv.y + sin(uv.x * (3.0 + fi) + t + fi * 1.7) * 0.035 * (1.0 + u_intensity);
    acc += 0.5 + 0.5 * cos((y * (7.0 + fi * 3.0) - t * 0.4 + fi) * 6.2831);
  }
  acc /= 5.0;
  vec3 col = mix(vec3(0.04, 0.10, 0.24), vec3(0.20, 0.75, 0.95), acc);
  col += u_depth * 0.12 * sin((uv.x + uv.y) * 30.0 + t);
  gl_FragColor = vec4(col * u_brightness, 1.0);
}
`,
  },
  {
    id: 'aurora',
    name: '极光（竖向柔和光幕）',
    source: COMMON + `
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * (0.12 + u_speed * 0.22);
  float band = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float x = uv.x * 3.0 + fi * 1.9 + t;
    float w = sin(x) * 0.12 + sin(x * 2.3 + t * 0.7) * 0.06;
    float d = abs(uv.y - (0.30 + 0.13 * fi + w));
    band += 0.018 / (d + 0.035) * (0.4 + u_intensity * 0.6);
  }
  vec3 col = vec3(0.02, 0.05, 0.10) + band * vec3(0.25, 0.95, 0.62);
  col += vec3(0.03, 0.01, 0.09) * (1.0 - uv.y) * (1.0 - u_depth * 0.5);
  gl_FragColor = vec4(col * u_brightness, 1.0);
}
`,
  },
  {
    id: 'stars',
    name: '星场（缓慢漂移的星点）',
    source: COMMON + `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * (0.05 + u_speed * 0.12);
  vec2 grid = floor((uv + vec2(t * 0.02, t * 0.008)) * 90.0);
  float h = hash(grid);
  float star = step(0.985 - u_intensity * 0.02, h);
  float twinkle = 0.55 + 0.45 * sin(u_time * (1.0 + h * 4.0) + h * 20.0);
  vec2 cell = fract((uv + vec2(t * 0.02, t * 0.008)) * 90.0) - 0.5;
  float glow = star * smoothstep(0.28, 0.0, length(cell)) * twinkle;
  vec3 col = vec3(0.01, 0.015, 0.04) + glow * vec3(1.0, 0.95, 0.85);
  col += vec3(0.05, 0.02, 0.12) * (1.0 - length(uv - u_mouse) ) * u_depth;
  gl_FragColor = vec4(col * u_brightness, 1.0);
}
`,
  },
];

export const MAX_SHADER_SOURCE = 12000;

export function shaderPresetList() {
  // 下发源码：桌面层窗口直接用它编译，避免为拿一段 GLSL 再发一次请求
  return SHADER_PRESETS.map(({ id, name, source }) => ({ id, name, source }));
}

export function shaderPresetSource(id) {
  return SHADER_PRESETS.find((p) => p.id === id)?.source || SHADER_PRESETS[0].source;
}
