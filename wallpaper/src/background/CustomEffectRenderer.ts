import * as THREE from 'three';
import type { Config } from '../core/Config';
import type { AudioEngine } from '../audio/AudioEngine';
import { evaluateSignal, evaluateTimeline, layerParameters, type CustomEffect, type EffectAudio, type LayerParameter, type ShaderTimeline } from './CustomEffects';

const vertexShader = 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
const header = `
varying vec2 vUv;
uniform float uTime, uProgress, uOpacity, uSongTime;
uniform vec2 uResolution;
uniform vec3 uBands, uPrimary, uAccent, uThird;
uniform float uAmplitude, uOnset;
const float PI=3.14159265359;
float hash(float n){return fract(sin(n*127.1+311.7)*43758.5453);}
`;
function layerShader(effect: CustomEffect): string {
  const declarations: string[] = [], operations: string[] = [];
  effect.layers!.forEach((layer, i) => {
    declarations.push(`uniform vec4 transform${i}, style${i}, detail${i}; uniform vec3 color${i};`);
    let shape = '';
    switch (layer.type) {
      case 'circle': shape = 'a=1.-smoothstep(size-soft,size+soft,length(p));'; break;
      case 'ring': shape = 'a=1.-smoothstep(thick,thick+soft,abs(length(p)-size));'; break;
      case 'star': shape = `float r=size*(.65+.35*cos(atan(p.y,p.x)*${Math.max(3, layer.count)}.)); a=1.-smoothstep(thick,thick+soft,abs(length(p)-r));`; break;
      case 'waves': shape = `float d=abs(p.y-sin(p.x*${layer.count}.+uTime*speed)*size); a=1.-smoothstep(thick,thick+soft,d);`; break;
      case 'grid': shape = `vec2 g=abs(fract(p/max(size,.001)+vec2(0.,uTime*speed))-.5)*size; a=1.-smoothstep(thick,thick+soft,min(g.x,g.y));`; break;
      case 'polygon': shape = `float n=${Math.max(3, layer.count)}.; float polar=atan(p.y,p.x); float sector=2.*PI/n; float d=cos(floor(.5+polar/sector)*sector-polar)*length(p); a=1.-smoothstep(thick,thick+soft,abs(d-size));`; break;
      case 'particles': shape = `
        for(int j=0;j<${layer.count};j++) {
          float seed=float(j)+1.;
          vec2 point=vec2(hash(seed)*2.-1.,fract(hash(seed+91.)+uTime*speed*(.3+hash(seed+12.)))*2.-1.);
          point.x+=sin(uTime*speed+seed)*.08;
          float d=length(p-point);
          a+=exp(-d*d/max(size*size,.000001))*(.5+.5*sin(seed+uTime*speed));
        } a=clamp(a,0.,1.);`; break;
    }
    const blend = layer.blend === 'normal' ? 'c=ink*a+c*(1.-a);' : layer.blend === 'screen' ? 'c=1.-(1.-c)*(1.-ink*a);' : 'c+=ink*a;';
    operations.push(`{
      vec2 p=(uv-transform${i}.xy)*vec2(uResolution.x/max(1.,uResolution.y),1.);
      float angle=detail${i}.x*PI/180.; p=mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*p/transform${i}.zw;
      float size=style${i}.x, thick=style${i}.y, soft=style${i}.z, speed=detail${i}.y, a=0.;
      ${shape}
      a=clamp(a*style${i}.w,0.,1.); vec3 ink=color${i}; ${blend} alpha=a+alpha*(1.-a);
    }`);
  });
  // Compose in premultiplied space, return straight alpha to Three's normal blend.
  return `${declarations.join('\n')}\nvec4 effect(vec2 uv){vec3 c=vec3(0.);float alpha=0.;${operations.join('\n')}return vec4(c/max(alpha,.0001),alpha);}`;
}
export function effectFragmentShader(effect: CustomEffect, raw = false): string {
  return `${header}\n${effect.shader ?? layerShader(effect)}
void main(){
  vec4 result=effect(vUv);
  gl_FragColor=vec4(max(result.rgb,vec3(0.)),clamp(result.a,0.,1.)*uOpacity);
  ${raw ? '' : '#include <tonemapping_fragment>\n#include <colorspace_fragment>'}
}`;
}
function materialFor(effect: CustomEffect, raw = false): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 }, uProgress: { value: 0 }, uOpacity: { value: 1 }, uSongTime: { value: 0 }, uResolution: { value: new THREE.Vector2(1, 1) },
    uBands: { value: new THREE.Vector3() }, uAmplitude: { value: 0 }, uOnset: { value: 0 },
    uPrimary: { value: new THREE.Color() }, uAccent: { value: new THREE.Color() }, uThird: { value: new THREE.Color() },
  };
  effect.layers?.forEach((_, i) => {
    for (const prefix of ['transform', 'style', 'detail']) uniforms[`${prefix}${i}`] = { value: new THREE.Vector4() };
    uniforms[`color${i}`] = { value: new THREE.Color() };
  });
  return new THREE.ShaderMaterial({ name: `Custom effect: ${effect.id}`, vertexShader, fragmentShader: effectFragmentShader(effect, raw), uniforms, transparent: !raw, blending: raw ? THREE.NoBlending : THREE.NormalBlending, depthTest: false, depthWrite: false });
}

