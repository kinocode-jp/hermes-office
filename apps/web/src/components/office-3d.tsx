/**
 * Three.js isometric 3D office scene.
 * Renders the same OfficeWorld data as a 3D scene with:
 * - Isometric orthographic camera
 * - 3D floor, walls, furniture, desks with monitors
 * - Character billboards (sprites) with status indicators
 * - Ambient + directional lighting with soft shadows
 * - Hover/click raycasting for profile selection
 * - Subtle idle animations (character bob, monitor flicker)
 */
import { useEffect, useRef, useCallback } from "preact/hooks";
import { signal } from "@preact/signals";
import type { Sprite as ThreeSprite, Group as ThreeGroup } from "three";
import type { Profile } from "../domain";
import { t } from "../i18n";
import { avatarForProfile } from "../avatar-preferences";
import { KanbanBoard } from "./kanban-board";
import {
  CELL,
  createCharacters,
  tickCharacters,
  type OfficeWorld,
  type SimCharacter,
  type OfficeObject,
  type DeskSlot,
} from "../office/sim";
import { profileDisplayName } from "../profile-names";

/* ── Constants ─────────────────────────────────────────────────── */
const UNIT = 1; // 1 cell = 1 three.js unit
const WALL_H = 1.8;
const DESK_H = 0.7;
const MONITOR_H = 0.35;
const CHAR_H = 1.2;
const PLANT_H = 0.6;
const SHELF_H = 0.9;
const SOFA_H = 0.35;
const TABLE_H = 0.38;
const COFFEE_H = 0.5;

const kanbanOverlayOpen = signal(false);

/* ── Helpers ──────────────────────────────────────────────────── */
function cellTo3D(cx: number, cy: number): [number, number, number] {
  return [cx * UNIT, 0, cy * UNIT];
}

