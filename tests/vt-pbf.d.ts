declare module 'vt-pbf' {
  type TileFeature = {
    readonly id?: number;
    readonly type: number;
    readonly tags: Record<string, string | number | boolean>;
    readonly geometry: number[][][];
  };
  type TileLayer = { readonly features: readonly TileFeature[] };
  const value: {
    fromGeojsonVt(
      layers: Record<string, TileLayer>,
      options?: { readonly extent?: number; readonly version?: number },
    ): Uint8Array;
  };
  export default value;
}
