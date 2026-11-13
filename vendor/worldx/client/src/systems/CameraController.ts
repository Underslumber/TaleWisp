import Phaser from "phaser";
import { EventBus } from "../EventBus";
import type { CharacterSprite } from "../objects/CharacterSprite";

const MIN_ZOOM = 0.12;
const MAX_ZOOM = 3;
const KEY_PAN_SPEED = 14;
const CAMERA_EDGE_PADDING_PX = 160;

export class CameraController {
  private scene: Phaser.Scene;
  private mapWidth: number;
  private mapHeight: number;
  private defaultCenter: { x: number; y: number };
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<string, Phaser.Input.Keyboard.Key>;
  private isDragging = false;

  constructor(
    scene: Phaser.Scene,
    mapWidth: number,
    mapHeight: number,
    initialCenter?: { x: number; y: number }
  ) {
    this.scene = scene;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.defaultCenter = initialCenter ?? { x: mapWidth / 2, y: mapHeight / 2 };

    const cam = scene.cameras.main;
    this.applyViewportConstraints(cam);
    this.applyCoverView(cam);

    this.setupDragPan(cam);
    this.setupScrollZoom(cam);
    this.setupKeyboard();
    this.setupEventBus();
    scene.scale.on("resize", () => {
      this.applyViewportConstraints(this.scene.cameras.main);
      this.emitState();
    });

    this.emitZoom(cam.zoom);
    this.emitState();
  }

