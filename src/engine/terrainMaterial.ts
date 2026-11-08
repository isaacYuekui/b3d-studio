// Terrain texture blending for PBR materials: layer 0 is the material's own texture
// (colour, normal, roughness maps); layers 1 and 2 (path, rock) are blended into the
// colour by per-vertex weights in a "splat" vertex buffer.

import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';

export class TerrainPlugin extends MaterialPluginBase {
  layer1: Texture | null = null;
  layer2: Texture | null = null;
  scales: [number, number] = [0.5, 0.25];
  private on = false;

  constructor(material: PBRMaterial) {
    super(material, 'TerrainLayers', 210, { TERRAIN_LAYERS: false });
  }

  get enabled() {
    return this.on;
  }

  set enabled(v: boolean) {
    if (this.on === v) return;
    this.on = v;
    this.markAllDefinesAsDirty();
    this._enable(v);
  }

  prepareDefines(defines: MaterialDefines) {
    (defines as unknown as Record<string, boolean>).TERRAIN_LAYERS = this.on && !!this.layer1 && !!this.layer2;
  }

  isReadyForSubMesh(): boolean {
    if (!this.on) return true;
    return (!this.layer1 || this.layer1.isReady()) && (!this.layer2 || this.layer2.isReady());
  }

  getClassName() {
    return 'TerrainPlugin';
  }

  getAttributes(attributes: string[]) {
    if (this.on) attributes.push('splat');
  }

  getSamplers(samplers: string[]) {
    samplers.push('terrainL1', 'terrainL2');
  }

  getUniforms() {
    return { ubo: [{ name: 'terrainScales', size: 2, type: 'vec2' }], fragment: '#ifdef TERRAIN_LAYERS\nuniform vec2 terrainScales;\n#endif\n' };
  }

  bindForSubMesh(ubo: UniformBuffer) {
    if (!this.on) return;
    ubo.updateFloat2('terrainScales', this.scales[0], this.scales[1]);
    if (this.layer1) ubo.setTexture('terrainL1', this.layer1);
    if (this.layer2) ubo.setTexture('terrainL2', this.layer2);
  }

  getCustomCode(shaderType: string): Record<string, string> {
    if (shaderType === 'vertex')
      return {
        CUSTOM_VERTEX_DEFINITIONS: '#ifdef TERRAIN_LAYERS\nattribute vec3 splat;\nvarying vec3 vSplat;\nvarying vec2 vTerrUV;\n#endif\n',
        CUSTOM_VERTEX_MAIN_END: '#ifdef TERRAIN_LAYERS\nvSplat = splat;\nvTerrUV = position.xz;\n#endif\n',
      };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: '#ifdef TERRAIN_LAYERS\nvarying vec3 vSplat;\nvarying vec2 vTerrUV;\nuniform sampler2D terrainL1;\nuniform sampler2D terrainL2;\n#endif\n',
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef TERRAIN_LAYERS
{
  vec3 w = max(vSplat, vec3(0.0));
  w /= max(w.x + w.y + w.z, 0.001);
  // The material colour tints the grass layer only.
  vec3 l1 = toLinearSpace(texture2D(terrainL1, vTerrUV * terrainScales.x).rgb);
  vec3 l2 = toLinearSpace(texture2D(terrainL2, vTerrUV * terrainScales.y).rgb);
  surfaceAlbedo = surfaceAlbedo * w.x + l1 * w.y + l2 * w.z;
}
#endif
`,
    };
  }
}