/** Separate programs let shaders reuse helper names. Blend linear premultiplied colors once. */
class TimelineRenderer {
  readonly material: THREE.ShaderMaterial;
  private programs = new Map<string, THREE.ShaderMaterial>();
  private targets = [new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType }), new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType })];
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private mesh: THREE.Mesh;
  constructor(private timeline: ShaderTimeline, effect: CustomEffect, geometry: THREE.PlaneGeometry) {
    for (const shader of timeline.shaders) this.programs.set(shader.id, materialFor({ ...effect, shader: shader.shader, timeline: undefined }, true));
    this.material = materialFor({ ...effect, timeline: undefined, shader: `
      uniform sampler2D uFrom, uTo;
      uniform vec2 uWeights;
      vec4 effect(vec2 uv) {
        vec4 a=texture2D(uFrom,uv), b=texture2D(uTo,uv);
        float alpha=a.a*uWeights.x+b.a*uWeights.y;
        vec3 color=a.rgb*a.a*uWeights.x+b.rgb*b.a*uWeights.y;
        return vec4(color/max(alpha,.00001),alpha);
      }` });
    Object.assign(this.material.uniforms, { uFrom: { value: this.targets[0].texture }, uTo: { value: this.targets[1].texture }, uWeights: { value: new THREE.Vector2() } });
    this.mesh = new THREE.Mesh(geometry); this.mesh.frustumCulled = false; this.scene.add(this.mesh);
  }
  render(renderer: THREE.WebGLRenderer, time: number, transitions: boolean): void {
    const samples = evaluateTimeline(this.timeline, time, transitions), u = this.material.uniforms;
    u.uWeights.value.set(samples[0]?.weight ?? 0, samples[1]?.weight ?? 0);
    if (!samples.length) return;
    const target = renderer.getRenderTarget(), viewport = renderer.getViewport(new THREE.Vector4());
    const scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
    try {
      renderer.setScissorTest(false);
      samples.forEach((sample, index) => {
        const program = this.programs.get(sample.cue.shader)!, buffer = this.targets[index];
        // Copy shared inputs; each cue has its own local time and one-shot progress.
        for (const key of Object.keys(u)) if (program.uniforms[key] && !['uTime', 'uProgress', 'uOpacity', 'uSongTime'].includes(key)) program.uniforms[key].value = u[key].value;
        program.uniforms.uTime.value = sample.time; program.uniforms.uSongTime.value = time;
        program.uniforms.uProgress.value = Math.min(1, sample.time / (sample.cue.end - sample.cue.begin));
        program.uniforms.uOpacity.value = 1;
        buffer.setSize(u.uResolution.value.x, u.uResolution.value.y);
        this.mesh.material = program;
        renderer.setRenderTarget(buffer); renderer.render(this.scene, this.camera);
      });
    } finally {
      renderer.setRenderTarget(target); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
    }
  }
  dispose(): void { this.programs.forEach(program => program.dispose()); this.targets.forEach(target => target.dispose()); this.scene.clear(); }
}

/** Uses the wallpaper's context. At most two output compositions crossfade. */
export class CustomEffectRenderer {
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private geometry = new THREE.PlaneGeometry(2, 2);
  private entries: { effect: CustomEffect; material: THREE.ShaderMaterial; mesh: THREE.Mesh; time: number; elapsed: number; timelineTime: number; opacity: number; timeline?: TimelineRenderer }[] = [];
  private selected: CustomEffect | null = null;
  private audio: EffectAudio = { bass: 0, mid: 0, treble: 0, amplitude: 0, onset: 0 };