function hexToThreeColor(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

/* ── Component ─────────────────────────────────────────────────── */
export function Office3D({
  profiles,
  world,
  onProfileActivate,
}: {
  profiles: Profile[];
  world: OfficeWorld;
  onProfileActivate: (event: MouseEvent, profileId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const threeRef = useRef<{
    dispose: () => void;
    updateProfiles: (p: Profile[]) => void;
  } | null>(null);

  const activateRef = useRef(onProfileActivate);
  activateRef.current = onProfileActivate;

  useEffect(() => {
    const container = containerRef.current!;
    if (!container) return;
    // Guard against double-mount (Preact strict mode / HMR)
    if (container.querySelector("canvas")) return;

    let disposed = false;
    let THREE: typeof import("three");

    async function init() {
      try {
      THREE = await import("three");
      if (disposed) return;

      const {
        Scene, OrthographicCamera, WebGLRenderer,
        AmbientLight, DirectionalLight, PointLight,
        BoxGeometry, PlaneGeometry, CylinderGeometry, SphereGeometry,
        Mesh, MeshStandardMaterial, MeshPhongMaterial, MeshBasicMaterial,
        SpriteMaterial, Sprite, TextureLoader, CanvasTexture,
        Raycaster, Vector2, Vector3, Group, Color, Fog,
        DoubleSide, FrontSide, PCFSoftShadowMap, SRGBColorSpace,
        LinearFilter, NearestFilter,
      } = THREE;

      /* ── Scene setup ─────────────────────────────────────── */
      const scene = new Scene();
      scene.background = new Color(0x4a6580);
      // fog disabled for visibility

      const w = container.clientWidth || 800;
      const h = container.clientHeight || 600;
      const aspect = w / h;
      const frustum = Math.max(world.cols, world.rows) * 0.45;
      const camera = new OrthographicCamera(
        -frustum * aspect, frustum * aspect,
        frustum, -frustum, 0.1, 100
      );
      // Isometric angle
      const cx = world.cols * 0.5;
      const cz = world.rows * 0.5;
      const defaultCamPos = [cx + 16, 14, cz + 16] as const;
      const defaultTarget = [cx, 0, cz] as const;
      // Restore saved camera state
      let savedCam: { px: number; py: number; pz: number; tx: number; ty: number; tz: number; zoom: number } | null = null;
      try {
        const raw = localStorage.getItem("hermes-studio.camera-state") ?? localStorage.getItem("hermes-office.camera-state");
        if (raw) savedCam = JSON.parse(raw);
      } catch { /* ignore */ }
      if (savedCam) {
        camera.position.set(savedCam.px, savedCam.py, savedCam.pz);
        camera.zoom = savedCam.zoom || 1;
        camera.updateProjectionMatrix();
      } else {
        camera.position.set(...defaultCamPos);
      }
      camera.lookAt(savedCam ? savedCam.tx : defaultTarget[0], savedCam ? savedCam.ty : defaultTarget[1], savedCam ? savedCam.tz : defaultTarget[2]);

      const renderer = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = PCFSoftShadowMap;
      renderer.outputColorSpace = SRGBColorSpace;
      container.appendChild(renderer.domElement);

      /* ── OrbitControls ───────────────────────────────────── */
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(cx, 0, cz);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enableRotate = true;
      controls.enableZoom = true;
      controls.enablePan = true;
      controls.minZoom = 0.3;
      controls.maxZoom = 3.0;
      controls.maxPolarAngle = Math.PI / 2.1;
      controls.mouseButtons = { LEFT: 0, MIDDLE: 1, RIGHT: 2 }; // LEFT=rotate, MIDDLE=dolly, RIGHT=pan
      controls.touches = { ONE: 0, TWO: 2 }; // ONE=rotate, TWO=pan+zoom
      if (savedCam) {
        controls.target.set(savedCam.tx, savedCam.ty, savedCam.tz);
      }
      controls.update();

      // Save camera state on change (throttled)
      let camSaveTimer = 0;
      const saveCamState = () => {
        clearTimeout(camSaveTimer);
        camSaveTimer = window.setTimeout(() => {
          try {
            localStorage.setItem("hermes-studio.camera-state", JSON.stringify({
              px: camera.position.x, py: camera.position.y, pz: camera.position.z,
              tx: controls.target.x, ty: controls.target.y, tz: controls.target.z,
              zoom: camera.zoom,
            }));
          } catch { /* ignore */ }
        }, 500);
      };
      controls.addEventListener("change", saveCamState);

      /* ── Lighting ────────────────────────────────────────── */
      const ambient = new AmbientLight(0xffffff, 2.2);
      scene.add(ambient);

      const sun = new DirectionalLight(0xffffff, 3.0);
      sun.position.set(cx + 10, 22, cz + 6);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -25;
      sun.shadow.camera.right = 25;
      sun.shadow.camera.top = 25;
      sun.shadow.camera.bottom = -25;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 50;
      sun.shadow.bias = -0.001;
      sun.shadow.normalBias = 0.02;
      scene.add(sun);

      const fill = new DirectionalLight(0x99bbee, 1.5);
      fill.position.set(-8, 10, -6);
      scene.add(fill);

      // Warm point lights for ambiance
      const warmLight1 = new PointLight(0xffddaa, 2.0, 35);
      warmLight1.position.set(world.cols * 0.3, 3, world.rows * 0.3);
      scene.add(warmLight1);
      const warmLight2 = new PointLight(0xaaddff, 1.8, 35);
      warmLight2.position.set(world.cols * 0.7, 3, world.rows * 0.7);
      scene.add(warmLight2);

      /* ── Floor ───────────────────────────────────────────── */
      const floorGeo = new PlaneGeometry(world.cols * UNIT, world.rows * UNIT);
      const floorMat = new MeshStandardMaterial({
        color: 0x8aacca,
        roughness: 0.85,
        metalness: 0.05,
      });
      const floor = new Mesh(floorGeo, floorMat);
      if (floor) {
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(world.cols * 0.5, 0, world.rows * 0.5);
        floor.receiveShadow = true;
        scene.add(floor);
      }

      // Floor grid lines
      const gridCanvas = document.createElement("canvas");
      gridCanvas.width = 512;
      gridCanvas.height = 512;
      const gctx = gridCanvas.getContext("2d")!;
      gctx.fillStyle = "#2a3a52";
      gctx.fillRect(0, 0, 512, 512);
      gctx.strokeStyle = "rgba(100,140,180,0.12)";
      gctx.lineWidth = 1;
      const gridStep = 512 / Math.max(world.cols, world.rows);
      for (let i = 0; i <= Math.max(world.cols, world.rows); i++) {
        const p = i * gridStep;
        gctx.beginPath(); gctx.moveTo(p, 0); gctx.lineTo(p, 512); gctx.stroke();
        gctx.beginPath(); gctx.moveTo(0, p); gctx.lineTo(512, p); gctx.stroke();
      }
      const gridTex = new CanvasTexture(gridCanvas);
      gridTex.colorSpace = SRGBColorSpace;
      if (floor) {
        (floor as any).material.map = gridTex;
        (floor as any).material.needsUpdate = true;
      }

      /* ── Walls ───────────────────────────────────────────── */
      const wallMat = new MeshStandardMaterial({ color: 0x95a8be, roughness: 0.5, metalness: 0.1 });
      const wallThickness = 0.15;

      // Back wall (z=0)
      const backWall = new Mesh(
        new BoxGeometry(world.cols * UNIT, WALL_H, wallThickness),
        wallMat
      );
      backWall.position.set(world.cols * 0.5, WALL_H / 2, -wallThickness / 2);
      backWall.castShadow = true;
      backWall.receiveShadow = true;
      scene.add(backWall);

      // Left wall (x=0)
      const leftWall = new Mesh(
        new BoxGeometry(wallThickness, WALL_H, world.rows * UNIT),
        wallMat
      );
      leftWall.position.set(-wallThickness / 2, WALL_H / 2, world.rows * 0.5);
      leftWall.castShadow = true;
      leftWall.receiveShadow = true;
      scene.add(leftWall);

      // Windows on back wall
      const windowMat = new MeshStandardMaterial({
        color: 0xaaddff,
        roughness: 0.1,
        metalness: 0.3,
        transparent: true,
        opacity: 0.35,
      });
      for (let i = 0; i < 4; i++) {
        const wx = 2 + i * (world.cols - 4) / 3.5;
        const win = new Mesh(
          new BoxGeometry(2.5, 1.0, 0.05),
          windowMat
        );
        win.position.set(wx, WALL_H * 0.6, 0.02);
        scene.add(win);
      }

      // Board on back wall — large and prominent
      const boardMat = new MeshStandardMaterial({ color: 0xffbb44, roughness: 0.4, emissive: 0x664400, emissiveIntensity: 0.4 });
      const boardMesh = new Mesh(
        new BoxGeometry(world.board.w * UNIT * 1.0, 1.2, 0.12),
        boardMat
      );
      boardMesh.position.set((world.board.x + world.board.w / 2) * UNIT, WALL_H * 0.5, 0.08);
      boardMesh.userData = { isBoard: true };
      scene.add(boardMesh);

      // Board border frame
      const frameMat = new MeshStandardMaterial({ color: 0x886633, roughness: 0.5 });
      const bw = world.board.w * UNIT * 1.0;
      const bh = 1.2;
      const bx = (world.board.x + world.board.w / 2) * UNIT;
      const by = WALL_H * 0.5;
      // top/bottom frame
      for (const fy of [by + bh/2 + 0.04, by - bh/2 - 0.04]) {
        const fb = new Mesh(new BoxGeometry(bw + 0.15, 0.08, 0.14), frameMat);
        fb.position.set(bx, fy, 0.08);
        scene.add(fb);
      }
      // left/right frame
      for (const fx of [bx - bw/2 - 0.04, bx + bw/2 + 0.04]) {
        const fb = new Mesh(new BoxGeometry(0.08, bh + 0.15, 0.14), frameMat);
        fb.position.set(fx, by, 0.08);
        scene.add(fb);
      }

      // "タスク" text sprite on board
      const boardLabelCanvas = document.createElement("canvas");
      boardLabelCanvas.width = 256;
      boardLabelCanvas.height = 64;
      const blctx = boardLabelCanvas.getContext("2d")!;
      blctx.clearRect(0, 0, 256, 64);
      blctx.fillStyle = "#1a1000";
      blctx.font = "bold 36px system-ui, sans-serif";
      blctx.textAlign = "center";
      blctx.textBaseline = "middle";
      blctx.fillText("タスク", 128, 32);
      const boardLabelTex = new CanvasTexture(boardLabelCanvas);
      boardLabelTex.colorSpace = SRGBColorSpace;
      const boardLabelMat = new SpriteMaterial({ map: boardLabelTex, transparent: true, depthTest: false });
      const boardLabel = new Sprite(boardLabelMat);
      boardLabel.scale.set(2.5, 0.6, 1);
      boardLabel.position.set(bx, by, 0.2);
      boardLabel.center.set(0.5, 0.5);
      scene.add(boardLabel);

      // Pulsing glow light on board
      const boardGlow = new PointLight(0xffaa33, 1.0, 6);
      boardGlow.position.set(bx, by, 1.5);
      scene.add(boardGlow);

      /* ── Furniture builder ───────────────────────────────── */


      function addBox(x: number, z: number, w: number, d: number, h: number, color: number, yOff = 0) {
        const geo = new BoxGeometry(w, h, d);
        const mat = new MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 });
        const mesh = new Mesh(geo, mat);
        mesh.position.set(x + w / 2, h / 2 + yOff, z + d / 2);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        return mesh;
      }

      let deskIndexCounter = 0;
      function addDesk(desk: DeskSlot, agentColor: string, isReception = false) {
        const [dx, , dz] = cellTo3D(desk.x, desk.y);
        const deskColor = isReception ? 0xddcc88 : 0xb0a080;
        // Desk surface
        addBox(dx, dz, 2 * UNIT, 1 * UNIT, DESK_H, deskColor);
        if (isReception) {
          // Reception sign sprite
          const signCanvas = document.createElement("canvas");
          signCanvas.width = 256;
          signCanvas.height = 64;
          const sctx = signCanvas.getContext("2d")!;
          sctx.clearRect(0, 0, 256, 64);
          sctx.fillStyle = "rgba(255,220,100,0.9)";
          sctx.beginPath();
          if (sctx.roundRect) sctx.roundRect(8, 8, 240, 48, 8);
          else sctx.fillRect(8, 8, 240, 48);
          sctx.fill();
          sctx.fillStyle = "#1a1000";
          sctx.font = "bold 28px system-ui, sans-serif";
          sctx.textAlign = "center";
          sctx.textBaseline = "middle";
          sctx.fillText("受付", 128, 32);
          const signTex = new CanvasTexture(signCanvas);
          signTex.colorSpace = SRGBColorSpace;
          const signMat = new SpriteMaterial({ map: signTex, transparent: true, depthTest: false });
          const sign = new Sprite(signMat);
          sign.scale.set(1.8, 0.45, 1);
          sign.position.set(dx + 1, DESK_H + 0.8, dz + 0.5);
          sign.center.set(0.5, 0.5);
          scene.add(sign);
          // Reception spotlight
          const spotLight = new PointLight(0xffdd88, 1.5, 5);
          spotLight.position.set(dx + 1, 2.5, dz + 0.5);
          scene.add(spotLight);
        }
        // Desk legs
        const legColor = 0x6a6a6a;
        addBox(dx + 0.1, dz + 0.1, 0.08, 0.08, DESK_H, legColor);
        addBox(dx + 1.8, dz + 0.1, 0.08, 0.08, DESK_H, legColor);
        addBox(dx + 0.1, dz + 0.8, 0.08, 0.08, DESK_H, legColor);
        addBox(dx + 1.8, dz + 0.8, 0.08, 0.08, DESK_H, legColor);
        // Monitor
        const monColor = hexToThreeColor(agentColor);
        const monitor = addBox(dx + 1.3, dz + 0.1, 0.5, 0.06, MONITOR_H, 0x333344, DESK_H);
        // Screen glow
        const screenMat = new MeshStandardMaterial({
          color: monColor,
          emissive: monColor,
          emissiveIntensity: 1.5,
          roughness: 0.2,
        });
        const screen = new Mesh(new BoxGeometry(0.44, 0.28, 0.02), screenMat);
        screen.position.set(dx + 1.55, DESK_H + MONITOR_H * 0.5, dz + 0.14);
        scene.add(screen);
        // Monitor stand
        addBox(dx + 1.45, dz + 0.15, 0.1, 0.15, 0.08, 0x444455, DESK_H);
      }

      function addObject3D(obj: OfficeObject) {
        const [ox, , oz] = cellTo3D(obj.x, obj.y);
        const ow = obj.w * UNIT;
        const od = obj.h * UNIT;

        switch (obj.type) {
          case "meeting": {
            addBox(ox, oz, ow, od, TABLE_H, 0xc0a070);
            // Chairs around
            const chairMat = 0x777788;
            for (let ci = 0; ci < obj.w; ci++) {
              addBox(ox + ci + 0.2, oz - 0.4, 0.5, 0.4, 0.3, chairMat);
              addBox(ox + ci + 0.2, oz + od, 0.5, 0.4, 0.3, chairMat);
            }
            break;
          }
          case "shelf": {
            addBox(ox, oz, ow, od, SHELF_H, 0xa09070);
            // Shelf dividers
            for (let si = 1; si < 3; si++) {
              addBox(ox, oz, ow, 0.05, 0.03, 0x6a5a3a, si * SHELF_H / 3);
            }
            // Books (colored blocks)
            const bookColors = [0xcc4444, 0x44aa88, 0xddaa33, 0x5588cc, 0xcc6699];
            for (let bi = 0; bi < Math.min(ow * 2, 8); bi++) {
              const bc = bookColors[bi % bookColors.length]!;
              addBox(ox + 0.1 + bi * 0.35, oz + 0.1, 0.25, 0.3, 0.2 + Math.random() * 0.15, bc, SHELF_H * 0.35);
            }
            break;
          }
          case "coffee": {
            addBox(ox, oz, ow, od, COFFEE_H, 0x999999);
            // Coffee machine
            addBox(ox + 0.3, oz + 0.1, 0.4, 0.4, 0.35, 0x665544, COFFEE_H);
            break;
          }
          case "sofa": {
            const sofaMat = new MeshStandardMaterial({ color: 0xdd8877, roughness: 0.6 });
            const sofaSeat = new Mesh(new BoxGeometry(ow, SOFA_H, od), sofaMat);
            sofaSeat.position.set(ox + ow / 2, SOFA_H / 2, oz + od / 2);
            sofaSeat.castShadow = true;
            scene.add(sofaSeat);
            // Back rest
            const backRest = new Mesh(new BoxGeometry(ow, 0.3, 0.15), sofaMat);
            backRest.position.set(ox + ow / 2, SOFA_H + 0.15, oz + 0.08);
            backRest.castShadow = true;
            scene.add(backRest);
            break;
          }
          case "plant": {
            // Pot
            const potGeo = new CylinderGeometry(0.2, 0.15, 0.25, 8);
            const potMat = new MeshStandardMaterial({ color: 0xbb8e6c, roughness: 0.8 });
            const pot = new Mesh(potGeo, potMat);
            pot.position.set(ox + 0.5, 0.125, oz + 0.5);
            pot.castShadow = true;
            scene.add(pot);
            // Foliage
            const leafGeo = new SphereGeometry(0.35, 8, 6);
            const leafMat = new MeshStandardMaterial({ color: 0x77ee99, roughness: 0.6 });
            const leaf = new Mesh(leafGeo, leafMat);
            leaf.position.set(ox + 0.5, 0.25 + 0.35, oz + 0.5);
            leaf.scale.set(1, 1.2, 1);
            leaf.castShadow = true;
            scene.add(leaf);
            break;
          }
          case "rug": {
            const rugGeo = new PlaneGeometry(ow, od);
            const rugMat = new MeshStandardMaterial({
              color: 0x77cccc,
              roughness: 0.95,
              transparent: true,
              opacity: 0.5,
            });
            const rug = new Mesh(rugGeo, rugMat);
            rug.rotation.x = -Math.PI / 2;
            rug.position.set(ox + ow / 2, 0.01, oz + od / 2);
            scene.add(rug);
            break;
          }
        }
      }

      /* ── Build world objects ─────────────────────────────── */
      // debug overlay removed
      for (const obj of world.objects) {
        addObject3D(obj);
      }


      /* ── Build desks ─────────────────────────────────────── */
      const profileById = new Map(profiles.map(p => [p.id, p]));
      // Ensure "default" profile is always at desk 0 (reception)
      const orderedIds = (() => {
        const ids = profiles.map(p => p.id);
        const di = ids.indexOf("default");
        if (di > 0) { ids.splice(di, 1); ids.unshift("default"); }
        return ids;
      })();
      for (let di = 0; di < Math.min(world.desks.length, orderedIds.length); di++) {
        const prof = profileById.get(orderedIds[di]!);
        addDesk(world.desks[di]!, prof?.color ?? "#55d6be", orderedIds[di] === "default");
      }


      /* ── Characters as atlas sprites ─────────────────────── */
      const charGroup = new Group();
      scene.add(charGroup);

      // Load character atlas
      const ATLAS_COLS = 9;
      const ATLAS_ROWS = 6;
      const atlasImg = new Image();
      atlasImg.crossOrigin = "anonymous";
      atlasImg.src = "/characters/hermes-studio-character-atlas-v4.webp";
      await new Promise<void>((resolve) => { atlasImg.onload = () => resolve(); atlasImg.onerror = () => resolve(); });

      function makeCharSprite(profile: Profile) {
        const g = new Group();
        const c = hexToThreeColor(profile.color);

        // Extract character cell from atlas onto a canvas
        const avatar = avatarForProfile(profile.id);
        const rowIndex = avatar.kind === "creature" ? avatar.index : 0;
        const cellCanvas = document.createElement("canvas");
        cellCanvas.width = 128;
        cellCanvas.height = 128;
        const cctx = cellCanvas.getContext("2d")!;
        if (atlasImg.complete && atlasImg.naturalWidth > 0) {
          const sw = atlasImg.naturalWidth / ATLAS_COLS;
          const sh = atlasImg.naturalHeight / ATLAS_ROWS;
          cctx.drawImage(atlasImg, 0, rowIndex * sh, sw, sh, 0, 0, 128, 128);
        } else {
          // Fallback: colored circle
          cctx.fillStyle = profile.color;
          cctx.beginPath();
          cctx.arc(64, 50, 30, 0, Math.PI * 2);
          cctx.fill();
          cctx.fillRect(44, 78, 40, 30);
        }
        const charTex = new CanvasTexture(cellCanvas);
        charTex.colorSpace = SRGBColorSpace;
        charTex.minFilter = LinearFilter;
        charTex.magFilter = LinearFilter;
        const charMat = new SpriteMaterial({ map: charTex, transparent: true, depthTest: true, alphaTest: 0.05 });
        const charSprite = new Sprite(charMat);
        charSprite.scale.set(1.0, 1.0, 1);
        charSprite.center.set(0.5, 0);
        charSprite.position.y = 0;
        charSprite.userData = { profileId: profile.id };
        g.add(charSprite);

        // Glow ring on floor
        const ringGeo = new CylinderGeometry(0.4, 0.4, 0.03, 16);
        const ringMat = new MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.4, transparent: true, opacity: 0.5 });
        const ring = new Mesh(ringGeo, ringMat);
        ring.position.y = 0.01;
        g.add(ring);

        // Name label sprite
        const labelCanvas = document.createElement("canvas");
        labelCanvas.width = 256;
        labelCanvas.height = 48;
        const lctx = labelCanvas.getContext("2d")!;
        lctx.clearRect(0, 0, 256, 48);
        const name = profileDisplayName(profile);
        lctx.font = "bold 20px system-ui, sans-serif";
        const tw = lctx.measureText(name).width;
        const lx = (256 - tw - 16) / 2;
        lctx.fillStyle = "rgba(10,16,28,0.8)";
        if (lctx.roundRect) { lctx.beginPath(); lctx.roundRect(lx, 4, tw + 16, 34, 6); lctx.fill(); }
        else { lctx.fillRect(lx, 4, tw + 16, 34); }
        lctx.fillStyle = "#e8e8e8";
        lctx.fillText(name, lx + 8, 28);
        const labelTex = new CanvasTexture(labelCanvas);
        labelTex.colorSpace = SRGBColorSpace;
        labelTex.needsUpdate = true;
        const labelMat = new SpriteMaterial({ map: labelTex, transparent: true, depthTest: false });
        const label = new Sprite(labelMat);
        label.scale.set(1.4, 0.28, 1);
        label.position.y = 1.15;
        label.center.set(0.5, 0);
        g.add(label);

        return { group: g, charSprite, ring, label };
      }

      type CharEntry = { group: ThreeGroup; charSprite: ThreeSprite; ring: any; label: ThreeSprite };
      const charSprites = new Map<string, CharEntry>();
      for (const profile of profiles) {
        const entry = makeCharSprite(profile);
        charGroup.add(entry.group);
        charSprites.set(profile.id, entry);
      }


      /* ── Simulation ──────────────────────────────────────── */
      let simChars = createCharacters(world, profiles.map(p => p.id));
      const statusMap = new Map(profiles.map(p => [p.id, p.status]));

      /* ── Centrifugal force physics ─────────────────────────── */
      // Per-character physics state: offset from home position + velocity
      const charPhysics = new Map<string, { ox: number; oz: number; vx: number; vz: number; tumble: number }>();
      for (const p of profiles) {
        charPhysics.set(p.id, { ox: 0, oz: 0, vx: 0, vz: 0, tumble: 0 });
      }
      let prevAzimuth = Math.atan2(camera.position.x - cx, camera.position.z - cz);
      const CENTRIFUGAL_STRENGTH = 12.0;  // how hard characters get flung
      const SPRING_BACK = 3.0;           // spring constant pulling back to home
      const FRICTION = 4.0;              // velocity damping
      const WORLD_BOUNDARY = 1.5;        // how far outside the world they can go (in cells)

      /* ── Raycaster ───────────────────────────────────────── */
      const raycaster = new Raycaster();
      const mouse = new Vector2(-9, -9);
      let hoveredId: string | null = null;

      function getCharMeshes() {
        return [...charSprites.values()].map(c => c.charSprite);
      }

      function onPointerMove(e: PointerEvent) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      }

      function onPointerDown(e: PointerEvent) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        // Check board click first
        const boardHits = raycaster.intersectObject(boardMesh);
        if (boardHits.length > 0) {
          kanbanOverlayOpen.value = true;
          return;
        }
        const hits = raycaster.intersectObjects(getCharMeshes());
        if (hits.length > 0) {
          const pid = hits[0]!.object.userData.profileId as string;
          if (pid) activateRef.current(e as unknown as MouseEvent, pid);
        }
      }

      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("pointerdown", onPointerDown);

      /* ── Animation loop ──────────────────────────────────── */
      let lastTick = performance.now();
      let frameId = 0;

      function animate() {
        if (disposed) return;
        frameId = requestAnimationFrame(animate);
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastTick) / 1000);
        lastTick = now;

        // Tick simulation
        tickCharacters(world, simChars, statusMap, dt);

        // ── Centrifugal force from camera rotation ──
        const curAzimuth = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
        let dAzimuth = curAzimuth - prevAzimuth;
        // Wrap to [-PI, PI]
        if (dAzimuth > Math.PI) dAzimuth -= 2 * Math.PI;
        if (dAzimuth < -Math.PI) dAzimuth += 2 * Math.PI;
        prevAzimuth = curAzimuth;
        const angularVel = dAzimuth / Math.max(dt, 0.001); // rad/s
        const absOmega = Math.abs(angularVel);
        // Only apply centrifugal force when spinning fast enough
        const centrifugalActive = absOmega > 0.3;

        // Update character positions
        raycaster.setFromCamera(mouse, camera);
        const allCharMeshes = getCharMeshes();
        const hoverHits = raycaster.intersectObjects(allCharMeshes);
        const newHoveredId = hoverHits.length > 0 ? (hoverHits[0]!.object.userData.profileId as string ?? null) : null;

        for (const char of simChars) {
          const entry = charSprites.get(char.id);
          if (!entry) continue;
          const homeX = char.x / CELL;
          const homeZ = char.y / CELL;
          const phys = charPhysics.get(char.id);
          if (!phys) continue;

          if (centrifugalActive) {
            // Direction from rotation center to character (radial outward)
            const rx = homeX + phys.ox - controls.target.x;
            const rz = homeZ + phys.oz - controls.target.z;
            const rDist = Math.sqrt(rx * rx + rz * rz) || 1;
            // Centrifugal acceleration = omega^2 * r, directed outward
            const cForce = angularVel * angularVel * CENTRIFUGAL_STRENGTH;
            // Tangential component (Coriolis-like, perpendicular to radial)
            const tForce = angularVel * 2.0;
            phys.vx += (rx / rDist * cForce + (-rz / rDist) * tForce) * dt;
            phys.vz += (rz / rDist * cForce + (rx / rDist) * tForce) * dt;
            // Tumble effect
            phys.tumble += absOmega * dt * 3;
          }

          // Spring back toward home (0,0 offset)
          phys.vx += -phys.ox * SPRING_BACK * dt;
          phys.vz += -phys.oz * SPRING_BACK * dt;
          // Friction
          const frictionFactor = Math.max(0, 1 - FRICTION * dt);
          phys.vx *= frictionFactor;
          phys.vz *= frictionFactor;
          phys.tumble *= Math.max(0, 1 - 3.0 * dt);
          // Integrate position
          phys.ox += phys.vx * dt;
          phys.oz += phys.vz * dt;
          // Clamp to world bounds
          const maxOff = world.cols * 0.3;
          phys.ox = Math.max(-maxOff, Math.min(maxOff, phys.ox));
          phys.oz = Math.max(-maxOff, Math.min(maxOff, phys.oz));

          const wx = homeX + phys.ox;
          const wz = homeZ + phys.oz;
          const speed = Math.sqrt(phys.vx * phys.vx + phys.vz * phys.vz);
          const bob = char.moving ? Math.sin(now * 0.008) * 0.06 : Math.sin(now * 0.002 + char.x) * 0.02;
          // When flung, characters lift off the ground
          const lift = Math.min(speed * 0.15, 2.0);
          entry.group.position.set(wx, bob + lift, wz);
          // Tumble rotation when airborne
          entry.group.rotation.z = Math.sin(phys.tumble) * Math.min(speed * 0.1, 0.8);
          entry.group.rotation.x = Math.cos(phys.tumble * 0.7) * Math.min(speed * 0.08, 0.5);

          const isHovered = newHoveredId === char.id;
          const targetY = isHovered ? 0.08 : 0;
          entry.group.position.y += targetY + lift * 0.2;
          entry.ring.material.opacity = isHovered ? 0.9 : 0.35;
          entry.ring.material.emissiveIntensity = isHovered ? 0.8 : 0.3;
          // Stretch effect when moving fast
          const stretch = 1 + Math.min(speed * 0.05, 0.4);
          const squash = 1 / Math.sqrt(stretch);
          const ts = isHovered ? 1.15 : 1.0;
          entry.charSprite.scale.set(1.0 * ts * squash, 1.0 * ts * stretch, 1);
        }

        if (newHoveredId !== hoveredId) {
          hoveredId = newHoveredId;
          renderer.domElement.style.cursor = hoveredId ? "pointer" : "default";
        }

        // Subtle light animation
        warmLight1.intensity = 1.2 + Math.sin(now * 0.001) * 0.3;
        warmLight2.intensity = 1.0 + Math.cos(now * 0.0013) * 0.2;
        boardGlow.intensity = 0.8 + Math.sin(now * 0.002) * 0.4;

        controls.update();
        renderer.render(scene, camera);
      }
      animate();

      /* ── Resize ──────────────────────────────────────────── */
      const resizeObs = new ResizeObserver(() => {
        const rw = container!.clientWidth;
        const rh = container!.clientHeight;
        if (rw === 0 || rh === 0) return;
        const a = rw / rh;
        camera.left = -frustum * a;
        camera.right = frustum * a;
        camera.top = frustum;
        camera.bottom = -frustum;
        camera.updateProjectionMatrix();
        renderer.setSize(rw, rh);
      });
      resizeObs.observe(container);

      /* ── Dispose ─────────────────────────────────────────── */
      threeRef.current = {
        dispose() {
          disposed = true;
          cancelAnimationFrame(frameId);
          resizeObs.disconnect();
          renderer.domElement.removeEventListener("pointermove", onPointerMove);
          renderer.domElement.removeEventListener("pointerdown", onPointerDown);
          controls.dispose();
          renderer.dispose();
          if (renderer.domElement.parentElement === container) {
            container!.removeChild(renderer.domElement);
          }
        },
        updateProfiles(newProfiles: Profile[]) {
          statusMap.clear();
          for (const p of newProfiles) statusMap.set(p.id, p.status);
        }
      };
      } catch (err) {
        console.error("[3D] init error:", err);
      }
    }

    void init();

    return () => {
      disposed = true;
      threeRef.current?.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  // Update statuses without full rebuild
  useEffect(() => {
    threeRef.current?.updateProfiles(profiles);
  }, [profiles]);

  return (
    <>
      <div
        ref={containerRef}
        class="office-3d-container"
        aria-label={t("office.board")}
      />
      {kanbanOverlayOpen.value && (
        <div class="office-3d-kanban-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) kanbanOverlayOpen.value = false; }}>
          <div class="office-3d-kanban-header">
            <h2>{t("kanban.title")}</h2>
            <button type="button" class="office-3d-kanban-close" onClick={() => { kanbanOverlayOpen.value = false; }}>×</button>
          </div>
          <div class="office-3d-kanban-body">
            <KanbanBoard />
          </div>
        </div>
      )}
    </>
  );
}
