import type { SongAccent } from '../background/SongAccents';
import { BackgroundEngine } from '../background/BackgroundEngine';
import { CustomEffectRenderer } from '../background/CustomEffectRenderer';
import type { CustomEffect } from '../background/CustomEffects';
import { performancePresets } from '../background/Performance';
import type { ThemeId } from '../background/Themes';
import * as THREE from 'three';
import type { Config } from '../core/Config';
import type { AudioEngine } from '../audio/AudioEngine';
import type { ScreenPainter } from '../ui/ScreenPainter';
import { Television } from './Television';

export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
  readonly tv: Television;
  private light = new THREE.PointLight(0x9eb895, 20, 12, 2);
  readonly background = new BackgroundEngine();
  readonly customEffects = new CustomEffectRenderer();
  customEffect: CustomEffect | null = null;
  effectPlaybackTime: number | null = null;
  theme: ThemeId = 'synthwave';
  songAccent: SongAccent | null = null;
  private viewport: HTMLElement;
  private tvViewport = new THREE.Vector4();
  private lastLyrics = false;
  private floorGroup = new THREE.Group();
  private pointer = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  private drag: { x: number; y: number; rotation: number; moved: boolean } | null = null;
  private desiredRotation = -0.09;
  private resizeTimer = 0;
  private removers: (() => void)[] = [];
  private quality = 2;
  private frames = 0;
  private slowFrames = 0;
  private motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  interactionEnabled = true;
  contextLost = false;
  lyricsVisible = false;
  onAction: (action: string) => void = () => {};
  constructor(private container: HTMLElement, painter: ScreenPainter) {
    this.viewport = container.querySelector<HTMLElement>('.tv-viewport') || document.createElement('div');
    if (!this.viewport.parentElement) { this.viewport.className = 'tv-viewport'; container.append(this.viewport); }
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setClearColor(0x101512, 0);
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.35;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D vintage television. Drag to rotate.');
    this.container.append(this.renderer.domElement);
    this.tv = new Television(painter); this.scene.add(this.tv.group);
    this.scene.add(new THREE.HemisphereLight(0xd6e0c7, 0x29251e, 2.6));
    const key = new THREE.DirectionalLight(0xffe0b4, 4.2); key.position.set(-5, 8, 6); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -8; key.shadow.camera.right = 8;
    key.shadow.camera.top = 8; key.shadow.camera.bottom = -8; key.shadow.camera.near = 0.5; key.shadow.camera.far = 30; key.shadow.bias = -0.00015; key.shadow.normalBias = 0.04; key.shadow.radius = 4; this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x789b9a, 3.1); rim.position.set(5, 4, -4); this.scene.add(rim);
    this.light.position.set(-0.6, -0.4, 3.2); this.scene.add(this.light);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.ShadowMaterial({ opacity: 0.27 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -2.63; floor.receiveShadow = true; this.floorGroup.add(floor); this.scene.add(this.floorGroup);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d')!; const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(137,170,130,0.10)'); gradient.addColorStop(1, 'rgba(137,170,130,0)'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
    const glowTexture = new THREE.CanvasTexture(canvas);
    const reflection = new THREE.Mesh(new THREE.PlaneGeometry(15, 9), new THREE.MeshBasicMaterial({ map: glowTexture, transparent: true, depthWrite: false })); reflection.rotation.x = -Math.PI / 2; reflection.position.set(0, -2.62, 1); this.floorGroup.add(reflection);
    this.camera.position.set(1.3, 1.2, 15.8); this.camera.lookAt(0, 0.5, 0);
    const listen = <K extends keyof HTMLElementEventMap>(type: K, fn: (event: HTMLElementEventMap[K]) => void) => {
      this.renderer.domElement.addEventListener(type, fn); this.removers.push(() => this.renderer.domElement.removeEventListener(type, fn));
    };
    listen('pointerdown', event => {
      const bounds = this.viewport.getBoundingClientRect();
      if (!this.interactionEnabled || event.button !== 0 || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      this.drag = { x: event.clientX, y: event.clientY, rotation: this.desiredRotation, moved: false }; this.renderer.domElement.setPointerCapture(event.pointerId);
    });
    listen('pointermove', event => {
      if (!this.interactionEnabled) { this.drag = null; this.pointer.set(0, 0); return; }
      const bounds = this.viewport.getBoundingClientRect();
      this.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
      if (this.drag) {
        const delta = event.clientX - this.drag.x; if (Math.hypot(delta, event.clientY - this.drag.y) > 5) this.drag.moved = true;
        this.desiredRotation = THREE.MathUtils.clamp(this.drag.rotation + delta * 0.003, -0.5, 0.5);
      }
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.renderer.domElement.style.cursor = this.drag ? 'grabbing' : this.raycaster.intersectObjects(this.tv.targets).length ? 'pointer' : 'grab';
    });
    listen('pointerup', event => {
      if (this.interactionEnabled && this.drag && !this.drag.moved) {
        const bounds = this.viewport.getBoundingClientRect();
        this.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hit = this.raycaster.intersectObjects(this.tv.targets)[0]; if (hit) this.onAction(String(hit.object.userData.action));
      }
      this.drag = null;
      if (this.renderer.domElement.hasPointerCapture(event.pointerId)) this.renderer.domElement.releasePointerCapture(event.pointerId);
    });
    listen('pointercancel', () => { this.drag = null; });
    listen('pointerleave', () => { this.pointer.set(0, 0); });
    const lost = (event: Event) => { event.preventDefault(); this.contextLost = true; };
    const restored = () => { this.contextLost = false; painter.texture.needsUpdate = true; this.resize(); };
    this.renderer.domElement.addEventListener('webglcontextlost', lost);
    this.renderer.domElement.addEventListener('webglcontextrestored', restored);
    this.removers.push(() => { this.renderer.domElement.removeEventListener('webglcontextlost', lost); this.renderer.domElement.removeEventListener('webglcontextrestored', restored); });
    const resize = () => { clearTimeout(this.resizeTimer); this.resizeTimer = window.setTimeout(() => this.resize(), 100); };
    window.addEventListener('resize', resize); this.removers.push(() => window.removeEventListener('resize', resize)); this.resize();
    const containerResize = new ResizeObserver(() => this.resize());
    containerResize.observe(this.container); containerResize.observe(this.viewport); this.removers.push(() => containerResize.disconnect());
  }
  resize(): void {
    const width = this.container.clientWidth; const height = this.container.clientHeight;
    const bounds = this.container.getBoundingClientRect(), tv = this.viewport.getBoundingClientRect();
    this.tvViewport.set(tv.left - bounds.left, bounds.bottom - tv.bottom, tv.width, Math.max(tv.height, 1));
    this.renderer.setSize(width, height); this.camera.aspect = tv.width / Math.max(tv.height, 1);
    this.camera.fov = this.camera.aspect < 1.1 ? 46 : 34;
    this.camera.updateProjectionMatrix();
  }
  render(time: number, dt: number, config: Config, audio: AudioEngine, painter: ScreenPainter, powered: boolean): void {
    const start = performance.now();
    if (this.lastLyrics !== this.lyricsVisible) { this.lastLyrics = this.lyricsVisible; this.resize(); }
    const reducedMotion = this.motionPreference.matches || config.reducedMotion;
    this.tv.updateDial(dt, reducedMotion || config.lowPower);
    this.tv.group.rotation.y = THREE.MathUtils.damp(this.tv.group.rotation.y, this.desiredRotation, 7, dt);
    const motion = config.lowPower || reducedMotion ? 0 : 1;
    const narrow = this.camera.aspect < 0.7;
    const distance = narrow ? 21 : 15.8;
    this.camera.position.z = THREE.MathUtils.damp(this.camera.position.z, distance, reducedMotion ? 100 : 2.1, dt);
    this.tv.group.position.y = THREE.MathUtils.damp(this.tv.group.position.y, 0, reducedMotion ? 100 : 2.1, dt);
    this.floorGroup.position.y = this.tv.group.position.y;
    this.tv.syncPalette(painter.palette, dt, config.casing);
    this.camera.position.x = THREE.MathUtils.damp(this.camera.position.x, 1.3 + this.pointer.x * 0.22 * motion, 3, dt);
    this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, 1.2 + this.pointer.y * 0.13 * motion + audio.bass * 0.018 * config.intensity * motion, 3, dt); this.camera.lookAt(0, 0.5, 0);
    const u = this.tv.shader.uniforms; u.time.value = time; u.bass.value = powered && !reducedMotion ? audio.bass * config.intensity : 0; u.treble.value = reducedMotion ? 0 : audio.treble * config.intensity;
    u.tuning.value = powered && config.interference ? Math.max(0, 1 - (time - painter.transition) / 0.65) : 0;
    this.light.color.set(painter.palette[0]); this.light.intensity = powered && config.glow ? 12 + audio.bass * 16 * config.intensity * motion : 0;
    // Lower fill cost under the settings blur without dropping animation frames.
    const ratio = Math.min(window.devicePixelRatio, performancePresets[config.performancePreset].pixelRatio, config.lowPower || !this.interactionEnabled ? 1 : this.quality);
    if (this.renderer.getPixelRatio() !== ratio) this.renderer.setPixelRatio(ratio);
    this.renderer.setViewport(0, 0, this.container.clientWidth, this.container.clientHeight);
    this.renderer.clear(true, true, true);
    this.background.render(this.renderer, dt, config, audio, this.theme, reducedMotion, this.lyricsVisible, painter.palette, powered, this.songAccent, !!this.customEffect?.replace);
    this.customEffects.render(this.renderer, this.customEffect, dt, config, audio, reducedMotion, this.lyricsVisible, painter.palette, powered, this.effectPlaybackTime);
    this.renderer.clearDepth();
    this.renderer.setViewport(this.tvViewport);
    this.renderer.render(this.scene, this.camera);
    if (performance.now() - start > 20) this.slowFrames++;
    if (++this.frames >= 180) { if (this.slowFrames > 45) this.quality = Math.max(0.8, this.quality - 0.2); this.frames = this.slowFrames = 0; }
  }
  dispose(): void {
    clearTimeout(this.resizeTimer); this.removers.forEach(fn => fn()); this.background.dispose(); this.customEffects.dispose(); this.tv.dispose();
    this.scene.traverse(obj => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
        obj.geometry.dispose(); const ms = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of ms) { if ('map' in m && m.map instanceof THREE.Texture) m.map.dispose(); m.dispose(); }
      }
    });
    this.renderer.dispose(); this.renderer.domElement.remove(); this.viewport.remove();
  }
}