  validate(renderer: THREE.WebGLRenderer, effects: readonly CustomEffect[]): void {
    if (renderer.getContext().isContextLost()) throw new Error('Graphics context is unavailable; try importing again after it recovers.');
    const previous = renderer.debug.onShaderError, check = renderer.debug.checkShaderErrors;
    let error = '';
    renderer.debug.checkShaderErrors = true;
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
      error = [gl.getShaderInfoLog(fragment), gl.getShaderInfoLog(vertex), gl.getProgramInfoLog(program)].filter(Boolean).join('\n').slice(0, 2000) || 'The graphics driver rejected this shader.';
    };
    try {
      for (const effect of effects.flatMap(effect => effect.timeline ? effect.timeline.shaders.map(shader => ({ ...effect, timeline: undefined, shader: shader.shader, name: `${effect.name} / ${shader.id}` })) : [effect])) {
        const material = materialFor(effect), scene = new THREE.Scene();
        const mesh = new THREE.Mesh(this.geometry, material); mesh.frustumCulled = false; scene.add(mesh);
        try {
          renderer.compile(scene, this.camera);
          // Three defers link diagnostics until first uniform use, even after compile().
          const properties = renderer.properties.get(material) as { currentProgram: { getUniforms(): unknown } };
          properties.currentProgram.getUniforms();
          if (error) throw new Error(`${effect.name}: shader could not compile. ${error}`);
        } finally { material.dispose(); scene.clear(); }
      }
    } finally { renderer.debug.onShaderError = previous; renderer.debug.checkShaderErrors = check; }
  }

  restart(): void { for (const entry of this.entries) entry.time = entry.elapsed = entry.timelineTime = 0; }

  render(renderer: THREE.WebGLRenderer, effect: CustomEffect | null, dt: number, config: Config, audio: AudioEngine, reduced: boolean, lyrics: boolean, palette: readonly string[], powered: boolean, playbackTime: number | null = null): void {
    if (!powered) effect = null;
    if (effect !== this.selected) {
      this.selected = effect;
      // Drop the oldest fading quad when a new selection interrupts a transition.
      while (this.entries.length > 1) this.remove(this.entries[0]);
      if (effect) {
        const timeline = effect.timeline ? new TimelineRenderer(effect.timeline, effect, this.geometry) : undefined;
        const material = timeline?.material ?? materialFor(effect), mesh = new THREE.Mesh(this.geometry, material);
        mesh.frustumCulled = false; this.scene.add(mesh);
        this.entries.push({ effect, material, mesh, time: 0, elapsed: 0, timelineTime: 0, opacity: 0, timeline });
      }
    }
    const moving = config.backgroundAnimation && !reduced && powered;
    const strength = moving ? config.reactivity : 0;
    this.audio.bass = audio.bass * strength; this.audio.mid = audio.mid * strength; this.audio.treble = audio.treble * strength;
    this.audio.amplitude = audio.amplitude * strength; this.audio.onset = audio.transient * strength;
    const step = reduced || !config.backgroundAnimation ? 1 : dt / config.transitionDuration;
    for (const entry of [...this.entries]) {
      const target = entry.effect === effect && powered ? 1 : 0;
      entry.opacity = THREE.MathUtils.clamp(entry.opacity + (target ? step : -step), 0, 1);
      if (!target && entry.opacity === 0) { this.remove(entry); continue; }
      if (moving) {
        entry.time += dt * config.backgroundIntensity; entry.elapsed += dt;
        entry.timelineTime = entry.effect.timeline?.clock === 'playback' ? playbackTime ?? entry.elapsed : entry.elapsed;
      }
      const u = entry.material.uniforms;
      u.uTime.value = entry.time; u.uProgress.value = entry.time % entry.effect.duration / entry.effect.duration;
      u.uSongTime.value = entry.timeline ? entry.timelineTime : entry.time;
      u.uOpacity.value = entry.opacity * config.backgroundBrightness * (lyrics ? .45 : 1);
      renderer.getDrawingBufferSize(u.uResolution.value);
      u.uBands.value.set(this.audio.bass, this.audio.mid, this.audio.treble); u.uAmplitude.value = this.audio.amplitude; u.uOnset.value = this.audio.onset;
      u.uPrimary.value.set(palette[0] || '#66583f'); u.uAccent.value.set(palette[1] || '#31473c'); u.uThird.value.set(palette[2] || '#adc499');
      entry.effect.layers?.forEach((layer, i) => {
        const value = (key: LayerParameter) => evaluateSignal(layer[key], entry.time, this.audio, layerParameters[key][1], layerParameters[key][2]);
        u[`transform${i}`].value.set(value('x'), value('y'), value('scaleX'), value('scaleY'));
        u[`style${i}`].value.set(value('size'), value('thickness'), value('softness'), value('opacity'));
        u[`detail${i}`].value.set(value('rotation'), value('speed'), 0, 0);
        const color = layer.color === 'primary' ? palette[0] : layer.color === 'accent' ? palette[1] : layer.color === 'third' ? palette[2] : layer.color;
        u[`color${i}`].value.set(color || '#ffffff');
      });
      entry.timeline?.render(renderer, entry.timelineTime, !reduced && config.backgroundAnimation);
    }
    if (this.entries.length) renderer.render(this.scene, this.camera);
  }
  private remove(entry: typeof this.entries[number]): void {
    this.scene.remove(entry.mesh); entry.timeline?.dispose(); entry.material.dispose(); this.entries.splice(this.entries.indexOf(entry), 1);
  }
  dispose(): void { for (const entry of [...this.entries]) this.remove(entry); this.geometry.dispose(); this.scene.clear(); }
}