  private setupDragPan(cam: Phaser.Cameras.Scene2D.Camera) {
    this.scene.input.on("pointerdown", () => {
      this.isDragging = false;
    });
    this.scene.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown) return;
      const dx = pointer.x - pointer.prevPosition.x;
      const dy = pointer.y - pointer.prevPosition.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.isDragging = true;
      cam.scrollX -= dx / cam.zoom;
      cam.scrollY -= dy / cam.zoom;
      this.applyViewportConstraints(cam);
    });
  }

  private setupScrollZoom(cam: Phaser.Cameras.Scene2D.Camera) {
    this.scene.input.on(
      "wheel",
      (_pointer: Phaser.Input.Pointer, _o: any, _dx: number, dy: number) => {
        const oldZoom = cam.zoom;
        const factor = 1 - dy * 0.0015;
        const newZoom = Phaser.Math.Clamp(oldZoom * factor, MIN_ZOOM, MAX_ZOOM);
        this.zoomKeepingViewCenter(cam, newZoom);
      }
    );
  }

  private setupKeyboard() {
    if (!this.scene.input.keyboard) return;
    this.cursors = this.scene.input.keyboard.addKeys(
      {
        up: Phaser.Input.Keyboard.KeyCodes.UP,
        down: Phaser.Input.Keyboard.KeyCodes.DOWN,
        left: Phaser.Input.Keyboard.KeyCodes.LEFT,
        right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      },
      false,
    ) as Phaser.Types.Input.Keyboard.CursorKeys;
    this.wasd = {
      W: this.scene.input.keyboard.addKey("W", false),
      A: this.scene.input.keyboard.addKey("A", false),
      S: this.scene.input.keyboard.addKey("S", false),
      D: this.scene.input.keyboard.addKey("D", false),
    };
  }

  private setupEventBus() {
    const bus = EventBus.instance;
    bus.on("camera_zoom_in", () => this.zoomBy(1.4));
    bus.on("camera_zoom_out", () => this.zoomBy(0.7));
    bus.on("camera_zoom_fit", () => this.zoomToFit());
    bus.on("camera_zoom_reset", () => this.resetView());
    bus.on("camera_pan_to", (pos: { x: number; y: number }) => {
      this.stopFollowing();
      this.panTo(pos.x, pos.y, 400);
    });
  }

  update() {
    const cam = this.scene.cameras.main;
    this.handleKeyboardPan(cam);
    this.applyViewportConstraints(cam);
    this.emitState();
  }

  private handleKeyboardPan(cam: Phaser.Cameras.Scene2D.Camera) {
    if (!this.cursors) return;
    const speed = KEY_PAN_SPEED / cam.zoom;
    if (this.cursors.left.isDown || this.wasd.A?.isDown) cam.scrollX -= speed;
    if (this.cursors.right.isDown || this.wasd.D?.isDown) cam.scrollX += speed;
    if (this.cursors.up.isDown || this.wasd.W?.isDown) cam.scrollY -= speed;
    if (this.cursors.down.isDown || this.wasd.S?.isDown) cam.scrollY += speed;
  }

  private emitZoom(zoom: number) {
    EventBus.instance.emit("camera_zoom_changed", zoom);
  }

  private emitState() {
    const cam = this.scene.cameras.main;
    const wv = cam.worldView;
    EventBus.instance.emit("camera_state", {
      x: wv.x,
      y: wv.y,
      width: wv.width,
      height: wv.height,
      zoom: cam.zoom,
      mapWidth: this.mapWidth,
      mapHeight: this.mapHeight,
    });
  }

  zoomBy(factor: number) {
    const cam = this.scene.cameras.main;
    const newZoom = Phaser.Math.Clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    this.zoomKeepingViewCenter(cam, newZoom);
  }

  setZoom(zoom: number) {
    const cam = this.scene.cameras.main;
    this.zoomKeepingViewCenter(cam, Phaser.Math.Clamp(zoom, MIN_ZOOM, MAX_ZOOM));
  }

  zoomToFit() {
    const cam = this.scene.cameras.main;
    const zoom = this.getFitZoom(cam);
    cam.setZoom(zoom);
    cam.centerOn(this.defaultCenter.x, this.defaultCenter.y);
    this.applyViewportConstraints(cam);
    this.emitZoom(zoom);
  }

  resetView() {
    const cam = this.scene.cameras.main;
    this.applyCoverView(cam);
  }

  private getFitZoom(cam: Phaser.Cameras.Scene2D.Camera): number {
    const zx = cam.width / this.mapWidth;
    const zy = cam.height / this.mapHeight;
    return Phaser.Math.Clamp(Math.min(zx, zy), MIN_ZOOM, MAX_ZOOM);
  }

  private getCoverZoom(cam: Phaser.Cameras.Scene2D.Camera): number {
    const zx = cam.width / this.mapWidth;
    const zy = cam.height / this.mapHeight;
    return Phaser.Math.Clamp(Math.max(zx, zy), MIN_ZOOM, MAX_ZOOM);
  }

  private applyCoverView(cam: Phaser.Cameras.Scene2D.Camera): void {
    const zoom = this.getCoverZoom(cam);
    cam.setZoom(zoom);
    cam.centerOn(this.defaultCenter.x, this.defaultCenter.y);
    this.applyViewportConstraints(cam);
    this.emitZoom(cam.zoom);
  }

  private zoomKeepingViewCenter(
    cam: Phaser.Cameras.Scene2D.Camera,
    zoom: number,
  ): void {
    const focus = this.getCameraCenter(cam);
    cam.setZoom(zoom);
    cam.centerOn(focus.x, focus.y);
    this.applyViewportConstraints(cam);
    this.emitZoom(cam.zoom);
  }

  private getCameraCenter(cam: Phaser.Cameras.Scene2D.Camera): { x: number; y: number } {
    return {
      x: cam.scrollX + cam.width * cam.originX,
      y: cam.scrollY + cam.height * cam.originY,
    };
  }

  private applyViewportConstraints(cam: Phaser.Cameras.Scene2D.Camera): void {
    const viewWidth = cam.width / Math.max(cam.zoom, 0.0001);
    const viewHeight = cam.height / Math.max(cam.zoom, 0.0001);
    const extraX = Math.max(0, viewWidth - this.mapWidth);
    const extraY = Math.max(0, viewHeight - this.mapHeight);
    const paddingX = Math.min(CAMERA_EDGE_PADDING_PX, Math.max(48, this.mapWidth * 0.08));
    const paddingY = Math.min(CAMERA_EDGE_PADDING_PX, Math.max(48, this.mapHeight * 0.08));

    // When the visible world area is larger than the map, expand bounds symmetrically
    // so Phaser clamps the camera to a centered presentation instead of top-left locking.
    cam.setBounds(
      -extraX / 2 - paddingX,
      -extraY / 2 - paddingY,
      this.mapWidth + extraX + paddingX * 2,
      this.mapHeight + extraY + paddingY * 2,
    );
  }

  followCharacter(sprite: CharacterSprite): void {
    this.scene.cameras.main.startFollow(sprite, true, 0.05, 0.05);
  }

  stopFollowing(): void {
    this.scene.cameras.main.stopFollow();
  }

  panTo(x: number, y: number, duration = 500): void {
    this.scene.cameras.main.pan(x, y, duration);
  }

  destroy() {
    // cleanup if needed
  }
}
